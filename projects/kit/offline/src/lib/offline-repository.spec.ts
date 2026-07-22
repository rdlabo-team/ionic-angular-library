import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { isOfflineFallbackError } from './offline-network.service';
import {
  IonicOfflineRepository,
  OFFLINE_REPOSITORY,
  selectOfflineRepository,
  type OfflineCommand,
  type OfflineRepository,
} from './offline-repository';

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | null> {
    return Promise.resolve((this.values.get(key) as T | undefined) ?? null);
  }
  set<T>(key: string, value: T): Promise<T> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve(value);
  }
  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

describe('IonicOfflineRepository', () => {
  let repository: OfflineRepository;
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    TestBed.configureTestingModule({
      providers: [
        IonicOfflineRepository,
        { provide: KitStorageService, useValue: storage },
        { provide: OFFLINE_REPOSITORY, useExisting: IonicOfflineRepository },
      ],
    });
    repository = TestBed.inject(OFFLINE_REPOSITORY);
  });

  it('cacheを user/group scope ごとに分離する', async () => {
    await repository.putQuery({
      userId: 1,
      groupId: 10,
      queryKey: 'snapshot',
      value: { records: [1] },
      orderedIds: [],
      cursor: null,
      etag: null,
      fetchedAt: 1,
      isComplete: true,
    });
    expect(await repository.getQuery({ userId: 1, groupId: 10 }, 'snapshot')).toMatchObject({
      value: { records: [1] },
    });
    expect(await repository.getQuery({ userId: 1, groupId: 11 }, 'snapshot')).toBeNull();
    expect(await repository.getQuery({ userId: 2, groupId: 10 }, 'snapshot')).toBeNull();
  });

  it('outboxを作成順で保持し、group削除時はそのscopeだけを消す', async () => {
    const base: Omit<OfflineCommand, 'groupId' | 'commandId' | 'createdAt'> = {
      userId: 1,
      aggregateType: 'documents',
      aggregateId: '1',
      operation: 'documents.upsert',
      payload: {},
      payloadHash: 'hash',
      baseRevision: null,
      state: 'pending' as const,
      attempts: 0,
      retryAt: null,
      lastErrorCode: null,
    };
    await repository.putCommand({ ...base, groupId: 10, commandId: 'later', createdAt: 20 });
    await repository.putCommand({ ...base, groupId: 10, commandId: 'earlier', createdAt: 10 });
    await repository.putCommand({ ...base, groupId: 11, commandId: 'keep', createdAt: 5 });
    expect((await repository.getCommands({ userId: 1, groupId: 10 })).map((item) => item.commandId)).toEqual(['earlier', 'later']);

    await repository.clearGroup({ userId: 1, groupId: 10 });
    expect(await repository.getCommands({ userId: 1, groupId: 10 })).toEqual([]);
    expect(await repository.getCommands({ userId: 1, groupId: 11 })).toHaveLength(1);
  });

  it('local resource idを並行要求でも永続的に単調採番する', async () => {
    await expect(Promise.all([repository.allocateLocalId(), repository.allocateLocalId()])).resolves.toEqual([
      2_000_000_000_001, 2_000_000_000_002,
    ]);
    expect((storage.values.get('offline:metadata') as { nextLocalId: number }).nextLocalId).toBe(2_000_000_000_002);
  });

  it('未知schemaではoffline領域だけ初期化し他のstorage keyを保持する', async () => {
    storage.values.set('offline:metadata', { schemaVersion: 999, lastUserId: 1 });
    storage.values.set('offline:outbox:commands', { stale: {} });
    storage.values.set('firebaseToken', { token: 'keep' });
    await repository.initialize();
    expect(storage.values.has('offline:outbox:commands')).toBe(false);
    expect(storage.values.get('firebaseToken')).toEqual({ token: 'keep' });
  });

  it('cache fallbackは通信不能だけを対象にする', () => {
    expect(isOfflineFallbackError({ status: 0 })).toBe(true);
    expect(isOfflineFallbackError({ status: 403 })).toBe(false);
    expect(isOfflineFallbackError({ status: 500 })).toBe(false);
  });
});

describe('selectOfflineRepository', () => {
  const web = { initialize: vi.fn() } as unknown as OfflineRepository;
  const native = { initialize: vi.fn() } as unknown as OfflineRepository;

  it.each(['ios', 'android'])('%s は暗号化SQLiteを使う', (platform) => {
    expect(selectOfflineRepository(platform, web, native)).toBe(native);
  });

  it('web はIonic Storageを使う', () => {
    expect(selectOfflineRepository('web', web, native)).toBe(web);
  });
});
