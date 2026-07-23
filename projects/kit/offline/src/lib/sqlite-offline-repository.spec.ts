/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  serverId,
  sha256OfflineReplicaSchema,
  text,
  type OfflineReplicaSchemaBundle,
} from './offline-replica-schema';
import {
  COMMUNITY_SQLITE,
  type CommunitySqliteConnection,
  type CommunitySqliteDatabase,
  type CommunitySqliteDriver,
  createCommunitySqliteDriver,
  SqliteOfflineRepository,
} from './sqlite-offline-repository';

type TestItemSelect = { id: number; title: string };
type TestItemWithSubtitleSelect = { id: number; title: string; subtitle: string };

const testItemEntity = defineReplicaEntity<TestItemSelect>()({
  table: 'test_items',
  sourceKey: 'test_items',
  scope: 'user',
  fields: {
    id: serverId(),
    title: text(),
  },
});

const testItemWithSubtitleEntity = defineReplicaEntity<TestItemWithSubtitleSelect>()({
  table: 'test_items',
  sourceKey: 'test_items',
  scope: 'user',
  fields: {
    id: serverId(),
    title: text(),
    subtitle: text(),
  },
});

const testGroupItemEntity = defineReplicaEntity<{ id: number; name: string }>()({
  table: 'test_group_items',
  sourceKey: 'test_group_items',
  scope: 'group',
  fields: {
    id: serverId(),
    name: text(),
  },
});

const replicaSchemaV1 = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemEntity],
  migrations: [],
});

const replicaSchemaV1WithGroup = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemEntity, testGroupItemEntity],
  migrations: [],
});

const replicaSchemaV2 = defineOfflineReplicaSchema({
  version: 2,
  entities: [testItemEntity],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0'],
      migrateWebRow: (row) => row,
    },
  ],
});

const replicaSchemaV3MissingMigration = defineOfflineReplicaSchema({
  version: 3,
  entities: [testItemEntity],
  migrations: [{ fromVersion: 1, statements: ['SELECT 1'], migrateWebRow: (row) => row }],
});

const replicaSchemaV1HashDrift = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemWithSubtitleEntity],
  migrations: [],
});

