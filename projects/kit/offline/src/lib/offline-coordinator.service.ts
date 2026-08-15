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
  #localInitialization: Promise<void> | null = null;
  #syncInitialization: Promise<void> | null = null;
  #runtimeInitialization: Promise<void> | null = null;
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

  /** Opens local storage and restores its persisted session boundary without waiting for network discovery. */
  initializeLocal(): Promise<void> {
    this.#localInitialization ??= this.#initializeLocal();
    return this.#localInitialization;
  }

  /** Opens the local substrate, starts network discovery, then initializes synchronization. */
  initialize(): Promise<void> {
    this.#runtimeInitialization ??= this.#initializeRuntime();
    return this.#runtimeInitialization;
  }

  async #initializeLocal(): Promise<void> {
    await this.#mutationPersistence.initialize();
    const initializeSubstrate = async (): Promise<void> => {
      await this.#repository.initialize();
      await this.#session.initialize();
    };
    const substrateReady = await initializeSubstrate().then(
      () => true,
      async (error: unknown) => {
        const typed = this.#asStorageUnavailable(error);
        this.#storageState.set({ status: 'unavailable', error: typed });
        const onUnavailable = this.#options.onStorageUnavailable;
        if (!onUnavailable) throw typed;
        await onUnavailable(typed);
        return false;
      },
    );
    if (!substrateReady) return;
    this.#storageState.set({ status: 'ready' });
  }

  async #initializeRuntime(): Promise<void> {
    const networkReady = this.#network.initialize();
    await Promise.all([this.#initializeSync(), networkReady]);
  }

  #initializeSync(): Promise<void> {
    this.#syncInitialization ??= this.#initializeSyncOnce();
    return this.#syncInitialization;
  }

  async #initializeSyncOnce(): Promise<void> {
    await this.initializeLocal();
    if (this.#storageUnavailable()) return;
    await this.#sync.initialize({ flush: false });
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
    const revision = ++this.#transitionRevision;
    const lease = this.#lease(revision, authLease);
    await this.initialize();
    if (this.#storageUnavailable()) return true;
    if (!lease.isCurrent()) return false;
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      await this.#session.suspendRemoteSession();
      if (!lease.isCurrent()) return false;
      return this.#session.activateSession(userId, scopeIds, authSubject, lease);
    });
  }

  /** Starts pull and outbox replay after the caller has published remote access. */
  async resumeRemoteSession(options?: OfflineResumeRemoteSessionOptions): Promise<void> {
    await this.initialize();
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
    const revision = ++this.#transitionRevision;
    const lease = this.#lease(revision, authLease);
    await this.#initializeSync();
    if (this.#storageUnavailable()) return null;
    if (!lease.isCurrent()) return null;
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      if (!lease.isCurrent()) return null;
      const manifest = await this.#session.activateOfflineSession(authSubject, lease);
      if (manifest && lease.isCurrent()) await this.#sync.refreshLocalSession();
      return lease.isCurrent() ? manifest : null;
    });
  }

  async clearActiveSession(): Promise<void> {
    this.#sync.revokeSession();
    this.#session.revokeAccess();
    ++this.#transitionRevision;
    await this.#initializeSync();
    if (this.#storageUnavailable()) return;
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      await this.#session.clearActiveSession();
    });
  }

  async prepareLogout(action: OfflineLogoutAction): Promise<boolean> {
    await this.initialize();
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
    await this.initialize();
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
