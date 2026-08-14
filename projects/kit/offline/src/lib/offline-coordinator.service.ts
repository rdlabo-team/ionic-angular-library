import { computed, inject, Injectable, signal } from '@angular/core';
import type { OfflinePrincipalId } from './offline-identity';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineMutationPersistenceService } from './offline-mutation-persistence.service';
import { OFFLINE_REPOSITORY } from './offline-repository';
import { OfflineSessionService } from './offline-session.service';
import type { OfflineSessionManifest, OfflineSessionTransitionLease } from './offline-session.service';
import { OfflineStorageUnavailableError, type OfflineStorageState } from './offline-storage';
import { OfflineSyncService } from './offline-sync.service';

/** User choice when logout encounters unconfirmed local mutations. */
export type OfflineLogoutAction = 'sync' | 'discard' | 'cancel';

const settledTransition = async (): Promise<void> => undefined;

/** Options for {@link OfflineCoordinatorService.resumeRemoteSession}. */
export interface OfflineResumeRemoteSessionOptions {
  readonly foregroundScopeIds?: readonly string[];
}

/** Coordinates local persistence, session boundaries, network state, and outbox synchronization. */
@Injectable({ providedIn: 'root' })
export class OfflineCoordinatorService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #network = inject(OfflineNetworkService);
  readonly #mutationPersistence = inject(OfflineMutationPersistenceService);
  readonly #sync = inject(OfflineSyncService);
  readonly #session = inject(OfflineSessionService);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #storageState = signal<OfflineStorageState>({ status: 'initializing' });
  #transitionRevision = 0;
  #transitionTail: Promise<void> = settledTransition();

  /**
   * Local storage readiness after {@link initialize}.
   *
   * When `unavailable`, the product opted into online-only startup; replica/outbox APIs must not be used.
   */
  readonly storageState = this.#storageState.asReadonly();
  /**
   * Product-policy guard: `true` only when encrypted local storage finished initialization successfully.
   *
   * Use this (or {@link storageState}) to disable offline mutations and replica reads when storage is unavailable.
   */
  readonly isStorageReady = computed(() => this.#storageState().status === 'ready');

  readonly networkState = this.#network.state;
  readonly syncState = this.#sync.syncState;
  readonly pendingCount = this.#sync.pendingCount;
  readonly conflicts = this.#sync.conflicts;
  /** Device-local control for accepting new durable Outbox mutations. */
  readonly mutationPersistence = this.#mutationPersistence;

  /**
   * Opens local storage, then session and sync.
   *
   * Repository failure without {@link OfflineKitOptions.onStorageUnavailable} throws
   * {@link OfflineStorageUnavailableError}. When the callback is present and settles, this method
   * resolves with {@link storageState} `unavailable` and skips session/sync initialization.
   */
  async initialize(): Promise<void> {
    await this.#mutationPersistence.initialize();
    const networkReady = this.#network.initialize();
    const initializeRepository = async (): Promise<void> => this.#repository.initialize();
    const repositoryReady = await initializeRepository().then(
      () => true,
      async (error: unknown) => {
        await networkReady;
        const typed = this.#asStorageUnavailable(error);
        this.#storageState.set({ status: 'unavailable', error: typed });
        const onUnavailable = this.#options.onStorageUnavailable;
        if (!onUnavailable) throw typed;
        await onUnavailable(typed);
        return false;
      },
    );
    if (!repositoryReady) return;
    await networkReady;
    this.#storageState.set({ status: 'ready' });
    await this.#session.initialize();
    await this.#sync.initialize();
  }

  async activateSession(userId: OfflinePrincipalId, scopeIds: readonly string[], authSubject: string | null): Promise<void> {
    if (!(await this.prepareRemoteSession(userId, scopeIds, authSubject))) return;
    await this.resumeRemoteSession();
  }

  /** Installs a remotely verified identity without starting pull or outbox replay. */
  async prepareRemoteSession(
    userId: OfflinePrincipalId,
    scopeIds: readonly string[],
    authSubject: string | null,
    authLease?: OfflineSessionTransitionLease,
  ): Promise<boolean> {
    if (this.#storageUnavailable()) return true;
    const revision = ++this.#transitionRevision;
    const lease = this.#lease(revision, authLease);
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      await this.#session.suspendRemoteSession();
      if (!lease.isCurrent()) return false;
      return this.#session.activateSession(userId, scopeIds, authSubject, lease);
    });
  }

  /** Starts pull and outbox replay after the caller has published remote access. */
  async resumeRemoteSession(options?: OfflineResumeRemoteSessionOptions): Promise<void> {
    if (this.#storageUnavailable()) return;
    await this.#sync.refreshSession(options?.foregroundScopeIds);
  }

  /**
   * Activates a restored identity for local replica/outbox use without enabling transport sync.
   */
  async activateOfflineSession(
    authSubject?: string | null,
    authLease?: OfflineSessionTransitionLease,
  ): Promise<OfflineSessionManifest | null> {
    if (this.#storageUnavailable()) return null;
    const revision = ++this.#transitionRevision;
    const lease = this.#lease(revision, authLease);
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      if (!lease.isCurrent()) return null;
      const manifest = await this.#session.activateOfflineSession(authSubject, lease);
      if (manifest && lease.isCurrent()) await this.#sync.refreshLocalSession();
      return lease.isCurrent() ? manifest : null;
    });
  }

  async clearActiveSession(): Promise<void> {
    if (this.#storageUnavailable()) return;
    this.#sync.revokeSession();
    this.#session.revokeAccess();
    ++this.#transitionRevision;
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      await this.#session.clearActiveSession();
    });
  }

  async prepareLogout(action: OfflineLogoutAction): Promise<boolean> {
    if (this.#storageUnavailable()) return action !== 'cancel';
    if (action === 'cancel') return false;
    if (action === 'discard') {
      await this.#sync.discardAllPending();
      return true;
    }
    await this.#sync.flush();
    return this.#sync.pendingCount() === 0;
  }

  async flush(): Promise<void> {
    if (this.#storageUnavailable()) return;
    return this.#sync.flush();
  }

  #asStorageUnavailable(error: unknown): OfflineStorageUnavailableError {
    if (error instanceof OfflineStorageUnavailableError) return error;
    const message = error instanceof Error ? error.message : 'Offline storage is unavailable.';
    return new OfflineStorageUnavailableError('storage_unavailable', message || 'Offline storage is unavailable.', {
      cause: error,
    });
  }

  #storageUnavailable(): boolean {
    return this.#storageState().status === 'unavailable';
  }

  #lease(revision: number, authLease?: OfflineSessionTransitionLease): OfflineSessionTransitionLease {
    return { isCurrent: () => revision === this.#transitionRevision && (authLease?.isCurrent() ?? true) };
  }

  #enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const transition = this.#transitionTail.then(operation, operation);
    this.#transitionTail = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }
}
