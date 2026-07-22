import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_REPOSITORY, type OfflineEntity, type OfflineRepository, type OfflineScope } from './offline-repository';
import { OfflineSessionService, type OfflineSessionManifest } from './offline-session.service';

describe('OfflineSessionService shared-device boundary', () => {
  let service: OfflineSessionService;
  let lastUserId: number | null;
  let entities: OfflineEntity[];
  let clearUser: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    lastUserId = 10;
    entities = [
      {
        userId: 10,
        groupId: 0,
        entityType: '__offline_session',
        entityId: 'current',
        value: { userId: 10, scopeIds: [1], authSubject: 'uid-A', updatedAt: 1 } satisfies OfflineSessionManifest,
        serverRevision: null,
        fetchedAt: 1,
      },
    ];
    clearUser = vi.fn(async (userId: number) => {
      entities = entities.filter((entity) => entity.userId !== userId);
      if (lastUserId === userId) lastUserId = null;
    });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getLastUserId: vi.fn(async () => lastUserId),
      setLastUserId: vi.fn(async (userId: number) => {
        lastUserId = userId;
      }),
      getEntity: vi.fn(
        async (scope: OfflineScope, type: string, id: string) =>
          entities.find(
            (entity) =>
              entity.userId === scope.userId && entity.groupId === scope.groupId && entity.entityType === type && entity.entityId === id,
          ) ?? null,
      ),
      putEntity: vi.fn(async (entity: OfflineEntity) => {
        entities.push(entity);
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
});