describe('createCommunitySqliteDriver', () => {
  const createDatabase = (): CommunitySqliteDatabase => ({
    open: vi.fn(async () => undefined),
    run: vi.fn(async () => ({})),
    query: vi.fn(async () => ({ values: [{ id: 1 }] })),
    beginTransaction: vi.fn(async () => ({})),
    commitTransaction: vi.fn(async () => ({})),
    rollbackTransaction: vi.fn(async () => ({})),
  });

  it('first open stores a generated secret and opens an encrypted connection', async () => {
    const database = createDatabase();
    const connection: CommunitySqliteConnection = {
      isSecretStored: vi.fn(async () => ({ result: false })),
      setEncryptionSecret: vi.fn(async () => undefined),
      createConnection: vi.fn(async () => database),
    };
    const createEncryptionKey = vi.fn(async () => 'random-install-secret');
    const driver = createCommunitySqliteDriver(connection);

    await expect(driver.open({ databaseName: 'product-offline', createEncryptionKey })).resolves.toEqual({
      databaseId: 'product-offline',
    });
    expect(createEncryptionKey).toHaveBeenCalledOnce();
    expect(connection.setEncryptionSecret).toHaveBeenCalledWith('random-install-secret');
    expect(connection.createConnection).toHaveBeenCalledWith('product-offline', true, 'secret', 1, false);
    expect(database.open).toHaveBeenCalledOnce();
  });

  it('later opens use the plugin secret without generating or receiving it again', async () => {
    const database = createDatabase();
    const connection: CommunitySqliteConnection = {
      isSecretStored: vi.fn(async () => ({ result: true })),
      setEncryptionSecret: vi.fn(async () => undefined),
      createConnection: vi.fn(async () => database),
    };
    const createEncryptionKey = vi.fn(async () => 'must-not-be-read');

    await createCommunitySqliteDriver(connection).open({ databaseName: 'product-offline', createEncryptionKey });

    expect(createEncryptionKey).not.toHaveBeenCalled();
    expect(connection.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('rejects first open when the generator returns an empty key', async () => {
    const connection: CommunitySqliteConnection = {
      isSecretStored: vi.fn(async () => ({ result: false })),
      setEncryptionSecret: vi.fn(async () => undefined),
      createConnection: vi.fn(async () => createDatabase()),
    };

    await expect(
      createCommunitySqliteDriver(connection).open({
        databaseName: 'product-offline',
        createEncryptionKey: async () => '',
      }),
    ).rejects.toThrow('non-empty encryption key on first open');
    expect(connection.setEncryptionSecret).not.toHaveBeenCalled();
    expect(connection.createConnection).not.toHaveBeenCalled();
  });
});

describe('SqliteOfflineRepository community sqlite driver', () => {
  let plugin: {
    [K in keyof CommunitySqliteDriver]: ReturnType<typeof vi.fn>;
  };
  let storedReplicaMetadata: { version: number; schemaHash: string } | null;
  let replicaSchemaV1Hash: string;

  beforeAll(async () => {
    replicaSchemaV1Hash = await sha256OfflineReplicaSchema(replicaSchemaV1);
  });

  beforeEach(() => {
    storedReplicaMetadata = {
      version: replicaSchemaV1.version,
      schemaHash: replicaSchemaV1Hash,
    };
    plugin = {
      open: vi.fn(async () => ({ databaseId: 'offline-db' })),
      execute: vi.fn(async () => ({})),
      query: vi.fn(async ({ statement }: { statement: string }) => {
        if (statement.includes('offline_replica_schema_metadata')) {
          if (!storedReplicaMetadata) return { rows: [] };
          return {
            columns: ['version', 'schema_hash'],
            rows: [[storedReplicaMetadata.version, storedReplicaMetadata.schemaHash]],
          };
        }
        if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
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
    expect(plugin.open).toHaveBeenCalledWith({
      databaseName: 'test-offline',
      createEncryptionKey: expect.any(Function),
    });
  });

  it('暗号鍵の生成関数をcommunity driverへ渡す', async () => {
    const createEncryptionKey = vi.fn(async () => 'first-install-secret');
    const repository = createRepository(createEncryptionKey);
    await repository.initialize();
    const options = plugin.open.mock.calls[0]?.[0] as { createEncryptionKey?: () => Promise<string> };
    await expect(options.createEncryptionKey?.()).resolves.toBe('first-install-secret');
  });

  it('group scopeのoutboxを単一transactionで削除する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.clearGroup({ userId: 7, groupId: 8 });
    const deletes = plugin.execute.mock.calls
      .map(([options]) => options as { statement: string; values?: unknown[] })
      .filter(({ statement }) => statement.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.values).toEqual([7, 8]);
    expect(deletes[1]?.values).toEqual([7, 8]);
    expect(plugin.beginTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).toHaveBeenCalledOnce();
    expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('getCommandsはcreated_atとcommand_id昇順でSQL ORDER BYする', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.putCommand({
      userId: 1,
      groupId: 10,
      commandId: 'cmd-z',
      aggregateType: 'test_items',
      aggregateLocalId: '019d-aaaa',
      operation: 'test_items.update',
      payload: {},
      optimisticValue: {},
      payloadHash: 'hash',
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 10,
      lastErrorCode: null,
    });
    await repository.putCommand({
      userId: 1,
      groupId: 10,
      commandId: 'cmd-a',
      aggregateType: 'test_items',
      aggregateLocalId: '019d-aaaa',
      operation: 'test_items.update',
      payload: {},
      optimisticValue: {},
      payloadHash: 'hash',
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 10,
      lastErrorCode: null,
    });

    await repository.getCommands({ userId: 1, groupId: 10 });
    await repository.getCommandsForUser(1);

    const scopeQuery = plugin.query.mock.calls.find(([options]) => {
      const statement = (options as { statement: string }).statement;
      return statement === 'SELECT * FROM offline_sync_commands WHERE user_id = ? AND group_id = ? ORDER BY created_at ASC, command_id ASC';
    })?.[0] as { statement: string } | undefined;
    const userQuery = plugin.query.mock.calls.find(([options]) => {
      const statement = (options as { statement: string }).statement;
      return statement === 'SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC';
    })?.[0] as { statement: string } | undefined;
    expect(scopeQuery?.statement).toBe(
      'SELECT * FROM offline_sync_commands WHERE user_id = ? AND group_id = ? ORDER BY created_at ASC, command_id ASC',
    );
    expect(userQuery?.statement).toBe('SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC');
  });

  it('replicaとoutboxを単一transactionで更新する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          groupId: 10,
          sourceKey: 'test_items',
          localId: '019d-aaaa',
          serverId: null,
          values: { id: 0, title: 'Local item' },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
    });
    expect(plugin.beginTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).toHaveBeenCalledOnce();
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

  describe('offline replica schema initialization', () => {
    it('first install creates product tables and stores metadata in one transaction', async () => {
      storedReplicaMetadata = null;
      const repository = createRepository();
      await repository.initialize();

      expect(plugin.beginTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).toHaveBeenCalledOnce();
      expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          (options as { statement: string }).statement.startsWith('CREATE TABLE IF NOT EXISTS test_items'),
        ),
      ).toBe(true);
      expect(
        plugin.execute.mock.calls.some(([options]) => {
          const call = options as { statement: string; values?: unknown[] };
          return call.statement.includes('offline_replica_schema_metadata') && call.values?.[0] === 1;
        }),
      ).toBe(true);
    });

    it('unchanged schema is a no-op after metadata matches', async () => {
      storedReplicaMetadata = {
        version: replicaSchemaV1.version,
        schemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      };
      const repository = createRepository();
      await repository.initialize();

      expect(plugin.beginTransaction).not.toHaveBeenCalled();
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          (options as { statement: string }).statement.startsWith('CREATE TABLE IF NOT EXISTS test_items'),
        ),
      ).toBe(false);
    });

    it('rejects hash drift without a version bump before product mutations', async () => {
      storedReplicaMetadata = {
        version: replicaSchemaV1.version,
        schemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      };
      const repository = createRepository(undefined, { replicaSchema: replicaSchemaV1HashDrift });

      await expect(repository.initialize()).rejects.toThrow('Offline replica schema hash mismatch at version 1');
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          (options as { statement: string }).statement.startsWith('CREATE TABLE IF NOT EXISTS test_items'),
        ),
      ).toBe(false);
      expect(plugin.beginTransaction).not.toHaveBeenCalled();
    });

    it('migrates stored schema through a complete one-step chain and refreshes metadata', async () => {
      storedReplicaMetadata = {
        version: replicaSchemaV1.version,
        schemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      };
      const repository = createRepository(undefined, { replicaSchema: replicaSchemaV2 });
      await repository.initialize();

      expect(
        plugin.execute.mock.calls.some(([options]) => {
          const call = options as { statement: string; values?: unknown[] };
          return call.statement === 'ALTER TABLE test_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0';
        }),
      ).toBe(true);
      expect(
        plugin.execute.mock.calls.some(([options]) => {
          const call = options as { statement: string; values?: unknown[] };
          return call.statement.includes('offline_replica_schema_metadata') && call.values?.[0] === 2;
        }),
      ).toBe(true);
      expect(plugin.beginTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).toHaveBeenCalledOnce();
    });

    it('rejects missing migrations before executing product DDL', async () => {
      storedReplicaMetadata = {
        version: replicaSchemaV1.version,
        schemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      };
      const repository = createRepository(undefined, { replicaSchema: replicaSchemaV3MissingMigration });

      await expect(repository.initialize()).rejects.toThrow('Missing offline replica schema migration from version 2 to 3.');
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          (options as { statement: string }).statement.startsWith('CREATE TABLE IF NOT EXISTS test_items'),
        ),
      ).toBe(false);
      expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
    });

    it('rolls back replica schema migration failures without updating metadata', async () => {
      storedReplicaMetadata = {
        version: replicaSchemaV1.version,
        schemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      };
      const error = new Error('migration failed');
      plugin.execute.mockImplementation(async (options: { statement: string }) => {
        if (options.statement === 'ALTER TABLE test_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0') {
          throw error;
        }
      });
      const repository = createRepository(undefined, { replicaSchema: replicaSchemaV2 });

      await expect(repository.initialize()).rejects.toBe(error);
      expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
      expect(
        plugin.execute.mock.calls.some(([options]) => {
          const call = options as { statement: string; values?: unknown[] };
          return call.statement.includes('offline_replica_schema_metadata') && call.values?.[0] === 2;
        }),
      ).toBe(false);
    });
  });

  function createRepository(
    createEncryptionKey: () => Promise<string> = async () => 'secret',
    options: { replicaSchema?: OfflineReplicaSchemaBundle } = {},
  ): SqliteOfflineRepository {
    TestBed.configureTestingModule({
      providers: [
        SqliteOfflineRepository,
        { provide: COMMUNITY_SQLITE, useValue: plugin },
        {
          provide: OFFLINE_KIT_OPTIONS,
          useValue: {
            databaseName: 'test-offline',
            createEncryptionKey,
            replicaSchema: options.replicaSchema ?? replicaSchemaV1,
          },
        },
      ],
    });
    return TestBed.inject(SqliteOfflineRepository);
  }
});

