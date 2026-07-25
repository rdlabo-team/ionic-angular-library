import { DestroyRef, ErrorHandler, inject, Injectable, InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import { BehaviorSubject, Subscription } from 'rxjs';

/** Access level currently granted to the application runtime. */
export type KitAuthAccessMode = 'none' | 'local' | 'remote';

/** Generation lease that becomes stale as soon as a newer access transition starts. */
export interface KitAuthAccessLease {
  /** Whether work owned by this transition may still publish or persist access. */
  isCurrent(): boolean;
}

/**
 * Result of remote reauthentication, split into ordered activation and resume phases.
 *
 * @remarks
 * `activate` installs the remotely authenticated identity without starting transport. The kit then
 * publishes `remote` access and invokes `resume`, which may start pull, outbox replay, and realtime
 * work.
 */
export interface KitRemoteAccessRecovery {
  /**
   * Install the remotely verified identity, checking the lease again immediately before commit.
   *
   * @returns `false` when a newer logout or identity transition superseded this activation.
   */
  activate(lease: KitAuthAccessLease): Promise<boolean>;
  /**
   * Resume remote-only work after access has been published.
   *
   * @param lease - Post-grant lease supplied by the kit. Check it after every await before
   * navigation or other user-visible side effects, because logout or a newer identity transition
   * may supersede this resume while transport work is settling. Optional for source compatibility
   * with callers that manually resumed a recovery result before leases were introduced.
   */
  resume(lease?: KitAuthAccessLease): Promise<void>;
}

/** Recovery-specific authentication configuration consumed by {@link KitAuthRecoveryService}. */
export interface KitAuthRecoveryConfig {
  /** Classifies transport unavailability; HTTP 401/403 are always denied before this callback. */
  isUnavailableError?(error: unknown): boolean;
  /** Optional online-recovery lifecycle used after local-only route access. */
  remoteRecovery?: {
    /**
     * Delay before probing authentication again while local access remains active.
     *
     * @defaultValue 30000
     */
    retryDelayMs?: number;
    availability(): Observable<boolean>;
    reauthenticate(lease: KitAuthAccessLease): Promise<KitRemoteAccessRecovery | false>;
  };
}

/** Internal alias of the application auth config used without a module cycle. */
export const KIT_AUTH_RECOVERY_CONFIG = new InjectionToken<KitAuthRecoveryConfig>('@rdlabo/ionic-angular-kit:auth-recovery');

/** Shared runtime access state consumed by guards, UI, HTTP, and realtime connections. */
@Injectable({ providedIn: 'root' })
export class KitAuthAccessService {
  readonly #mode = new BehaviorSubject<KitAuthAccessMode>('none');
  #revision = 0;

  /** Emits the current access mode and every later transition. */
  readonly mode$: Observable<KitAuthAccessMode> = this.#mode.asObservable();

  /** Current synchronous access mode. */
  get mode(): KitAuthAccessMode {
    return this.#mode.value;
  }

  /**
   * Monotonic runtime revision used to invalidate an in-flight access transition.
   *
   * @internal
   */
  get revision(): number {
    return this.#revision;
  }

  /**
   * Start a transition and invalidate every older asynchronous access decision.
   *
   * @param options - Set `suspendRemote` when the new decision must revoke published remote
   * capabilities immediately while keeping this new lease valid.
   */
  beginTransition(options: { suspendRemote?: boolean } = {}): KitAuthAccessLease {
    this.#revision += 1;
    const revision = this.#revision;
    if (options.suspendRemote && this.#mode.value === 'remote') {
      this.#mode.next('none');
    }
    return { isCurrent: () => this.#revision === revision };
  }

  /** Revoke published capabilities without invalidating the transition that owns `lease`. */
  suspend(lease: KitAuthAccessLease): boolean {
    if (!lease.isCurrent()) return false;
    if (this.#mode.value !== 'none') this.#mode.next('none');
    return true;
  }

  /** Publish a verified local-replica-only session. */
  grantLocal(): void {
    this.#publish('local');
  }

  /**
   * Publish a remotely authenticated session and return the lease that owns that publication.
   *
   * The revision is fixed before synchronous `mode$` subscribers run. A subscriber that starts a
   * newer logout or identity transition therefore makes the returned lease stale.
   */
  grantRemote(): KitAuthAccessLease {
    return this.#publish('remote');
  }

  /** Revoke both local and remote access. */
  clear(): void {
    this.#publish('none');
  }

  #publish(mode: KitAuthAccessMode): KitAuthAccessLease {
    this.#revision += 1;
    const revision = this.#revision;
    this.#mode.next(mode);
    return { isCurrent: () => this.#revision === revision };
  }
}

/** Coordinates single-flight recovery from local-only mode to remote access. */
@Injectable({ providedIn: 'root' })
export class KitAuthRecoveryService {
  readonly #access = inject(KitAuthAccessService);
  readonly #config = inject(KIT_AUTH_RECOVERY_CONFIG);
  readonly #errorHandler = inject(ErrorHandler);
  readonly #destroyRef = inject(DestroyRef);
  #subscription: Subscription | null = null;
  #recovery: Promise<void> | null = null;
  #recoveryRevision: number | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #available = false;
  #retryRequested = false;
  #destroyed = false;

  constructor() {
    this.#destroyRef.onDestroy(() => {
      this.#destroyed = true;
      this.#clearRetry();
      this.#subscription?.unsubscribe();
      this.#subscription = null;
    });
  }

  /** Subscribe to the configured remote-availability stream once. */
  initialize(): void {
    if (this.#destroyed) return;
    const recovery = this.#config.remoteRecovery;
    if (!recovery || this.#subscription) return;
    this.#subscription = new Subscription();
    this.#subscription.add(
      recovery.availability().subscribe({
        next: (available) => {
          this.#available = available;
          if (available && this.#access.mode === 'local') {
            this.#clearRetry();
            void this.recover();
          } else if (this.#access.mode === 'local') {
            this.#scheduleRetry();
          }
        },
        error: (error) => this.#errorHandler.handleError(error),
      }),
    );
    this.#subscription.add(
      this.#access.mode$.subscribe((mode) => {
        if (mode !== 'local') {
          this.#clearRetry();
          return;
        }
        if (this.#available) {
          void this.recover();
        } else {
          this.#scheduleRetry();
        }
      }),
    );
  }

  /** Run one ordered remote recovery attempt, coalescing concurrent triggers. */
  recover(): Promise<void> {
    if (this.#destroyed) return Promise.resolve();
    if (this.#recovery) {
      if (
        this.#access.mode === 'local' &&
        this.#recoveryRevision !== null &&
        this.#access.revision > this.#recoveryRevision
      ) {
        this.#retryRequested = true;
      }
      return this.#recovery;
    }
    const running = this.#runRecovery();
    this.#recoveryRevision = this.#access.revision;
    const promise = running.finally(() => {
      if (this.#recovery !== promise) return;
      this.#recovery = null;
      this.#recoveryRevision = null;
      if (this.#destroyed) return;
      if (!this.#retryRequested) return;
      this.#retryRequested = false;
      if (this.#access.mode !== 'local') return;
      if (this.#available) {
        void this.recover();
      } else {
        this.#scheduleRetry();
      }
    });
    this.#recovery = promise;
    return promise;
  }

  async #runRecovery(): Promise<void> {
    const recovery = this.#config.remoteRecovery;
    if (this.#destroyed || !recovery || this.#access.mode !== 'local') return;
    const lease = this.#access.beginTransition();
    let currentLease = lease;
    const isCurrent = (): boolean => currentLease.isCurrent();
    try {
      const result = await recovery.reauthenticate(lease);
      if (this.#destroyed || !isCurrent() || this.#access.mode !== 'local') return;
      if (result === false) {
        this.#clearRetry();
        this.#access.clear();
        return;
      }
      if (
        !(await result.activate(lease)) ||
        this.#destroyed ||
        !isCurrent() ||
        this.#access.mode !== 'local'
      ) {
        return;
      }
      this.#clearRetry();
      currentLease = this.#access.grantRemote();
      if (!currentLease.isCurrent()) return;
      await result.resume(currentLease);
    } catch (error) {
      if (this.#destroyed || !isCurrent()) return;
      if (isExplicitAuthDenial(error)) {
        this.#clearRetry();
        this.#access.clear();
      } else if (this.#config.isUnavailableError?.(error)) {
        this.#scheduleRetry();
      } else {
        this.#errorHandler.handleError(error);
      }
    }
  }

  #scheduleRetry(): void {
    const recovery = this.#config.remoteRecovery;
    if (this.#destroyed || !recovery || this.#retryTimer || this.#access.mode !== 'local') return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#access.mode === 'local') void this.recover();
    }, this.#retryDelayMs(recovery.retryDelayMs));
  }

  #clearRetry(): void {
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #retryDelayMs(configured: number | undefined): number {
    if (configured === undefined || !Number.isFinite(configured)) return 30_000;
    return Math.max(1_000, configured);
  }
}

/** Returns true for authoritative authentication denials that must never use local fallback. */
export function isExplicitAuthDenial(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
