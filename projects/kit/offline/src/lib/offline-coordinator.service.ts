import { inject, Injectable } from '@angular/core';
import { OfflineNetworkService } from './offline-network.service';
import { OFFLINE_REPOSITORY } from './offline-repository';
import { OfflineSessionService } from './offline-session.service';
import { OfflineSyncService } from './offline-sync.service';

export type OfflineLogoutAction = 'sync' | 'discard' | 'cancel';

@Injectable({ providedIn: 'root' })
export class OfflineCoordinatorService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #network = inject(OfflineNetworkService);
  readonly #sync = inject(OfflineSyncService);
  readonly #session = inject(OfflineSessionService);

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
    await this.#sync.resetSession();
    await this.#session.activateSession(userId, scopeIds, authSubject);
    await this.#sync.refreshSession();
  }

  async clearActiveSession(): Promise<void> {
    await this.#sync.resetSession();
    await this.#session.clearActiveSession();
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
}
