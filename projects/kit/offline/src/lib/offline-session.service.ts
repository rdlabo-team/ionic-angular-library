import { inject, Injectable, signal } from '@angular/core';
import type { OfflineScope } from './offline-repository';
import { OFFLINE_REPOSITORY } from './offline-repository';

/** Persisted identity and group boundary for one authenticated local replica. */
export interface OfflineSessionManifest {
  userId: number;
  scopeIds: number[];
  /** Authentication-provider subject used to distinguish users on a shared device. */
  authSubject: string | null;
  updatedAt: number;
}

/** Owns activation and cleanup of the authenticated local-replica boundary. */
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
      const manifest = await this.#repository.getSessionManifest<OfflineSessionManifest>(userId);
      this.#activeManifest.set(manifest ?? { userId, scopeIds: [], authSubject: null, updatedAt: 0 });
    }
    this.#initialized = true;
  }

  async activateSession(userId: number, scopeIds: readonly number[], authSubject: string | null): Promise<void> {
    await this.initialize();
    const normalizedScopeIds = [...new Set(scopeIds)].filter((id) => id !== 0).sort((a, b) => a - b);
    const previousUserId = await this.#repository.getLastUserId();
    let previous =
      previousUserId === userId
        ? ((await this.#repository.getSessionManifest<OfflineSessionManifest>(userId)) ?? null)
        : null;
    // A changed provider subject is a different person even when the product reuses its numeric id.
    // This deliberately also clears legacy null -> known subject and known subject -> null transitions.
    if (previousUserId !== null && (previousUserId !== userId || previous?.authSubject !== authSubject)) {
      await this.#repository.clearUser(previousUserId);
      previous = null;
    }
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
    await this.#repository.putSessionManifest(userId, manifest);
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
