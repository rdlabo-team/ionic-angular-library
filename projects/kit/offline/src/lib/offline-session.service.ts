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
  #localAccessThisRun = false;
  #remoteActivatedThisRun = false;

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
    let previous = previousUserId === userId ? ((await this.#repository.getSessionManifest<OfflineSessionManifest>(userId)) ?? null) : null;
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
    this.#localAccessThisRun = true;
    this.#remoteActivatedThisRun = true;
  }

  async clearActiveSession(): Promise<void> {
    await this.initialize();
    const userId = await this.#repository.getLastUserId();
    if (userId !== null) await this.#repository.clearUser(userId);
    this.#activeManifest.set(null);
    this.#localAccessThisRun = false;
    this.#remoteActivatedThisRun = false;
  }

  /**
   * Returns the persisted identity boundary for local-only route access.
   *
   * @remarks
   * This does not activate the sync context. Call it only after the authentication authority has
   * been classified as unavailable, never after explicit sign-out or HTTP 401/403. Legacy
   * manifests without an authentication-provider subject are rejected.
   *
   * @param authSubject - A currently known provider subject. When supplied, it must match the
   * persisted subject.
   */
  async getOfflineAccessManifest(authSubject?: string | null): Promise<OfflineSessionManifest | null> {
    await this.initialize();
    const manifest = this.#activeManifest();
    if (!manifest?.authSubject || (authSubject !== undefined && manifest.authSubject !== authSubject)) {
      return null;
    }
    return { ...manifest, scopeIds: [...manifest.scopeIds] };
  }

  /**
   * Activates a previously verified manifest for local replica and outbox access only.
   *
   * @remarks
   * This never enables pull or command replay. A later successful remote authentication must call
   * {@link activateSession} before synchronization can use transport.
   *
   * @param authSubject - A currently known provider subject. When supplied, it must match the
   * persisted subject.
   */
  async activateOfflineSession(authSubject?: string | null): Promise<OfflineSessionManifest | null> {
    const manifest = await this.getOfflineAccessManifest(authSubject);
    this.#localAccessThisRun = manifest !== null;
    this.#remoteActivatedThisRun = false;
    return manifest;
  }

  /** Returns the session allowed to use the local replica and append outbox commands. */
  async getLocalSession(): Promise<{ userId: number; scopes: OfflineScope[] } | null> {
    await this.initialize();
    return this.#localAccessThisRun ? this.#sessionFromManifest() : null;
  }

  /** Returns the remotely authenticated session eligible for pull and command replay. */
  async getSession(): Promise<{ userId: number; scopes: OfflineScope[] } | null> {
    await this.initialize();
    return this.#remoteActivatedThisRun ? this.#sessionFromManifest() : null;
  }

  #sessionFromManifest(): { userId: number; scopes: OfflineScope[] } | null {
    const manifest = this.#activeManifest();
    return manifest
      ? { userId: manifest.userId, scopes: manifest.scopeIds.map((groupId) => ({ userId: manifest.userId, groupId })) }
      : null;
  }
}
