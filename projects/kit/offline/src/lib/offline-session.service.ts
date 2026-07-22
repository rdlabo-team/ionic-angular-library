import { inject, Injectable, signal } from '@angular/core';
import type { OfflineScope } from './offline-repository';
import { OFFLINE_REPOSITORY } from './offline-repository';

const SESSION_ENTITY_TYPE = '__offline_session';
const SESSION_ENTITY_ID = 'current';
const SESSION_GROUP_ID = 0;

export interface OfflineSessionManifest {
  userId: number;
  scopeIds: number[];
  /** Authentication-provider subject used to distinguish users on a shared device. */
  authSubject: string | null;
  updatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class OfflineSessionService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #activeManifest = signal<OfflineSessionManifest | null>(null);
  #initialized = false;
  #activatedThisRun = false;

  readonly activeManifest = this.#activeManifest.asReadonly();

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#repository.initialize();
    const userId = await this.#repository.getLastUserId();
    if (userId !== null) {
      const entity = await this.#repository.getEntity<OfflineSessionManifest>(
        { userId, groupId: SESSION_GROUP_ID },
        SESSION_ENTITY_TYPE,
        SESSION_ENTITY_ID,
      );
      this.#activeManifest.set(entity?.value ?? { userId, scopeIds: [], authSubject: null, updatedAt: 0 });
    }
    this.#initialized = true;
  }

  async activateSession(userId: number, scopeIds: readonly number[], authSubject: string | null): Promise<void> {
    await this.initialize();
    const normalizedScopeIds = [...new Set(scopeIds)].filter((id) => id !== SESSION_GROUP_ID).sort((a, b) => a - b);
    const previousUserId = await this.#repository.getLastUserId();
    if (previousUserId !== null && previousUserId !== userId) await this.#repository.clearUser(previousUserId);

    const sessionScope = { userId, groupId: SESSION_GROUP_ID };
    const previous =
      previousUserId === userId
        ? ((await this.#repository.getEntity<OfflineSessionManifest>(sessionScope, SESSION_ENTITY_TYPE, SESSION_ENTITY_ID))?.value ?? null)
        : null;
    const active = new Set(normalizedScopeIds);
    await Promise.all(
      (previous?.scopeIds ?? [])
        .filter((groupId) => !active.has(groupId))
        .map((groupId) => this.#repository.clearGroup({ userId, groupId })),
    );

    const manifest: OfflineSessionManifest = {
      userId,
      scopeIds: normalizedScopeIds,
      authSubject,
      updatedAt: Date.now(),
    };
    await this.#repository.setLastUserId(userId);
    await this.#repository.putEntity({
      ...sessionScope,
      entityType: SESSION_ENTITY_TYPE,
      entityId: SESSION_ENTITY_ID,
      value: manifest,
      serverRevision: null,
      fetchedAt: manifest.updatedAt,
    });
    this.#activeManifest.set(manifest);
    this.#activatedThisRun = true;
  }

  async clearActiveSession(): Promise<void> {
    await this.initialize();
    const userId = await this.#repository.getLastUserId();
    if (userId !== null) await this.#repository.clearUser(userId);
    this.#activeManifest.set(null);
    this.#activatedThisRun = false;
  }

  async getSession(): Promise<{ userId: number; scopes: OfflineScope[] } | null> {
    await this.initialize();
    if (!this.#activatedThisRun) return null;
    const manifest = this.#activeManifest();
    return manifest
      ? { userId: manifest.userId, scopes: manifest.scopeIds.map((groupId) => ({ userId: manifest.userId, groupId })) }
      : null;
  }
}
