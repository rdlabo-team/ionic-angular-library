import { inject, Injectable } from '@angular/core';
import { OfflineNetworkService } from './offline-network.service';
import { OFFLINE_REPOSITORY } from './offline-repository';
import { OfflineSessionService } from './offline-session.service';
import type { OfflineSessionManifest, OfflineSessionTransitionLease } from './offline-session.service';
import { OfflineSyncService } from './offline-sync.service';

/** User choice when logout encounters unconfirmed local mutations. */
export type OfflineLogoutAction = 'sync' | 'discard' | 'cancel';

/** Coordinates local persistence, session boundaries, network state, and outbox synchronization. */
@Injectable({ providedIn: 'root' })
export class OfflineCoordinatorService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #network = inject(OfflineNetworkService);
  readonly #sync = inject(OfflineSyncService);
  readonly #session = inject(OfflineSessionService);
  #transitionRevision = 0;
  #transitionTail: Promise<void> = Promise.resolve();

  readonly networkState = this.#network.state;
  readonly syncState = this.#sync.syncState;
  readonly pendingCount = this.#sync.pendingCount;
  readonly conflicts = this.#sync.conflicts;

  async initialize(): Promise<void> {
    await Promise.all([this.#repository.initialize(), this.#network.initialize()]);
    await this.#session.initialize();
    await this.#sync.initialize();
  }

  async activateSession(userId: number, scopeIds: readonly number[], authSubject: string | null): Promise<void> {
    if (!(await this.prepareRemoteSession(userId, scopeIds, authSubject))) return;
    await this.resumeRemoteSession();
  }

  /** Installs a remotely verified identity without starting pull or outbox replay. */
  prepareRemoteSession(
    userId: number,
    scopeIds: readonly number[],
    authSubject: string | null,
    authLease?: OfflineSessionTransitionLease,
  ): Promise<boolean> {
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
  async resumeRemoteSession(): Promise<void> {
    await this.#sync.refreshSession();
  }

  /**
   * Activates a restored identity for local replica/outbox use without enabling transport sync.
   */
  activateOfflineSession(authSubject?: string | null, authLease?: OfflineSessionTransitionLease): Promise<OfflineSessionManifest | null> {
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

  clearActiveSession(): Promise<void> {
    this.#session.revokeAccess();
    ++this.#transitionRevision;
    return this.#enqueueTransition(async () => {
      await this.#sync.resetSession();
      await this.#session.clearActiveSession();
    });
  }

  async prepareLogout(action: OfflineLogoutAction): Promise<boolean> {
    if (action === 'cancel') return false;
    if (action === 'discard') {
      await this.#sync.discardAllPending();
      return true;
    }
    await this.#sync.flush();
    return this.#sync.pendingCount() === 0;
  }

  flush(): Promise<void> {
    return this.#sync.flush();
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
