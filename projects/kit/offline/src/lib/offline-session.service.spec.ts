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
    manifests = new Map([[10, { userId: 10, scopeIds: ['1'], authSubject: 'uid-A', updatedAt: 1 }]]);
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
      clearScope: vi.fn(async () => undefined),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [OfflineSessionService, { provide: OFFLINE_REPOSITORY, useValue: repository }],
    });
    service = TestBed.inject(OfflineSessionService);
  });

  it('起動時に旧manifestを復元しても認証後activateまではsync contextへ公開しない', async () => {
    await service.initialize();
    await expect(service.getLocalSession()).resolves.toBeNull();
    await expect(service.getSession()).resolves.toBeNull();
  });

  it('認証基盤へ到達不能ならsubject付きmanifestをlocal accessへ復元する', async () => {
    await expect(service.getOfflineAccessManifest()).resolves.toEqual({
      userId: 10,
      scopeIds: ['1'],
      authSubject: 'uid-A',
      updatedAt: 1,
    });
    await expect(service.getSession()).resolves.toBeNull();
  });

  it('offline sessionはlocal/outbox contextだけを有効にしてremote syncを許可しない', async () => {
    await expect(service.activateOfflineSession('uid-A')).resolves.toMatchObject({ userId: 10 });
    await expect(service.getLocalSession()).resolves.toEqual({
      userId: 10,
      scopes: [{ userId: 10, scopeId: '1' }],
    });
    await expect(service.getSession()).resolves.toBeNull();
  });

  it('永続削除を待たずにlocal/outboxとremote syncのruntime accessを失効する', async () => {
    await service.activateOfflineSession('uid-A');

    service.revokeAccess();

    await expect(service.getLocalSession()).resolves.toBeNull();
    await expect(service.getSession()).resolves.toBeNull();
    await expect(service.getOfflineAccessManifest('uid-A')).resolves.toMatchObject({ userId: 10 });
  });

  it('既知のsubjectがmanifestと違う場合はlocal accessを拒否する', async () => {
    await expect(service.getOfflineAccessManifest('uid-B')).resolves.toBeNull();
    await expect(service.getOfflineAccessManifest(null)).resolves.toBeNull();
  });

  it('legacy null subjectのmanifestはlocal accessへ復元しない', async () => {
    manifests.set(10, { userId: 10, scopeIds: ['1'], authSubject: null, updatedAt: 1 });
    await expect(service.getOfflineAccessManifest()).resolves.toBeNull();
  });

  it('明示logoutでclearしたmanifestはlocal accessへ復元しない', async () => {
    await service.clearActiveSession();
    await expect(service.getOfflineAccessManifest()).resolves.toBeNull();
  });

  it('AからBへ認証主体が変わるとA全scopeを削除してからBを有効化する', async () => {
    await service.initialize();
    await service.activateSession(20, ['2'], 'uid-B');
    expect(clearUser).toHaveBeenCalledWith(10);
    expect(lastUserId).toBe(20);
    await expect(service.getSession()).resolves.toEqual({ userId: 20, scopes: [{ userId: 20, scopeId: '2' }] });
    await expect(service.getLocalSession()).resolves.toEqual({
      userId: 20,
      scopes: [{ userId: 20, scopeId: '2' }],
    });
    expect(service.activeManifest()).toMatchObject({ userId: 20, authSubject: 'uid-B' });
  });

  it('user-scoped replicaのscope 0をmanifestとremote sessionに保持する', async () => {
    await service.activateSession(10, ['0'], 'uid-A');

    expect(service.activeManifest()).toMatchObject({ userId: 10, scopeIds: ['0'], authSubject: 'uid-A' });
    await expect(service.getSession()).resolves.toEqual({
      userId: 10,
      scopes: [{ userId: 10, scopeId: '0' }],
    });
  });

  it('同じuserIdでもauthSubjectが変わると旧主体の全scopeを継承しない', async () => {
    await service.initialize();
    await service.activateSession(10, ['2'], 'uid-B');
    expect(clearUser).toHaveBeenCalledWith(10);
    expect(manifests.get(10)).toMatchObject({ userId: 10, scopeIds: ['2'], authSubject: 'uid-B' });
    expect(service.activeManifest()).toMatchObject({ userId: 10, scopeIds: ['2'], authSubject: 'uid-B' });
  });

  it('legacy null subjectから既知subjectへの移行時も旧local replicaを削除する', async () => {
    manifests.set(10, { userId: 10, scopeIds: ['1'], authSubject: null, updatedAt: 1 });
    await service.initialize();
    await service.activateSession(10, ['1'], 'uid-A');
    expect(clearUser).toHaveBeenCalledWith(10);
  });
});
