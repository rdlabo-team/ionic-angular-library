import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { CAPAWESOME_SQLITE, type CapawesomeSqlitePlugin, SqliteOfflineRepository } from './sqlite-offline-repository';

describe('SqliteOfflineRepository Capawesome adapter', () => {
  let nextLocalId: number;
  let plugin: {
    [K in keyof CapawesomeSqlitePlugin]: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    nextLocalId = 2_000_000_000_000;
    plugin = {
      open: vi.fn(async () => ({ databaseId: 'offline-db' })),
      execute: vi.fn(async ({ statement }: { statement: string }) => {
        if (statement.startsWith('UPDATE offline_metadata SET next_local_id')) nextLocalId += 1;
        return {};
      }),
      query: vi.fn(async ({ statement }: { statement: string }) => {
        if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
        if (statement.startsWith('SELECT next_local_id')) return { rows: [{ next_local_id: nextLocalId }] };
        return { rows: [] };
      }),
      beginTransaction: vi.fn(async () => undefined),
      commitTransaction: vi.fn(async () => undefined),
      rollbackTransaction: vi.fn(async () => undefined),
    };
  });

  it('暗号化databaseのopen失敗を呼び出し元へ伝播する', async () => {
    const error = new Error('SQLCipher is not configured');
    plugin.open.mockRejectedValueOnce(error);
    const repository = createRepository();
    await expect(repository.initialize()).rejects.toBe(error);
    expect(plugin.open).toHaveBeenCalledWith({ path: 'test-offline.sqlite3', encryptionKey: 'secret', readOnly: false });
  });

  it('暗号鍵が無い場合はdatabaseを開かない', async () => {
    const repository = createRepository(async () => '');
    await expect(repository.initialize()).rejects.toThrow('non-empty encryption key');
    expect(plugin.open).not.toHaveBeenCalled();
  });

  it('group scopeのentity/query/outboxを単一transactionで削除する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.clearGroup({ userId: 7, groupId: 8 });
    const deletes = plugin.execute.mock.calls
      .map(([options]) => options as { statement: string; values?: unknown[] })
      .filter(({ statement }) => statement.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(3);
    expect(deletes.every(({ values }) => JSON.stringify(values) === '[7,8]')).toBe(true);
    expect(plugin.beginTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).toHaveBeenCalledOnce();
    expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('並列採番を直列transactionにして永続counterを重複させない', async () => {
    const repository = createRepository();
    await repository.initialize();
    await expect(Promise.all([repository.allocateLocalId(), repository.allocateLocalId()])).resolves.toEqual([
      2_000_000_000_001, 2_000_000_000_002,
    ]);
    expect(plugin.beginTransaction).toHaveBeenCalledTimes(2);
    expect(plugin.commitTransaction).toHaveBeenCalledTimes(2);
  });

  it('transaction中の書き込み失敗をrollbackして握りつぶさない', async () => {
    const error = new Error('disk full');
    const repository = createRepository();
    await repository.initialize();
    plugin.execute.mockImplementationOnce(async () => Promise.reject(error));
    await expect(repository.clearUser(7)).rejects.toBe(error);
    expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).not.toHaveBeenCalled();
  });

  function createRepository(encryptionKey: () => Promise<string> = async () => 'secret'): SqliteOfflineRepository {
    TestBed.configureTestingModule({
      providers: [
        SqliteOfflineRepository,
        { provide: CAPAWESOME_SQLITE, useValue: plugin },
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', encryptionKey } },
      ],
    });
    return TestBed.inject(SqliteOfflineRepository);
  }
});
