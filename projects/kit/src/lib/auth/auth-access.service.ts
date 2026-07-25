import { ErrorHandler, inject, Injectable, InjectionToken } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject } from 'rxjs';

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
  resume(): Promise<void>;
}

/** Recovery-specific authentication configuration consumed by {@link KitAuthRecoveryService}. */
export interface KitAuthRecoveryConfig {
  /** Classifies transport unavailability; HTTP 401/403 are always denied before this callback. */
  isUnavailableError?(error: unknown): boolean;
  /** Optional online-recovery lifecycle used after local-only route access. */
  remoteRecovery?: {
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

  /** Publish a verified local-replica-only session. */
  grantLocal(): void {
    this.#publish('local');
  }

  /** Publish a remotely authenticated session. */
  grantRemote(): void {
    this.#publish('remote');
  }

  /** Revoke both local and remote access. */
  clear(): void {
    this.#publish('none');
  }

  #publish(mode: KitAuthAccessMode): void {
    this.#revision += 1;
    this.#mode.next(mode);
  }
}

/** Coordinates single-flight recovery from local-only mode to remote access. */
@Injectable({ providedIn: 'root' })
export class KitAuthRecoveryService {
  readonly #access = inject(KitAuthAccessService);
  readonly #config = inject(KIT_AUTH_RECOVERY_CONFIG);
  readonly #errorHandler = inject(ErrorHandler);
  #subscription: Subscription | null = null;
  #recovery: Promise<void> | null = null;

  /** Subscribe to the configured remote-availability stream once. */
  initialize(): void {
    const recovery = this.#config.remoteRecovery;
    if (!recovery || this.#subscription) return;
    this.#subscription = recovery.availability().subscribe({
      next: (available) => {
        if (available && this.#access.mode === 'local') void this.recover();
      },
      error: (error) => this.#errorHandler.handleError(error),
    });
  }

  /** Run one ordered remote recovery attempt, coalescing concurrent triggers. */
  recover(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    const promise = this.#runRecovery().finally(() => {
      if (this.#recovery === promise) this.#recovery = null;
    });
    this.#recovery = promise;
    return promise;
  }

  async #runRecovery(): Promise<void> {
    const recovery = this.#config.remoteRecovery;
    if (!recovery || this.#access.mode !== 'local') return;
    const lease = this.#access.beginTransition();
    let expectedRevision = this.#access.revision;
    const isCurrent = (): boolean => this.#access.revision === expectedRevision;
    try {
      const result = await recovery.reauthenticate(lease);
      if (!isCurrent() || this.#access.mode !== 'local') return;
      if (result === false) {
        this.#access.clear();
        return;
      }
      if (!(await result.activate(lease)) || !isCurrent() || this.#access.mode !== 'local') return;
      this.#access.grantRemote();
      expectedRevision = this.#access.revision;
      await result.resume();
    } catch (error) {
      if (!isCurrent()) return;
      if (isExplicitAuthDenial(error)) {
        this.#access.clear();
      } else if (!this.#config.isUnavailableError?.(error)) {
        this.#errorHandler.handleError(error);
      }
    }
  }
}

/** Returns true for authoritative authentication denials that must never use local fallback. */
export function isExplicitAuthDenial(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
