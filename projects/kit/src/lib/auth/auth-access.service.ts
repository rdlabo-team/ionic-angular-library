import { ErrorHandler, inject, Injectable, InjectionToken } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { BehaviorSubject } from 'rxjs';

/** Access level currently granted to the application runtime. */
export type KitAuthAccessMode = 'none' | 'local' | 'remote';

/**
 * Result of remote reauthentication, split into ordered activation and resume phases.
 *
 * @remarks
 * `activate` installs the remotely authenticated identity without starting transport. The kit then
 * publishes `remote` access and invokes `resume`, which may start pull, outbox replay, and realtime
 * work.
 */
export interface KitRemoteAccessRecovery {
  activate(): Promise<void>;
  resume(): Promise<void>;
}

/** Recovery-specific authentication configuration consumed by {@link KitAuthRecoveryService}. */
export interface KitAuthRecoveryConfig {
  /** Classifies transport unavailability; HTTP 401/403 are always denied before this callback. */
  isUnavailableError?(error: unknown): boolean;
  /** Optional online-recovery lifecycle used after local-only route access. */
  remoteRecovery?: {
    availability(): Observable<boolean>;
    reauthenticate(): Promise<KitRemoteAccessRecovery | false>;
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
    let expectedRevision = this.#access.revision;
    const isCurrent = (): boolean => this.#access.revision === expectedRevision;
    try {
      const result = await recovery.reauthenticate();
      if (!isCurrent() || this.#access.mode !== 'local') return;
      if (result === false) {
        this.#access.clear();
        return;
      }
      await result.activate();
      if (!isCurrent() || this.#access.mode !== 'local') return;
      this.#access.grantRemote();
      expectedRevision = this.#access.revision;
      await result.resume();
    } catch (error) {
      if (isExplicitAuthDenial(error) && isCurrent()) {
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
