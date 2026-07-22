import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_REPOSITORY, type OfflineRepository } from './offline-repository';
import { OfflineSessionService, type OfflineSessionManifest } from './offline-session.service';

describe('OfflineSessionService shared-device boundary', () => {
  let service: OfflineSessionService;
  let lastUserId: number | null;
  let manifests: Map<number, OfflineSessionManifest>;
  let clearUser: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lastUserId = 10;
    manifests = new Map([
      [
        10,
        { userId: 10, scopeIds: [1], authSubject: 'uid-A', updatedAt: 1 },
      ],
    ]);
    clearUser = vi.fn(async (userId: number) => {
      manifests.delete(userId);
      if (lastUserId === userId) lastUserId = null;
    });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getLastUserId: vi.fn(async () => lastUserId),
      setLastUserId: vi.fn(async (userId: number) => {
        lastUserId = userId;
      }),
      getSessionManifest: vi.fn(async (userId: number) => manifests.get(userId) ?? null),
      putSessionManifest: vi.fn(async (userId: number, manifest: OfflineSessionManifest) => {
        manifests.set(userId, manifest);
      }),
      clearUser,
      clearGroup: vi.fn(async () => undefined),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [OfflineSessionService, { provide: OFFLINE_REPOSITORY, useValue: repository }],
    });
    service = TestBed.inject(OfflineSessionService);
  });

  it('起動時に旧manifestを復元しても認証後activateまではsync contextへ公開しない', async () => {
    await service.initialize();
    await expect(service.getSession()).resolves.toBeNull();
  });

  it('AからBへ認証主体が変わるとA全scopeを削除してからBを有効化する', async () => {
    await service.initialize();
    await service.activateSession(20, [2], 'uid-B');
    expect(clearUser).toHaveBeenCalledWith(10);
    expect(lastUserId).toBe(20);
    await expect(service.getSession()).resolves.toEqual({ userId: 20, scopes: [{ userId: 20, groupId: 2 }] });
    expect(service.activeManifest()).toMatchObject({ userId: 20, authSubject: 'uid-B' });
  });

  it('同じuserIdでもauthSubjectが変わると旧主体の全scopeを継承しない', async () => {
    await service.initialize();
    await service.activateSession(10, [2], 'uid-B');
    expect(clearUser).toHaveBeenCalledWith(10);
    expect(manifests.get(10)).toMatchObject({ userId: 10, scopeIds: [2], authSubject: 'uid-B' });
    expect(service.activeManifest()).toMatchObject({ userId: 10, scopeIds: [2], authSubject: 'uid-B' });
  });

  it('legacy null subjectから既知subjectへの移行時も旧local replicaを削除する', async () => {
    manifests.set(10, { userId: 10, scopeIds: [1], authSubject: null, updatedAt: 1 });
    await service.initialize();
    await service.activateSession(10, [1], 'uid-A');
    expect(clearUser).toHaveBeenCalledWith(10);
  });
});