describe('SqliteOfflineRepository replica rows', () => {
  let plugin: {
    [K in keyof CommunitySqliteDriver]: ReturnType<typeof vi.fn>;
  };
  let storedReplicaMetadata: { version: number; schemaHash: string } | null;
  let replicaSchemaV1Hash: string;
  let storedReplicaRows: Record<string, { tableName: string; statement: string; values: unknown[] }>;
  let storedReplicaCursors: Record<string, string>;
  let transactionDepth: number;

  const testItemColumns = [
    'local_id',
    '_offline_user_id',
    'server_id',
    '_offline_confirmed_json',
    '_offline_server_revision_json',
    '_offline_sync_state',
    '_offline_fetched_at',
    'title',
  ];

  const testGroupItemColumns = [
    'local_id',
    '_offline_user_id',
    '_offline_group_id',
    'server_id',
    '_offline_confirmed_json',
    '_offline_server_revision_json',
    '_offline_sync_state',
    '_offline_fetched_at',
    'name',
  ];

  function replicaRowMatrix(tableName: string, stored: { values: unknown[] }): unknown[] {
    return tableName === 'test_group_items' ? [...stored.values] : [...stored.values];
  }

  function queryStoredReplicaRows(tableName: string, statement: string, values?: unknown[]) {
    const columns = tableName === 'test_group_items' ? testGroupItemColumns : testItemColumns;
    const entries = Object.entries(storedReplicaRows).filter(([, stored]) => stored.tableName === tableName);
    if (statement.includes('server_id = ?')) {
      const serverId = values?.[0];
      const userId = values?.[1];
      const groupId = tableName === 'test_group_items' ? values?.[2] : undefined;
      const stored = Object.entries(storedReplicaRows).find(([, row]) => {
        if (row.tableName !== tableName) return false;
        const serverIdIndex = tableName === 'test_group_items' ? 3 : 2;
        if (row.values[serverIdIndex] !== serverId || row.values[1] !== userId) return false;
        if (groupId !== undefined && row.values[2] !== groupId) return false;
        return true;
      });
      if (!stored) return { rows: [] };
      return { columns, rows: [replicaRowMatrix(tableName, stored[1])] };
    }
    if (statement.includes('local_id = ?')) {
      const localId = values?.[0];
      const stored = typeof localId === 'string' ? storedReplicaRows[localId] : undefined;
      if (!stored || stored.tableName !== tableName) return { rows: [] };
      return { columns, rows: [replicaRowMatrix(tableName, stored)] };
    }
    const userId = values?.[0];
    const groupId = tableName === 'test_group_items' ? values?.[1] : undefined;
    const rows = entries
      .filter(([, stored]) => {
        if (stored.values[1] !== userId) return false;
        if (groupId !== undefined && stored.values[2] !== groupId) return false;
        return true;
      })
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
      .map(([, stored]) => replicaRowMatrix(tableName, stored));
    return { columns, rows };
  }

  beforeAll(async () => {
    replicaSchemaV1Hash = await sha256OfflineReplicaSchema(replicaSchemaV1WithGroup);
  });

  beforeEach(() => {
    storedReplicaRows = {};
    storedReplicaCursors = {};
    transactionDepth = 0;
    storedReplicaMetadata = {
      version: replicaSchemaV1WithGroup.version,
      schemaHash: replicaSchemaV1Hash,
    };
    plugin = {
      open: vi.fn(async () => ({ databaseId: 'offline-db' })),
      execute: vi.fn(async ({ statement, values }: { statement: string; values?: unknown[] }) => {
        if (statement.startsWith('INSERT INTO offline_replica_cursors')) {
          const userId = values?.[0];
          const groupId = values?.[1];
          const cursor = values?.[2];
          if (typeof userId === 'number' && typeof groupId === 'number' && typeof cursor === 'string') {
            storedReplicaCursors[`${userId}:${groupId}`] = cursor;
          }
        }
        if (statement.startsWith('DELETE FROM offline_replica_cursors')) {
          const userId = values?.[0];
          const groupId = values?.[1];
          if (typeof userId === 'number' && groupId === undefined) {
            for (const key of Object.keys(storedReplicaCursors)) {
              if (key.startsWith(`${userId}:`)) delete storedReplicaCursors[key];
            }
          } else if (typeof userId === 'number' && typeof groupId === 'number') {
            delete storedReplicaCursors[`${userId}:${groupId}`];
          }
        }
        for (const tableName of ['test_items', 'test_group_items'] as const) {
          if (statement.startsWith(`INSERT INTO ${tableName}`)) {
            const localId = values?.[0];
            if (typeof localId === 'string') {
              storedReplicaRows[localId] = { tableName, statement, values: [...(values ?? [])] };
            }
          }
          if (statement.startsWith(`DELETE FROM ${tableName}`)) {
            const userId = values?.[0];
            const groupId = values?.[1];
            if (
              statement.includes('_offline_user_id = ? AND _offline_group_id = ?') &&
              typeof userId === 'number' &&
              typeof groupId === 'number'
            ) {
              for (const [localId, stored] of Object.entries(storedReplicaRows)) {
                if (stored.tableName !== tableName) continue;
                if (stored.values[1] === userId && stored.values[2] === groupId) {
                  delete storedReplicaRows[localId];
                }
              }
              continue;
            }
            const localId = values?.[0];
            if (typeof localId === 'string') delete storedReplicaRows[localId];
          }
        }
      }),
      query: vi.fn(async ({ statement, values }: { statement: string; values?: unknown[] }) => {
        if (statement.includes('offline_replica_schema_metadata')) {
          if (!storedReplicaMetadata) return { rows: [] };
          return {
            columns: ['version', 'schema_hash'],
            rows: [[storedReplicaMetadata.version, storedReplicaMetadata.schemaHash]],
          };
        }
        if (statement.includes('offline_replica_cursors')) {
          const userId = values?.[0];
          const groupId = values?.[1];
          const cursor =
            typeof userId === 'number' && typeof groupId === 'number' ? storedReplicaCursors[`${userId}:${groupId}`] : undefined;
          return cursor === undefined ? { rows: [] } : { columns: ['cursor'], rows: [[cursor]] };
        }
        for (const tableName of ['test_items', 'test_group_items'] as const) {
          if (statement.startsWith(`SELECT * FROM ${tableName}`)) {
            return queryStoredReplicaRows(tableName, statement, values);
          }
        }
        if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
        return { rows: [] };
      }),
      beginTransaction: vi.fn(async () => {
        transactionDepth += 1;
      }),
      commitTransaction: vi.fn(async () => {
        transactionDepth -= 1;
      }),
      rollbackTransaction: vi.fn(async () => {
        transactionDepth -= 1;
      }),
    };
  });

  it('normalized column upsertとoutbox writeを単一transactionで実行する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          groupId: 10,
          sourceKey: 'test_items',
          localId: '019d-bbbb',
          serverId: null,
          values: { id: 0, title: 'Local item' },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          userId: 1,
          groupId: 10,
          commandId: 'create-row-1',
          aggregateType: 'test_items',
          aggregateLocalId: '019d-bbbb',
          operation: 'test_items.create',
          payload: { title: 'Local item' },
          optimisticValue: { id: 0, title: 'Local item' },
          payloadHash: 'hash',
          baseRevision: null,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });

    expect(plugin.beginTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).toHaveBeenCalledOnce();
    expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
    expect(transactionDepth).toBe(0);
    const upsert = plugin.execute.mock.calls.find(([options]) =>
      (options as { statement: string }).statement.startsWith('INSERT INTO test_items'),
    )?.[0] as { statement: string; values?: unknown[] };
    expect(upsert?.statement).toContain('title');
    expect(upsert?.statement).not.toContain('value_json');
    expect(upsert?.values).toEqual(['019d-bbbb', 1, null, null, null, 'pending', 1, 'Local item']);
    expect(
      plugin.execute.mock.calls.some(([options]) =>
        (options as { statement: string }).statement.startsWith('INSERT INTO offline_sync_commands'),
      ),
    ).toBe(true);
  });

  it('confirmed JSONはserverId列を投影したdomain valuesだけを永続化する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          groupId: 10,
          sourceKey: 'test_items',
          localId: '019d-confirmed',
          serverId: 42,
          values: { id: 42, title: 'Optimistic' },
          confirmedValues: { id: 42, title: 'Confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
    });

    const upsert = plugin.execute.mock.calls.find(([options]) =>
      (options as { statement: string }).statement.startsWith('INSERT INTO test_items'),
    )?.[0] as { statement: string; values?: unknown[] };
    expect(upsert?.values?.[3]).toBe(JSON.stringify({ title: 'Confirmed' }));
    await expect(repository.getReplicaRowByServerId({ userId: 1, groupId: 10 }, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Optimistic' },
      confirmedValues: { title: 'Confirmed' },
    });
  });

  it('server_idはnullから38142へ更新されlocal_idは不変', async () => {
    const repository = createRepository();
    await repository.initialize();
    const scope = { userId: 1, groupId: 10 };
    const baseRow = {
      ...scope,
      sourceKey: 'test_items',
      localId: '019d-bbbb',
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending' as const,
    };
    await repository.transactReplica({
      putRows: [{ ...baseRow, serverId: null, values: { id: 0, title: 'Local item' } }],
    });
    await repository.transactReplica({
      putRows: [{ ...baseRow, serverId: 38142, values: { id: 38142, title: 'Local item' }, syncState: 'confirmed' }],
    });

    const stored = storedReplicaRows['019d-bbbb'];
    expect(stored?.values[0]).toBe('019d-bbbb');
    expect(stored?.values[2]).toBe(38142);
    await expect(repository.getReplicaRow(scope, 'test_items', '019d-bbbb')).resolves.toMatchObject({
      localId: '019d-bbbb',
      serverId: 38142,
      values: { title: 'Local item' },
    });
  });

  it('invalid/missing domain fieldsは拒否してrollbackする', async () => {
    const repository = createRepository();
    await repository.initialize();
    await expect(
      repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_items',
            localId: '019d-bbbb',
            serverId: null,
            values: { id: 0 },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
      }),
    ).rejects.toThrow('Replica row is missing required source key "title".');
    expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).not.toHaveBeenCalled();
    expect(storedReplicaRows['019d-bbbb']).toBeUndefined();
  });

  it('getReplicaRowはSQLite列をdecodeしてvaluesを返す', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          groupId: 10,
          sourceKey: 'test_items',
          localId: '019d-bbbb',
          serverId: null,
          values: { id: 0, title: 'Decoded title' },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 99,
          syncState: 'pending',
        },
      ],
    });
    await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-bbbb')).resolves.toMatchObject({
      values: { title: 'Decoded title' },
      fetchedAt: 99,
      syncState: 'pending',
    });
  });

  describe('getReplicaRows', () => {
    const baseRow = {
      sourceKey: 'test_items',
      serverId: null,
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending' as const,
    };

    it('local_id昇順で決定的に返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, groupId: 10, localId: '019d-cccc', values: { id: 0, title: 'C' } },
          { ...baseRow, userId: 1, groupId: 10, localId: '019d-aaaa', values: { id: 0, title: 'A' } },
          { ...baseRow, userId: 1, groupId: 10, localId: '019d-bbbb', values: { id: 0, title: 'B' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, groupId: 10 }, 'test_items');
      expect(rows.map((row) => row.localId)).toEqual(['019d-aaaa', '019d-bbbb', '019d-cccc']);
    });

    it('user-scoped sourceはgroupIdを無視して同一userの行を返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, groupId: 10, localId: '019d-aaaa', values: { id: 0, title: 'G10' } },
          { ...baseRow, userId: 1, groupId: 11, localId: '019d-bbbb', values: { id: 0, title: 'G11' } },
          { ...baseRow, userId: 2, groupId: 10, localId: '019d-cccc', values: { id: 0, title: 'Other user' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, groupId: 10 }, 'test_items');
      expect(rows.map((row) => row.localId)).toEqual(['019d-aaaa', '019d-bbbb']);
    });

    it('group-scoped sourceはgroupId一致の行だけを返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      const groupRow = {
        sourceKey: 'test_group_items',
        serverId: null,
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending' as const,
      };
      await repository.transactReplica({
        putRows: [
          { ...groupRow, userId: 1, groupId: 10, localId: '019d-aaaa', values: { id: 0, name: 'G10' } },
          { ...groupRow, userId: 1, groupId: 11, localId: '019d-bbbb', values: { id: 0, name: 'G11' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, groupId: 10 }, 'test_group_items');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.localId).toBe('019d-aaaa');
    });
  });

  describe('replica pull persistence', () => {
    const scope = { userId: 1, groupId: 10 };

    it('getReplicaRowByServerIdはuser scopeでgroupIdを無視してlookupする', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_items',
            localId: '019d-aaaa',
            serverId: 42,
            values: { id: 42, title: 'G10' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            groupId: 11,
            sourceKey: 'test_items',
            localId: '019d-bbbb',
            serverId: 43,
            values: { id: 43, title: 'G11' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 42)).resolves.toMatchObject({
        localId: '019d-aaaa',
      });
      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 43)).resolves.toMatchObject({
        localId: '019d-bbbb',
      });
      expect(await repository.getReplicaRowByServerId(scope, 'test_items', 99)).toBeNull();
    });

    it('getReplicaRowByServerIdはgroup scopeでgroupId一致のみ返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_group_items',
            localId: '019d-aaaa',
            serverId: 55,
            values: { id: 55, name: 'G10' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            groupId: 11,
            sourceKey: 'test_group_items',
            localId: '019d-bbbb',
            serverId: 56,
            values: { id: 56, name: 'G11' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRowByServerId(scope, 'test_group_items', 55)).resolves.toMatchObject({
        localId: '019d-aaaa',
      });
      expect(await repository.getReplicaRowByServerId(scope, 'test_group_items', 56)).toBeNull();
    });

    it('putCursorsはrow更新と同一SQLite transactionで原子的に永続化する', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_items',
            localId: '019d-aaaa',
            serverId: 42,
            values: { id: 42, title: 'Pulled' },
            confirmedValues: { id: 42, title: 'Pulled' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
        putCursors: [{ userId: 1, groupId: 10, cursor: 'cursor-v1' }],
      });

      expect(plugin.beginTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).toHaveBeenCalledOnce();
      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ userId: 1, groupId: 10, cursor: 'cursor-v1' });
      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 42)).resolves.toMatchObject({
        values: { title: 'Pulled' },
      });
    });

    it('row validation失敗時はcursorも永続化せずrollbackする', async () => {
      const repository = createRepository();
      await repository.initialize();
      await expect(
        repository.transactReplica({
          putRows: [
            {
              userId: 1,
              groupId: 10,
              sourceKey: 'test_items',
              localId: '019d-aaaa',
              serverId: 42,
              values: { id: 42 },
              confirmedValues: null,
              serverRevision: null,
              fetchedAt: 1,
              syncState: 'confirmed',
            },
          ],
          putCursors: [{ userId: 1, groupId: 10, cursor: 'cursor-v1' }],
        }),
      ).rejects.toThrow('Replica row is missing required source key "title".');
      expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).not.toHaveBeenCalled();
      expect(await repository.getReplicaCursor(scope)).toBeNull();
      expect(storedReplicaCursors['1:10']).toBeUndefined();
    });
  });

  describe('user-scope cross-group parity', () => {
    const scopeG10 = { userId: 1, groupId: 10 };
    const scopeG11 = { userId: 1, groupId: 11 };

    it('getReplicaRow/getReplicaRowByServerIdは別groupIdでも同一user rowを返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_items',
            localId: '019d-cross',
            serverId: 42,
            values: { id: 42, title: 'Shared user row' },
            confirmedValues: { id: 42, title: 'Shared user row' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRow(scopeG11, 'test_items', '019d-cross')).resolves.toMatchObject({
        localId: '019d-cross',
        groupId: 11,
      });
      await expect(repository.getReplicaRowByServerId(scopeG11, 'test_items', 42)).resolves.toMatchObject({
        localId: '019d-cross',
      });
    });

    it('clearGroupはuser-scoped rowを保持しgroup-scoped rowだけ削除する', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_items',
            localId: '019d-user',
            serverId: 42,
            values: { id: 42, title: 'User scoped' },
            confirmedValues: { id: 42, title: 'User scoped' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            groupId: 10,
            sourceKey: 'test_group_items',
            localId: '019d-group',
            serverId: 55,
            values: { id: 55, name: 'Group scoped' },
            confirmedValues: { id: 55, name: 'Group scoped' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await repository.clearGroup(scopeG10);

      await expect(repository.getReplicaRow(scopeG10, 'test_items', '019d-user')).resolves.toMatchObject({
        localId: '019d-user',
      });
      expect(await repository.getReplicaRow(scopeG10, 'test_group_items', '019d-group')).toBeNull();
    });
  });

  function createRepository(): SqliteOfflineRepository {
    TestBed.configureTestingModule({
      providers: [
        SqliteOfflineRepository,
        { provide: COMMUNITY_SQLITE, useValue: plugin },
        {
          provide: OFFLINE_KIT_OPTIONS,
          useValue: {
            databaseName: 'test-offline',
            createEncryptionKey: async () => 'secret',
            replicaSchema: replicaSchemaV1WithGroup,
          },
        },
      ],
    });
    return TestBed.inject(SqliteOfflineRepository);
  }
});
