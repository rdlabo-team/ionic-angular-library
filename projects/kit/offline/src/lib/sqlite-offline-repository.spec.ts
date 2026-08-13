/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  integer,
  localOnly,
  naturalKey,
  generatedId,
  sha256OfflineReplicaSchema,
  text,
  type OfflineReplicaSchemaBundle,
} from './offline-replica-schema';
import { canonicalOfflinePrincipalId, type OfflineCommand, type OfflineReplicaRow, type OfflineRepository } from './offline-repository';
import { OFFLINE_REPOSITORY_ATOMIC_MUTATION } from './offline-repository-concurrency';
import { generatedCommandIdentity, generatedReplicaIdentity, naturalReplicaIdentity } from './offline-test-helpers';
import {
  COMMUNITY_SQLITE,
  type CommunitySqliteConnection,
  type CommunitySqliteDatabase,
  type CommunitySqliteDriver,
  createCommunitySqliteDriver,
  createRandomOfflineEncryptionKey,
  SqliteOfflineRepository,
} from './sqlite-offline-repository';
import { OfflineStorageUnavailableError } from './offline-storage';
import { OFFLINE_SCHEMA_VERSION } from './offline-repository';

type TestItemSelect = { id: number; title: string };
type TestItemWithSubtitleSelect = { id: number; title: string; subtitle: string };
type LocalProjectionSelect = { feedKey: string };
type TextIdSelect = { id: string; title: string };

const testItemEntity = defineReplicaEntity<TestItemSelect>()({
  table: 'test_items',
  sourceKey: 'test_items',
  scope: 'user',
  fields: {
    id: generatedId('integer'),
    title: text(),
  },
});

const testItemWithSubtitleEntity = defineReplicaEntity<TestItemWithSubtitleSelect>()({
  table: 'test_items',
  sourceKey: 'test_items',
  scope: 'user',
  fields: {
    id: generatedId('integer'),
    title: text(),
    subtitle: text(),
  },
});

const testGroupItemEntity = defineReplicaEntity<{ id: number; name: string }>()({
  table: 'test_group_items',
  sourceKey: 'test_group_items',
  scope: 'partition',
  fields: {
    id: generatedId('integer'),
    name: text(),
  },
});

const localProjectionEntity = defineReplicaEntity<LocalProjectionSelect>()({
  table: 'local_projections',
  sourceKey: 'local_projections',
  scope: 'user',
  identity: localOnly(),
  fields: {
    feedKey: text(),
  },
});

const naturalFavoriteEntity = defineReplicaEntity<{ favFrom: number; favTo: string; label: string }>()({
  table: 'natural_favorites',
  sourceKey: 'natural_favorites',
  scope: 'partition',
  identity: naturalKey(['favFrom', 'favTo']),
  fields: { favFrom: integer(), favTo: text(), label: text() },
});

const textIdEntity = defineReplicaEntity<TextIdSelect>()({
  table: 'text_id_items',
  sourceKey: 'text_id_items',
  scope: 'user',
  fields: { id: generatedId('text'), title: text() },
});

const textIdSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [textIdEntity],
  migrations: [],
});

const naturalFavoriteSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [naturalFavoriteEntity],
  migrations: [],
});

const localProjectionSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [localProjectionEntity],
  migrations: [],
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

const replicaSchemaV3MissingMigration: OfflineReplicaSchemaBundle = {
  ...replicaSchemaV1,
  version: 3,
  migrations: [{ fromVersion: 1, statements: ['SELECT 1'], migrateWebRow: (row) => row }],
  schemaFingerprintInput: 'deliberately-invalid-missing-v2-to-v3-migration',
};

const replicaSchemaV1HashDrift = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemWithSubtitleEntity],
  migrations: [],
});

describe('createRandomOfflineEncryptionKey', () => {
  it('returns a fresh 256-bit lower-case hexadecimal key', async () => {
    const first = await createRandomOfflineEncryptionKey();
    const second = await createRandomOfflineEncryptionKey();

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
  });
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

  it('暗号化databaseのopen失敗をtyped storage_unavailableとしてcause付きで伝播する', async () => {
    const error = new Error('SQLCipher is not configured');
    plugin.open.mockRejectedValueOnce(error);
    const repository = createRepository();
    await expect(repository.initialize()).rejects.toSatisfy((thrown: unknown) => {
      expect(thrown).toBeInstanceOf(OfflineStorageUnavailableError);
      expect(thrown).toMatchObject({ reason: 'storage_unavailable', cause: error });
      return true;
    });
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

  it('partition scopeのcursorだけを単一transactionで削除しuser-scoped outboxを保持する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.clearScope({ userId: 7, scopeId: '8' });
    const deletes = plugin.execute.mock.calls
      .map(([options]) => options as { statement: string; values?: unknown[] })
      .filter(({ statement }) => statement.startsWith('DELETE FROM'));
    expect(deletes).toHaveLength(3);
    expect(deletes.map(({ values }) => values)).toEqual([
      [canonicalOfflinePrincipalId(7), '8'],
      [canonicalOfflinePrincipalId(7), '8'],
      [canonicalOfflinePrincipalId(7), '8'],
    ]);
    expect(plugin.beginTransaction).toHaveBeenCalledOnce();
    expect(plugin.commitTransaction).toHaveBeenCalledOnce();
    expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('別SQLite connectionのcommitをwrite lock取得後に検出し、product callbackを再実行しない', async () => {
    let dataVersion = 1;
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[dataVersion]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();
    const operation = vi.fn(async (owner: OfflineRepository) => {
      await owner.getCommands({ userId: 1, scopeId: '10' });
      dataVersion = 2;
      await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'stale' }] });
    });

    await expect(repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(operation)).rejects.toThrow('changed through another SQLite connection');

    expect(operation).toHaveBeenCalledOnce();
    expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
    expect(
      plugin.execute.mock.calls.some(([options]) =>
        String((options as { statement: string }).statement).includes('INSERT INTO offline_replica_cursors'),
      ),
    ).toBe(false);
  });

  it('guarded commitはwrite lockをrevision確認より先に取得し、確認後にreplica mutationを適用する', async () => {
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[1]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();

    await repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(async (owner) => {
      await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'fresh' }] });
    });

    const lockCall = plugin.execute.mock.calls.find(([options]) =>
      String((options as { statement: string }).statement).startsWith('UPDATE offline_metadata SET schema_version'),
    );
    const revisionCall = plugin.query.mock.calls
      .filter(([options]) => (options as { statement: string }).statement === 'PRAGMA data_version')
      .at(1);
    const cursorCall = plugin.execute.mock.calls.find(([options]) =>
      String((options as { statement: string }).statement).includes('INSERT INTO offline_replica_cursors'),
    );
    expect(lockCall).toBeDefined();
    expect(revisionCall).toBeDefined();
    expect(cursorCall).toBeDefined();
    expect(lockCall![0]).toBeDefined();
    expect(plugin.execute.mock.invocationCallOrder[plugin.execute.mock.calls.indexOf(lockCall!)]).toBeLessThan(
      plugin.query.mock.invocationCallOrder[plugin.query.mock.calls.indexOf(revisionCall!)]!,
    );
    expect(plugin.query.mock.invocationCallOrder[plugin.query.mock.calls.indexOf(revisionCall!)]).toBeLessThan(
      plugin.execute.mock.invocationCallOrder[plugin.execute.mock.calls.indexOf(cursorCall!)]!,
    );
  });

  it('guarded writeのcommit後にexternal revisionが進んでも完了済みproduct operationを失敗扱いにしない', async () => {
    let dataVersion = 1;
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[dataVersion]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();

    await expect(
      repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(async (owner) => {
        await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'committed' }] });
        dataVersion = 2;
      }),
    ).resolves.toBeUndefined();

    expect(
      plugin.query.mock.calls.filter(([options]) => (options as { statement: string }).statement === 'PRAGMA data_version'),
    ).toHaveLength(2);
  });

  it('同一operation内の2回目のtransactionもexternal revisionを再確認する', async () => {
    let dataVersion = 1;
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[dataVersion]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();

    await expect(
      repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(async (owner) => {
        await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'first' }] });
        dataVersion = 2;
        await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'stale-second' }] });
      }),
    ).rejects.toThrow('changed through another SQLite connection');

    expect(plugin.commitTransaction).toHaveBeenCalledTimes(2);
    expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
  });

  it('atomic owner以外のwriteをatomic operation完了後まで待機させる', async () => {
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[1]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();
    await repository.initialize();
    plugin.execute.mockClear();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ownerCommitted = false;
    let externalCommitted = false;
    let external: Promise<void> = Promise.resolve();

    const atomic = repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(async (owner) => {
      external = repository
        .putCommand({
          userId: 1,
          scopeId: '10',
          commandId: 'external',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-external' },
          operation: 'test_items.update',
          payload: {},
          baseRevision: null,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 2,
          lastErrorCode: null,
        })
        .then(() => {
          externalCommitted = true;
        });
      await owner.transactReplica({ putCursors: [{ userId: 1, scopeId: '10', cursor: 'owner' }] });
      ownerCommitted = true;
      await gate;
    });

    await vi.waitFor(() => expect(ownerCommitted).toBe(true));
    expect(externalCommitted).toBe(false);
    release();
    await atomic;
    await external;
    expect(externalCommitted).toBe(true);
  });

  it('snapshot callbackからrepository本体を再入しても同じsnapshotで完了する', async () => {
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement === 'PRAGMA data_version') return { columns: ['data_version'], rows: [[1]] };
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    const repository = createRepository();
    await repository.initialize();

    await expect(
      repository[OFFLINE_REPOSITORY_ATOMIC_MUTATION]!(async (owner) =>
        owner.runReadSnapshot(() => repository.getCommands({ userId: 1, scopeId: '10' })),
      ),
    ).resolves.toEqual([]);
  });

  it('pull attentionをput/getしtransactionでupsertする', async () => {
    const repository = createRepository();
    await repository.initialize();
    expect(plugin.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: expect.stringContaining('CREATE TABLE IF NOT EXISTS offline_pull_attentions'),
      }),
    );
    await repository.putPullAttention!({
      userId: 1,
      scopeId: '10',
      reason: 'schema_upgrade_required',
    });
    expect(plugin.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: expect.stringContaining('INSERT INTO offline_pull_attentions'),
        values: [canonicalOfflinePrincipalId(1), '10', 'schema_upgrade_required', null],
      }),
    );
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
      if (statement.includes('offline_pull_attentions')) {
        return {
          columns: ['scope_id', 'reason', 'status'],
          rows: [['10', 'schema_upgrade_required', null]],
        };
      }
      if (statement.includes('offline_replica_schema_metadata')) {
        return {
          columns: ['version', 'schema_hash'],
          rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
        };
      }
      if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
      return { rows: [] };
    });
    await expect(repository.getPullAttentions!(1)).resolves.toEqual([{ userId: 1, scopeId: '10', reason: 'schema_upgrade_required' }]);
    await expect(repository.runReadSnapshot((reader) => reader.getPullAttentions!(1))).resolves.toEqual([
      { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
    ]);
    await repository.transactReplica({
      putPullAttentions: [{ userId: 1, scopeId: '10', reason: 'authorization_required', status: 401 }],
      removePullAttentions: [{ userId: 1, scopeId: '20' }],
    });
    expect(plugin.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: expect.stringContaining('INSERT INTO offline_pull_attentions'),
        values: [canonicalOfflinePrincipalId(1), '10', 'authorization_required', 401],
      }),
    );
    expect(plugin.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: 'DELETE FROM offline_pull_attentions WHERE user_id = ? AND scope_id = ?',
        values: [canonicalOfflinePrincipalId(1), '20'],
      }),
    );
    plugin.execute.mockClear();
    await repository.clearUser(1);
    expect(plugin.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        statement: 'DELETE FROM offline_pull_attentions WHERE user_id = ?',
        values: [canonicalOfflinePrincipalId(1)],
      }),
    );
  });

  it('getCommandsはcreated_atとcommand_id昇順でSQL ORDER BYする', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.putCommand({
      userId: 1,
      scopeId: '10',
      commandId: 'cmd-z',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'test_items.update',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 10,
      lastErrorCode: null,
    });
    await repository.putCommand({
      userId: 1,
      scopeId: '10',
      commandId: 'cmd-a',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'test_items.update',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 10,
      lastErrorCode: null,
    });

    await repository.getCommands({ userId: 1, scopeId: '10' });
    await repository.getCommandsForUser(1);

    const scopeQuery = plugin.query.mock.calls.find(([options]) => {
      const statement = (options as { statement: string }).statement;
      return statement === 'SELECT * FROM offline_sync_commands WHERE user_id = ? AND scope_id = ? ORDER BY created_at ASC, command_id ASC';
    })?.[0] as { statement: string } | undefined;
    const userQuery = plugin.query.mock.calls.find(([options]) => {
      const statement = (options as { statement: string }).statement;
      return statement === 'SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC';
    })?.[0] as { statement: string } | undefined;
    expect(scopeQuery?.statement).toBe(
      'SELECT * FROM offline_sync_commands WHERE user_id = ? AND scope_id = ? ORDER BY created_at ASC, command_id ASC',
    );
    expect(userQuery?.statement).toBe('SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC');
  });

  it('delete command persists replica_mutation and satisfies the released v2 payload_hash column', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.putCommand({
      userId: 1,
      scopeId: '10',
      commandId: 'delete-command',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'delete-uuid' },
      operation: 'test_items.delete',
      payload: { id: 42 },
      baseRevision: 4,
      replicaMutation: 'delete',
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });

    const insert = plugin.execute.mock.calls
      .map(([options]) => options as { statement: string; values?: unknown[] })
      .find(({ statement }) => statement.startsWith('INSERT INTO offline_sync_commands'));
    expect(insert?.statement).toContain('replica_mutation');
    expect(insert?.values).toContain('delete');
    expect(insert?.statement).toContain('payload_hash');
    expect(insert?.values?.[10]).toBe('');
  });

  it('persists and restores declared localOnly footprint keys', async () => {
    const repository = createRepository();
    await repository.initialize();
    const companion = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'local_projections',
      identity: { kind: 'local' as const, localId: 'view-1' },
    };
    const command: OfflineCommand = {
      userId: 1,
      scopeId: '10',
      commandId: 'prepared-command',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'prepared-local' },
      operation: 'test_items.update',
      payload: { title: 'Optimistic' },
      localOnlyFootprint: [companion],
      baseRevision: 1,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
      reconciliationIdentity: { remoteId: 42 },
    };
    await repository.putCommand(command);
    const insert = plugin.execute.mock.calls
      .map(([options]) => options as { statement: string; values?: unknown[] })
      .find(({ statement }) => statement.startsWith('INSERT INTO offline_sync_commands'));
    expect(insert?.statement).toContain('local_only_footprint_json');
    expect(insert?.values).toContain(JSON.stringify([companion]));
    expect(insert?.statement).toContain('reconciliation_identity_json');
    expect(insert?.values).toContain(JSON.stringify(command.reconciliationIdentity));

    const sqliteRow = {
      command_id: command.commandId,
      user_id: 'n:1',
      scope_id: command.scopeId,
      aggregate_type: command.aggregateType,
      source_key: command.sourceKey,
      identity_json: JSON.stringify(command.identity),
      operation: command.operation,
      payload_json: JSON.stringify(command.payload),
      local_only_footprint_json: JSON.stringify([companion]),
      replica_mutation: 'upsert',
      base_revision_json: JSON.stringify(command.baseRevision),
      state: command.state,
      attempts: command.attempts,
      retry_at: command.retryAt,
      created_at: command.createdAt,
      last_error_code: command.lastErrorCode,
      server_commit_unknown: 0,
      reconciliation_identity_json: JSON.stringify(command.reconciliationIdentity),
    };
    plugin.query.mockResolvedValueOnce({ rows: [sqliteRow] });
    await expect(repository.getCommands({ userId: 1, scopeId: '10' })).resolves.toEqual([
      expect.objectContaining({
        localOnlyFootprint: [companion],
        reconciliationIdentity: { remoteId: 42 },
      }),
    ]);
    plugin.query.mockResolvedValueOnce({ rows: [{ ...sqliteRow, local_only_footprint_json: null }] });
    await expect(repository.getCommands({ userId: 1, scopeId: '10' })).resolves.toEqual([
      expect.not.objectContaining({ localOnlyFootprint: expect.anything() }),
    ]);
  });

  it('replicaとoutboxを単一transactionで更新する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          scopeId: '10',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-aaaa', remoteId: null },
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

      await expect(repository.initialize()).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(OfflineStorageUnavailableError);
        expect(error).toMatchObject({
          reason: 'replica_schema_mismatch',
        });
        expect((error as Error).message).toContain('Offline replica schema hash mismatch at version 1');
        return true;
      });
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

      await expect(repository.initialize()).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(OfflineStorageUnavailableError);
        expect(error).toMatchObject({
          reason: 'migration_missing',
          message: 'Missing offline replica schema migration from version 2 to 3.',
        });
        return true;
      });
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

      await expect(repository.initialize()).rejects.toSatisfy((thrown: unknown) => {
        expect(thrown).toBeInstanceOf(OfflineStorageUnavailableError);
        expect(thrown).toMatchObject({ reason: 'storage_unavailable', cause: error });
        return true;
      });
      expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
      expect(
        plugin.execute.mock.calls.some(([options]) => {
          const call = options as { statement: string; values?: unknown[] };
          return call.statement.includes('offline_replica_schema_metadata') && call.values?.[0] === 2;
        }),
      ).toBe(false);
    });

    it('maps typed initialization failure reasons without deleting storage', async () => {
      const cases: {
        name: string;
        reason: OfflineStorageUnavailableError['reason'];
        arrange: () => void;
        options?: { replicaSchema?: OfflineReplicaSchemaBundle; createEncryptionKey?: () => Promise<string> };
        messageIncludes: string;
      }[] = [
        {
          name: 'encryption_key_unavailable',
          reason: 'encryption_key_unavailable',
          arrange: () => {
            plugin.open.mockImplementation(async (options: { createEncryptionKey?: () => Promise<string> }) => {
              await options.createEncryptionKey?.();
              return { databaseId: 'offline-db' };
            });
          },
          options: {
            createEncryptionKey: async () => {
              throw new Error('keychain denied');
            },
          },
          messageIncludes: 'keychain denied',
        },
        {
          name: 'core_schema_incompatible',
          reason: 'core_schema_incompatible',
          arrange: () => {
            plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
              if (statement.includes('offline_replica_schema_metadata')) {
                return {
                  columns: ['version', 'schema_hash'],
                  rows: [[replicaSchemaV1.version, replicaSchemaV1Hash]],
                };
              }
              if (statement.includes('offline_metadata') && statement.includes('schema_version')) {
                return { rows: [{ schema_version: OFFLINE_SCHEMA_VERSION + 99 }] };
              }
              if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
              return { rows: [] };
            });
          },
          messageIncludes: 'Unsupported offline storage schema version',
        },
        {
          name: 'replica_schema_mismatch (hash drift)',
          reason: 'replica_schema_mismatch',
          arrange: () => {
            storedReplicaMetadata = {
              version: replicaSchemaV1.version,
              schemaHash: replicaSchemaV1Hash,
            };
          },
          options: { replicaSchema: replicaSchemaV1HashDrift },
          messageIncludes: 'Offline replica schema hash mismatch',
        },
        {
          name: 'replica_schema_mismatch (newer stored version)',
          reason: 'replica_schema_mismatch',
          arrange: () => {
            storedReplicaMetadata = {
              version: 9,
              schemaHash: replicaSchemaV1Hash,
            };
          },
          messageIncludes: 'newer than application version',
        },
        {
          name: 'migration_missing',
          reason: 'migration_missing',
          arrange: () => {
            storedReplicaMetadata = {
              version: replicaSchemaV1.version,
              schemaHash: replicaSchemaV1Hash,
            };
          },
          options: { replicaSchema: replicaSchemaV3MissingMigration },
          messageIncludes: 'Missing offline replica schema migration',
        },
        {
          name: 'storage_unavailable',
          reason: 'storage_unavailable',
          arrange: () => {
            plugin.open.mockRejectedValueOnce(new Error('native plugin missing'));
          },
          messageIncludes: 'native plugin missing',
        },
      ];

      for (const testCase of cases) {
        TestBed.resetTestingModule();
        storedReplicaMetadata = {
          version: replicaSchemaV1.version,
          schemaHash: replicaSchemaV1Hash,
        };
        plugin.open.mockReset();
        plugin.open.mockImplementation(async () => ({ databaseId: 'offline-db' }));
        plugin.execute.mockClear();
        plugin.beginTransaction.mockClear();
        plugin.commitTransaction.mockClear();
        plugin.rollbackTransaction.mockClear();
        plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
          if (statement.includes('offline_replica_schema_metadata')) {
            if (!storedReplicaMetadata) return { rows: [] };
            return {
              columns: ['version', 'schema_hash'],
              rows: [[storedReplicaMetadata.version, storedReplicaMetadata.schemaHash]],
            };
          }
          if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
          return { rows: [] };
        });
        testCase.arrange();
        const repository = createRepository(testCase.options?.createEncryptionKey, {
          replicaSchema: testCase.options?.replicaSchema,
        });

        await expect(repository.initialize(), testCase.name).rejects.toSatisfy((error: unknown) => {
          expect(error, testCase.name).toBeInstanceOf(OfflineStorageUnavailableError);
          expect(error, testCase.name).toMatchObject({ reason: testCase.reason });
          expect((error as Error).message, testCase.name).toContain(testCase.messageIncludes);
          return true;
        });
        expect(
          plugin.execute.mock.calls.some(([options]) =>
            (options as { statement: string }).statement.startsWith('DELETE FROM offline_sync_commands'),
          ),
          testCase.name,
        ).toBe(false);
      }
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
    '_offline_visibility',
    '_offline_fetched_at',
    'title',
  ];

  const testGroupItemColumns = [
    'local_id',
    '_offline_user_id',
    '_offline_scope_id',
    'server_id',
    '_offline_confirmed_json',
    '_offline_server_revision_json',
    '_offline_sync_state',
    '_offline_visibility',
    '_offline_fetched_at',
    'name',
  ];

  const localProjectionColumns = [
    'local_id',
    '_offline_user_id',
    '_offline_confirmed_json',
    '_offline_server_revision_json',
    '_offline_sync_state',
    '_offline_visibility',
    '_offline_fetched_at',
    'feed_key',
  ];
  const naturalFavoriteColumns = [
    '_offline_user_id',
    '_offline_scope_id',
    '_offline_confirmed_json',
    '_offline_server_revision_json',
    '_offline_sync_state',
    '_offline_visibility',
    '_offline_fetched_at',
    'fav_from',
    'fav_to',
    'label',
  ];

  function replicaRowMatrix(tableName: string, stored: { values: unknown[] }): unknown[] {
    return tableName === 'test_group_items' ? [...stored.values] : [...stored.values];
  }

  function generatedStoredRowKey(tableName: string, values: readonly unknown[]): string {
    return `${tableName}:${String(values[1])}:${tableName === 'test_group_items' ? String(values[2]) : 'user'}:${String(values[0])}`;
  }

  function storedGeneratedRow(localId: string, tableName = 'test_items') {
    return Object.values(storedReplicaRows).find((stored) => stored.tableName === tableName && stored.values[0] === localId);
  }

  function queryStoredReplicaRows(tableName: string, statement: string, values?: unknown[]) {
    const columns =
      tableName === 'test_group_items'
        ? testGroupItemColumns
        : tableName === 'natural_favorites'
          ? naturalFavoriteColumns
          : tableName === 'local_projections'
            ? localProjectionColumns
            : testItemColumns;
    const entries = Object.entries(storedReplicaRows).filter(([, stored]) => stored.tableName === tableName);
    if (statement.includes('server_id = ?')) {
      const remoteId = values?.[0];
      const userId = values?.[1];
      const scopeId = tableName === 'test_group_items' ? values?.[2] : undefined;
      const stored = Object.entries(storedReplicaRows).find(([, row]) => {
        if (row.tableName !== tableName) return false;
        const remoteIdIndex = tableName === 'test_group_items' ? 3 : 2;
        if (row.values[remoteIdIndex] !== remoteId || row.values[1] !== userId) return false;
        if (scopeId !== undefined && row.values[2] !== scopeId) return false;
        return true;
      });
      if (!stored) return { rows: [] };
      return { columns, rows: [replicaRowMatrix(tableName, stored[1])] };
    }
    if (statement.includes('local_id = ?')) {
      const localId = values?.[tableName === 'test_group_items' ? 2 : 1];
      const userId = values?.[0];
      const scopeId = tableName === 'test_group_items' ? values?.[1] : undefined;
      const stored = Object.values(storedReplicaRows).find(
        (candidate) =>
          candidate.tableName === tableName &&
          candidate.values[0] === localId &&
          candidate.values[1] === userId &&
          (scopeId === undefined || candidate.values[2] === scopeId),
      );
      if (!stored || stored.tableName !== tableName) return { rows: [] };
      return { columns, rows: [replicaRowMatrix(tableName, stored)] };
    }
    if (tableName === 'natural_favorites' && statement.includes('fav_from = ?')) {
      const stored = entries.find(
        ([, row]) =>
          row.values[0] === values?.[0] &&
          row.values[1] === values?.[1] &&
          row.values.at(-3) === values?.[2] &&
          row.values.at(-2) === values?.[3],
      );
      return stored ? { columns, rows: [replicaRowMatrix(tableName, stored[1])] } : { rows: [] };
    }
    const userId = values?.[0];
    const scopeId = tableName === 'test_group_items' ? values?.[1] : undefined;
    const rows = entries
      .filter(([, stored]) => {
        if (stored.values[1] !== userId) return false;
        if (scopeId !== undefined && stored.values[2] !== scopeId) return false;
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
          const scopeId = values?.[1];
          const cursor = values?.[2];
          if (typeof userId === 'string' && typeof scopeId === 'string' && typeof cursor === 'string') {
            storedReplicaCursors[`${userId}:${scopeId}`] = cursor;
          }
        }
        if (statement.startsWith('DELETE FROM offline_replica_cursors')) {
          const userId = values?.[0];
          const scopeId = values?.[1];
          if (typeof userId === 'string' && scopeId === undefined) {
            for (const key of Object.keys(storedReplicaCursors)) {
              if (key.startsWith(`${userId}:`)) delete storedReplicaCursors[key];
            }
          } else if (typeof userId === 'string' && typeof scopeId === 'string') {
            delete storedReplicaCursors[`${userId}:${scopeId}`];
          }
        }
        for (const tableName of ['test_items', 'test_group_items', 'local_projections', 'natural_favorites', 'text_id_items'] as const) {
          if (statement.startsWith(`INSERT INTO ${tableName}`)) {
            if (tableName !== 'natural_favorites' && tableName !== 'local_projections') {
              const remoteIdIndex = tableName === 'test_group_items' ? 3 : 2;
              const remoteId = values?.[remoteIdIndex];
              const collision = Object.values(storedReplicaRows).some(
                (stored) =>
                  stored.tableName === tableName &&
                  stored.values[remoteIdIndex] === remoteId &&
                  remoteId != null &&
                  stored.values[1] === values?.[1] &&
                  (tableName !== 'test_group_items' || stored.values[2] === values?.[2]) &&
                  stored.values[0] !== values?.[0],
              );
              if (collision) throw new Error(`UNIQUE constraint failed: ${tableName}.server_id`);
            }
            const rowKey =
              tableName === 'natural_favorites'
                ? `natural:${JSON.stringify([values?.[0], values?.[1], values?.at(-3), values?.at(-2)])}`
                : generatedStoredRowKey(tableName, values ?? []);
            if (typeof rowKey === 'string') storedReplicaRows[rowKey] = { tableName, statement, values: [...(values ?? [])] };
          }
          if (statement.startsWith(`DELETE FROM ${tableName}`)) {
            const userId = values?.[0];
            const scopeId = values?.[1];
            if (
              statement.includes('_offline_user_id = ? AND _offline_scope_id = ?') &&
              typeof userId === 'string' &&
              typeof scopeId === 'string'
            ) {
              for (const [localId, stored] of Object.entries(storedReplicaRows)) {
                if (stored.tableName !== tableName) continue;
                if (stored.values[1] === userId && stored.values[2] === scopeId) {
                  delete storedReplicaRows[localId];
                }
              }
              continue;
            }
            const localId = values?.at(-1);
            for (const [storedKey, stored] of Object.entries(storedReplicaRows)) {
              if (stored.tableName !== tableName || stored.values[0] !== localId || stored.values[1] !== userId) continue;
              if (tableName === 'test_group_items' && stored.values[2] !== scopeId) continue;
              delete storedReplicaRows[storedKey];
            }
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
          const scopeId = values?.[1];
          const cursor =
            typeof userId === 'string' && typeof scopeId === 'string' ? storedReplicaCursors[`${userId}:${scopeId}`] : undefined;
          return cursor === undefined ? { rows: [] } : { columns: ['cursor'], rows: [[cursor]] };
        }
        for (const tableName of ['test_items', 'test_group_items', 'local_projections', 'natural_favorites', 'text_id_items'] as const) {
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
          scopeId: '10',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-bbbb', remoteId: null },
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
          scopeId: '10',
          commandId: 'create-row-1',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-bbbb' },
          operation: 'test_items.create',
          payload: { title: 'Local item' },
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
    expect(upsert?.statement).toContain('ON CONFLICT(_offline_user_id, local_id)');
    expect(upsert?.values).toEqual(['019d-bbbb', canonicalOfflinePrincipalId(1), null, null, null, 'pending', 'present', 1, 'Local item']);
    expect(
      plugin.execute.mock.calls.some(([options]) =>
        (options as { statement: string }).statement.startsWith('INSERT INTO offline_sync_commands'),
      ),
    ).toBe(true);
  });

  it('local-only projectionをserver_idなしのDDL/SQLでround-tripしremoteId lookupはnullを返す', async () => {
    storedReplicaMetadata = null;
    const repository = createRepository(localProjectionSchema);
    await repository.initialize();
    const createTable = plugin.execute.mock.calls.find(([options]) =>
      (options as { statement: string }).statement.startsWith('CREATE TABLE IF NOT EXISTS local_projections'),
    )?.[0] as { statement: string } | undefined;
    expect(createTable?.statement).not.toContain('server_id');

    const scope = { userId: 1, scopeId: '10' };
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'local_projections',
          identity: { kind: 'local', localId: 'feed-home' },
          values: { feedKey: 'home' },
          confirmedValues: { feedKey: 'home' },
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });

    const upsert = plugin.execute.mock.calls.find(([options]) =>
      (options as { statement: string }).statement.startsWith('INSERT INTO local_projections'),
    )?.[0] as { statement: string } | undefined;
    expect(upsert?.statement).not.toContain('server_id');
    await expect(repository.getReplicaRows(scope, 'local_projections')).resolves.toEqual([
      expect.objectContaining({
        identity: { kind: 'local', localId: 'feed-home' },
        values: { feedKey: 'home' },
      }),
    ]);
    await expect(repository.getReplicaRowByRemoteId(scope, 'local_projections', 1)).resolves.toBeNull();
    expect(
      plugin.query.mock.calls.some(
        ([options]) =>
          (options as { statement: string }).statement.includes('FROM local_projections') &&
          (options as { statement: string }).statement.includes('server_id = ?'),
      ),
    ).toBe(false);
  });

  it('local-only projectionへgenerated identityを渡すとrejectする', async () => {
    storedReplicaMetadata = {
      version: localProjectionSchema.version,
      schemaHash: await sha256OfflineReplicaSchema(localProjectionSchema),
    };
    const repository = createRepository(localProjectionSchema);
    await repository.initialize();
    await expect(
      repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'local_projections',
            identity: { kind: 'generated', localId: 'feed-home', remoteId: 1 },
            values: { feedKey: 'home' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
      }),
    ).rejects.toThrow('Offline replica source "local_projections" requires local identity.');
    expect(storedGeneratedRow('feed-home', 'local_projections')).toBeUndefined();
  });

  it('confirmed JSONはremoteId列を投影したdomain valuesだけを永続化する', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          scopeId: '10',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-confirmed', remoteId: 42 },
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
    await expect(repository.getReplicaRowByRemoteId({ userId: 1, scopeId: '10' }, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Optimistic' },
      confirmedValues: { title: 'Confirmed' },
    });
  });

  it('server_idはnullから38142へ更新されlocal_idは不変', async () => {
    const repository = createRepository();
    await repository.initialize();
    const scope = { userId: 1, scopeId: '10' };
    const baseRow = {
      ...scope,
      sourceKey: 'test_items' as const,
      identity: generatedReplicaIdentity('019d-bbbb', null),
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending' as const,
    };
    await repository.transactReplica({
      putRows: [{ ...baseRow, values: { id: 0, title: 'Local item' } }],
    });
    await repository.transactReplica({
      putRows: [
        {
          ...baseRow,
          identity: generatedReplicaIdentity('019d-bbbb', 38142),
          values: { id: 38142, title: 'Local item' },
          syncState: 'confirmed',
        },
      ],
    });

    const stored = storedGeneratedRow('019d-bbbb');
    expect(stored?.values[0]).toBe('019d-bbbb');
    expect(stored?.values[2]).toBe(38142);
    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-bbbb'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 38142 },
      values: { title: 'Local item' },
    });
  });

  it('TEXT generated idをSQLiteでnullからUUIDへ割り当て、lookup・collision・restartを保つ', async () => {
    storedReplicaMetadata = {
      version: textIdSchema.version,
      schemaHash: await sha256OfflineReplicaSchema(textIdSchema),
    };
    let repository = createRepository(textIdSchema);
    await repository.initialize();
    const scope = { userId: 1, scopeId: '10' };
    const localId = 'text-local-id';
    const remoteId = '018f6f6e-74ad-7cc4-b94f-4af0b13c4401';
    const row = (nextRemoteId: string | null, nextLocalId = localId): OfflineReplicaRow => ({
      ...scope,
      sourceKey: 'text_id_items',
      identity: generatedReplicaIdentity(nextLocalId, nextRemoteId),
      values: { id: nextRemoteId ?? '', title: nextLocalId },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    });
    await repository.transactReplica({ putRows: [row(null)] });
    await repository.transactReplica({ putRows: [row(remoteId)] });
    await expect(repository.getReplicaRowByRemoteId(scope, 'text_id_items', remoteId)).resolves.toMatchObject({
      identity: { kind: 'generated', localId, remoteId },
    });
    await expect(repository.transactReplica({ putRows: [row(remoteId, 'another-local-id')] })).rejects.toThrow('UNIQUE constraint failed');
    await expect(repository.getReplicaRowByRemoteId(scope, 'text_id_items', 42)).rejects.toThrow(
      'generated remote id must be a non-empty string',
    );

    TestBed.resetTestingModule();
    repository = createRepository(textIdSchema);
    await repository.initialize();
    await expect(repository.getReplicaRowByRemoteId(scope, 'text_id_items', remoteId)).resolves.toMatchObject({
      identity: { kind: 'generated', localId, remoteId },
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
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-bbbb', remoteId: null },
            values: { id: 0 },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
      }),
    ).rejects.toThrow('Replica row is missing required source key "title".');
    expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
    expect(plugin.commitTransaction).not.toHaveBeenCalled();
    expect(storedGeneratedRow('019d-bbbb')).toBeUndefined();
  });

  it('getReplicaRowはSQLite列をdecodeしてvaluesを返す', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          scopeId: '10',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-bbbb', remoteId: null },
          values: { id: 0, title: 'Decoded title' },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 99,
          syncState: 'pending',
        },
      ],
    });
    await expect(
      repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-bbbb')),
    ).resolves.toMatchObject({
      values: { title: 'Decoded title' },
      fetchedAt: 99,
      syncState: 'pending',
    });
  });

  describe('getReplicaRows', () => {
    const baseRow = {
      sourceKey: 'test_items' as const,
      identity: generatedReplicaIdentity('placeholder', null),
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
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-cccc', null), values: { id: 0, title: 'C' } },
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-aaaa', null), values: { id: 0, title: 'A' } },
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-bbbb', null), values: { id: 0, title: 'B' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'test_items');
      expect(rows.map((row) => (row.identity.kind === 'generated' ? row.identity.localId : ''))).toEqual([
        '019d-aaaa',
        '019d-bbbb',
        '019d-cccc',
      ]);
    });

    it('user-scoped sourceはscopeIdを無視して同一userの行を返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-aaaa', null), values: { id: 0, title: 'G10' } },
          { ...baseRow, userId: 1, scopeId: '11', identity: generatedReplicaIdentity('019d-bbbb', null), values: { id: 0, title: 'G11' } },
          {
            ...baseRow,
            userId: 2,
            scopeId: '10',
            identity: generatedReplicaIdentity('019d-cccc', null),
            values: { id: 0, title: 'Other user' },
          },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'test_items');
      expect(rows.map((row) => (row.identity.kind === 'generated' ? row.identity.localId : ''))).toEqual(['019d-aaaa', '019d-bbbb']);
    });

    it('partition-scoped sourceはscopeId一致の行だけを返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      const groupRow = {
        sourceKey: 'test_group_items' as const,
        identity: generatedReplicaIdentity('placeholder', null),
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending' as const,
      };
      await repository.transactReplica({
        putRows: [
          { ...groupRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-aaaa', null), values: { id: 0, name: 'G10' } },
          { ...groupRow, userId: 1, scopeId: '11', identity: generatedReplicaIdentity('019d-bbbb', null), values: { id: 0, name: 'G11' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'test_group_items');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.identity).toEqual({ kind: 'generated', localId: '019d-aaaa', remoteId: null });
      const partitionUpserts = plugin.execute.mock.calls
        .map(([options]) => options as { statement: string })
        .filter(({ statement }) => statement.startsWith('INSERT INTO test_group_items'));
      expect(partitionUpserts).toHaveLength(2);
      expect(partitionUpserts[0]?.statement).toContain('ON CONFLICT(_offline_user_id, _offline_scope_id, local_id)');
    });

    it('同じlocalIdを別principalと別partitionで共存させclearScopeを分離する', async () => {
      const repository = createRepository();
      await repository.initialize();
      const localId = 'same-local-id';
      const common = {
        identity: generatedReplicaIdentity(localId, null),
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending' as const,
      };
      await repository.transactReplica({
        putRows: [
          { ...common, sourceKey: 'test_items', userId: 1, scopeId: '10', values: { id: 0, title: 'User 1' } },
          { ...common, sourceKey: 'test_items', userId: 2, scopeId: '10', values: { id: 0, title: 'User 2' } },
          { ...common, sourceKey: 'test_group_items', userId: 1, scopeId: '10', values: { id: 0, name: 'Group 10' } },
          { ...common, sourceKey: 'test_group_items', userId: 1, scopeId: '11', values: { id: 0, name: 'Group 11' } },
        ],
      });

      await expect(
        repository.getReplicaRow({ userId: 2, scopeId: '10' }, 'test_items', generatedCommandIdentity(localId)),
      ).resolves.toMatchObject({ values: { title: 'User 2' } });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '11' }, 'test_group_items', generatedCommandIdentity(localId)),
      ).resolves.toMatchObject({ values: { name: 'Group 11' } });

      await repository.clearScope({ userId: 1, scopeId: '10' });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '11' }, 'test_group_items', generatedCommandIdentity(localId)),
      ).resolves.toMatchObject({ values: { name: 'Group 11' } });
      await expect(
        repository.getReplicaRow({ userId: 2, scopeId: '10' }, 'test_items', generatedCommandIdentity(localId)),
      ).resolves.toMatchObject({ values: { title: 'User 2' } });
    });

    it('standalone getReplicaRowsはreader leaseを保持し、完了までwriterを開始せずrollbackを漏らさない', async () => {
      const repository = createRepository();
      await repository.initialize();
      const scope = { userId: 1 as const, scopeId: '10' };
      const row: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'test_items',
        identity: generatedReplicaIdentity('019d-lease-read', 50),
        values: { id: 50, title: 'Before' },
        confirmedValues: { id: 50, title: 'Before' },
        serverRevision: 1,
        fetchedAt: 1,
        syncState: 'confirmed',
      };
      await repository.transactReplica({ putRows: [row] });

      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let announceRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve;
      });
      let deferRowsQuery = true;
      const originalQuery = plugin.query.getMockImplementation() as (options: {
        statement: string;
        values?: unknown[];
      }) => Promise<unknown>;
      plugin.query.mockImplementation(async (options: { statement: string; values?: unknown[] }) => {
        if (deferRowsQuery && options.statement.startsWith('SELECT * FROM test_items')) {
          deferRowsQuery = false;
          announceRead();
          await readGate;
        }
        return originalQuery(options);
      });

      plugin.execute.mockClear();
      const read = repository.getReplicaRows(scope, 'test_items');
      await readStarted;

      let writeFinished = false;
      const write = repository
        .putCommand({
          userId: 1,
          scopeId: '10',
          commandId: 'cmd-after-lease-read',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-lease-read' },
          operation: 'test_items.update',
          payload: {},
          baseRevision: null,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        })
        .then(() => {
          writeFinished = true;
        });
      void write.then(
        () => undefined,
        () => undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(writeFinished).toBe(false);
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          String((options as { statement: string }).statement).includes('INSERT INTO offline_sync_commands'),
        ),
      ).toBe(false);

      releaseRead();
      await expect(read).resolves.toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'Before' }) })]);
      await write;
      expect(writeFinished).toBe(true);

      const originalExecute = plugin.execute.getMockImplementation() as (options: {
        statement: string;
        values?: unknown[];
      }) => Promise<unknown>;
      plugin.execute.mockImplementation(async (options: { statement: string; values?: unknown[] }) => {
        if (options.statement.includes('INSERT INTO offline_replica_cursors')) throw new Error('constraint failed');
        return originalExecute(options);
      });
      await expect(
        repository.transactReplica({
          putCursors: [{ userId: 1, scopeId: '10', cursor: 'c-rollback' }],
        }),
      ).rejects.toThrow('constraint failed');
      expect(plugin.rollbackTransaction).toHaveBeenCalled();
      plugin.execute.mockImplementation(originalExecute);
      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toEqual([
        expect.objectContaining({ values: expect.objectContaining({ title: 'Before' }) }),
      ]);
      await expect(repository.getReplicaCursor(scope)).resolves.toBeNull();
    });
  });

  describe('replica pull persistence', () => {
    const scope = { userId: 1, scopeId: '10' };

    it('getReplicaRowByRemoteIdはuser scopeでscopeIdを無視してlookupする', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
            values: { id: 42, title: 'G10' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            scopeId: '11',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 43 },
            values: { id: 43, title: 'G11' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-aaaa' }),
      });
      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 43)).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-bbbb' }),
      });
      expect(await repository.getReplicaRowByRemoteId(scope, 'test_items', 99)).toBeNull();
    });

    it('getReplicaRowByRemoteIdはpartition scopeでscopeId一致のみ返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_group_items',
            identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 55 },
            values: { id: 55, name: 'G10' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            scopeId: '11',
            sourceKey: 'test_group_items',
            identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 56 },
            values: { id: 56, name: 'G11' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRowByRemoteId(scope, 'test_group_items', 55)).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-aaaa' }),
      });
      expect(await repository.getReplicaRowByRemoteId(scope, 'test_group_items', 56)).toBeNull();
    });

    it('putCursorsはrow更新と同一SQLite transactionで原子的に永続化する', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
            values: { id: 42, title: 'Pulled' },
            confirmedValues: { id: 42, title: 'Pulled' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
        putCursors: [{ userId: 1, scopeId: '10', cursor: 'cursor-v1' }],
      });

      expect(plugin.beginTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).toHaveBeenCalledOnce();
      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ userId: 1, scopeId: '10', cursor: 'cursor-v1' });
      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
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
              scopeId: '10',
              sourceKey: 'test_items',
              identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
              values: { id: 42 },
              confirmedValues: null,
              serverRevision: null,
              fetchedAt: 1,
              syncState: 'confirmed',
            },
          ],
          putCursors: [{ userId: 1, scopeId: '10', cursor: 'cursor-v1' }],
        }),
      ).rejects.toThrow('Replica row is missing required source key "title".');
      expect(plugin.rollbackTransaction).not.toHaveBeenCalled();
      expect(plugin.commitTransaction).not.toHaveBeenCalled();
      expect(await repository.getReplicaCursor(scope)).toBeNull();
      expect(storedReplicaCursors['1:10']).toBeUndefined();
    });
  });

  describe('user-scope cross-partition parity', () => {
    const scopeG10 = { userId: 1, scopeId: '10' };
    const scopeG11 = { userId: 1, scopeId: '11' };

    it('getReplicaRow/getReplicaRowByRemoteIdは別scopeIdでも同一user rowを返す', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-cross', remoteId: 42 },
            values: { id: 42, title: 'Shared user row' },
            confirmedValues: { id: 42, title: 'Shared user row' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await expect(repository.getReplicaRow(scopeG11, 'test_items', generatedCommandIdentity('019d-cross'))).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-cross' }),
        scopeId: '11',
      });
      await expect(repository.getReplicaRowByRemoteId(scopeG11, 'test_items', 42)).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-cross' }),
      });
    });

    it('clearScopeはuser-scoped rowを保持しpartition-scoped rowだけ削除する', async () => {
      const repository = createRepository();
      await repository.initialize();
      await repository.transactReplica({
        putRows: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-user', remoteId: 42 },
            values: { id: 42, title: 'User scoped' },
            confirmedValues: { id: 42, title: 'User scoped' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_group_items',
            identity: { kind: 'generated', localId: '019d-group', remoteId: 55 },
            values: { id: 55, name: 'Partition scoped' },
            confirmedValues: { id: 55, name: 'Partition scoped' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
      });

      await repository.clearScope(scopeG10);

      await expect(repository.getReplicaRow(scopeG10, 'test_items', generatedCommandIdentity('019d-user'))).resolves.toMatchObject({
        identity: expect.objectContaining({ localId: '019d-user' }),
      });
      expect(await repository.getReplicaRow(scopeG10, 'test_group_items', generatedCommandIdentity('019d-group'))).toBeNull();
    });

    it('naturalKey lookupはscopeと宣言順の実列predicateを使う', async () => {
      storedReplicaMetadata = null;
      const repository = createRepository(naturalFavoriteSchema);
      await repository.initialize();
      plugin.query.mockClear();

      await repository.getReplicaRowByRemoteIdentity({ userId: 7, scopeId: 'scope-a' }, 'natural_favorites', {
        naturalKey: { favTo: '42', favFrom: 9 },
      });

      expect(plugin.query).toHaveBeenCalledWith({
        databaseId: 'offline-db',
        statement: 'SELECT * FROM natural_favorites WHERE _offline_user_id = ? AND _offline_scope_id = ? AND fav_from = ? AND fav_to = ?',
        values: [canonicalOfflinePrincipalId(7), 'scope-a', 9, '42'],
      });
    });

    it('natural identityとrow valuesの不一致をSQLite upsert前にrejectする', async () => {
      storedReplicaMetadata = null;
      const repository = createRepository(naturalFavoriteSchema);
      await repository.initialize();
      const base = {
        userId: 7,
        scopeId: 'scope-a',
        sourceKey: 'natural_favorites',
        identity: { kind: 'natural' as const, naturalKey: { favFrom: 9, favTo: '42' } },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending' as const,
      };
      await repository.transactReplica({
        putRows: [{ ...base, values: { favFrom: 9, favTo: '42', label: 'A' } }],
      });
      await expect(
        repository.transactReplica({
          putRows: [{ ...base, values: { favFrom: 10, favTo: '42', label: 'B' } }],
        }),
      ).rejects.toThrow('Offline replica identity naturalKey must match values for "natural_favorites".');
    });

    it('confirmedValuesのnaturalKeyがvaluesと異なるrowをSQLiteへ書かない', async () => {
      storedReplicaMetadata = null;
      const repository = createRepository(naturalFavoriteSchema);
      await repository.initialize();
      plugin.execute.mockClear();
      await expect(
        repository.transactReplica({
          putRows: [
            {
              userId: 7,
              scopeId: 'scope-a',
              sourceKey: 'natural_favorites',
              identity: { kind: 'natural', naturalKey: { favFrom: 9, favTo: '42' } },
              values: { favFrom: 9, favTo: '42', label: 'optimistic' },
              confirmedValues: { favFrom: 10, favTo: '42', label: 'confirmed' },
              serverRevision: 1,
              fetchedAt: 1,
              syncState: 'pending',
            },
          ],
        }),
      ).rejects.toThrow('Offline replica confirmedValues naturalKey must match values for "natural_favorites".');
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          (options as { statement: string }).statement.startsWith('INSERT INTO natural_favorites'),
        ),
      ).toBe(false);
    });

    it('同一localIdのremoteId再割当をSQLite upsert前にrejectする', async () => {
      const repository = createRepository();
      await repository.initialize();
      const base = {
        userId: 1,
        scopeId: '10',
        sourceKey: 'test_items',
        identity: { kind: 'generated' as const, localId: 'uuid-a', remoteId: 42 },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed' as const,
      };
      await repository.transactReplica({ putRows: [{ ...base, values: { id: 42, title: 'A' } }] });
      await expect(
        repository.transactReplica({
          putRows: [{ ...base, identity: { ...base.identity, remoteId: 43 }, values: { id: 43, title: 'B' } }],
        }),
      ).rejects.toThrow('Offline replica remoteId is immutable: current=42, incoming=43.');
    });

    it('明示したidentity releaseだけがSQLiteのremoteIdをnullへ戻して後続createの再割当を許可する', async () => {
      const repository = createRepository();
      await repository.initialize();
      const base = {
        userId: 1,
        scopeId: '10',
        sourceKey: 'test_items',
        identity: { kind: 'generated' as const, localId: 'uuid-release', remoteId: 42 },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed' as const,
      };
      await repository.transactReplica({ putRows: [{ ...base, values: { id: 42, title: 'A' } }] });
      await repository.transactReplica({
        putRows: [
          {
            ...base,
            identity: { ...base.identity, remoteId: null },
            values: { id: 42, title: 'Recreate pending' },
            syncState: 'pending',
          },
        ],
        releaseRemoteIds: [
          {
            userId: 1,
            scopeId: '10',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: 'uuid-release', remoteId: 42 },
            remoteId: 42,
          },
        ],
      });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', {
          kind: 'generated',
          localId: 'uuid-release',
        }),
      ).resolves.toMatchObject({
        identity: { remoteId: null },
      });
      await repository.transactReplica({
        putRows: [{ ...base, identity: { ...base.identity, remoteId: 43 }, values: { id: 43, title: 'Recreated' } }],
      });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', {
          kind: 'generated',
          localId: 'uuid-release',
        }),
      ).resolves.toMatchObject({
        identity: { remoteId: 43 },
      });
    });
  });

  function createRepository(replicaSchema: OfflineReplicaSchemaBundle = replicaSchemaV1WithGroup): SqliteOfflineRepository {
    TestBed.configureTestingModule({
      providers: [
        SqliteOfflineRepository,
        { provide: COMMUNITY_SQLITE, useValue: plugin },
        {
          provide: OFFLINE_KIT_OPTIONS,
          useValue: {
            databaseName: 'test-offline',
            createEncryptionKey: async () => 'secret',
            replicaSchema,
          },
        },
      ],
    });
    return TestBed.inject(SqliteOfflineRepository);
  }

  describe('runReadSnapshot', () => {
    it('callbackからrepository本体を再入しても同じsnapshotで完了する', async () => {
      const repository = createRepository();
      await repository.initialize();

      await expect(repository.runReadSnapshot(() => repository.getCommands({ userId: 1, scopeId: '10' }))).resolves.toEqual([]);
    });

    it('open snapshot中はwriteが待機し、readerはcommit前の状態だけを見る', async () => {
      const repository = createRepository();
      await repository.initialize();
      plugin.execute.mockClear();

      let releaseSnapshot: (() => void) | undefined;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      let write: Promise<void> = Promise.resolve();

      const snapshot = repository.runReadSnapshot(async (reader) => {
        await reader.getCommands({ userId: 1, scopeId: '10' });
        write = repository.putCommand({
          userId: 1,
          scopeId: '10',
          commandId: 'cmd-after-snapshot',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-aaaa' },
          operation: 'test_items.update',
          payload: {},
          baseRevision: null,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        });
        void write.then(
          () => undefined,
          () => undefined,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(
          plugin.execute.mock.calls.some(([options]) =>
            String((options as { statement: string }).statement).includes('INSERT INTO offline_sync_commands'),
          ),
        ).toBe(false);
        await snapshotGate;
      });

      releaseSnapshot?.();
      await snapshot;
      await write;
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          String((options as { statement: string }).statement).includes('INSERT INTO offline_sync_commands'),
        ),
      ).toBe(true);
    });

    it('transaction rollback後にcommitted readへ失敗を漏らさない', async () => {
      const repository = createRepository();
      await repository.initialize();
      plugin.execute.mockImplementation(async ({ statement }: { statement: string }) => {
        if (statement.includes('INSERT INTO offline_replica_cursors')) throw new Error('constraint failed');
        return {};
      });

      await expect(
        repository.transactReplica({
          putCursors: [{ userId: 1, scopeId: '10', cursor: 'c1' }],
        }),
      ).rejects.toThrow('constraint failed');
      expect(plugin.rollbackTransaction).toHaveBeenCalledOnce();
      expect(plugin.commitTransaction).not.toHaveBeenCalled();

      plugin.execute.mockImplementation(async () => ({}));
      plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
        if (statement.includes('offline_replica_schema_metadata')) {
          return {
            columns: ['version', 'schema_hash'],
            rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
          };
        }
        if (statement.includes('offline_replica_cursors')) return { rows: [] };
        return { rows: [] };
      });
      await expect(repository.runReadSnapshot((reader) => reader.getReplicaCursor({ userId: 1, scopeId: '10' }))).resolves.toBeNull();
    });

    it('同一native connectionのsnapshotを直列化し、後続writerは両snapshotの完了を待つ', async () => {
      const repository = createRepository();
      await repository.initialize();
      plugin.execute.mockClear();

      let releaseA: (() => void) | undefined;
      let releaseB: (() => void) | undefined;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      let snapshotAReady: (() => void) | undefined;
      const readerAReady = new Promise<void>((resolve) => {
        snapshotAReady = resolve;
      });
      let snapshotBReady: (() => void) | undefined;
      const readerBReady = new Promise<void>((resolve) => {
        snapshotBReady = resolve;
      });
      let snapshotBEntered = false;

      plugin.query.mockImplementation(async ({ statement }: { statement: string }) => {
        if (statement.includes('offline_replica_schema_metadata')) {
          return {
            columns: ['version', 'schema_hash'],
            rows: [[storedReplicaMetadata!.version, storedReplicaMetadata!.schemaHash]],
          };
        }
        if (statement.startsWith('PRAGMA table_info')) return { rows: [{ name: 'next_local_id' }] };
        if (statement.includes('offline_sync_commands')) return { rows: [] };
        return { rows: [] };
      });

      const snapshotA = repository.runReadSnapshot(async (reader) => {
        await reader.getCommands({ userId: 1, scopeId: '10' });
        snapshotAReady?.();
        await gateA;
      });
      const snapshotB = repository.runReadSnapshot(async (reader) => {
        snapshotBEntered = true;
        snapshotBReady?.();
        await reader.getCommands({ userId: 1, scopeId: '10' });
        await gateB;
      });

      await readerAReady;
      expect(snapshotBEntered).toBe(false);
      let writeFinished = false;
      const write = repository
        .putCommand({
          userId: 1,
          scopeId: '10',
          commandId: 'cmd-after-concurrent-snapshots',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-aaaa' },
          operation: 'test_items.update',
          payload: {},
          baseRevision: null,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        })
        .then(() => {
          writeFinished = true;
        });
      void write.then(
        () => undefined,
        () => undefined,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(writeFinished).toBe(false);
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          String((options as { statement: string }).statement).includes('INSERT INTO offline_sync_commands'),
        ),
      ).toBe(false);

      releaseA?.();
      await snapshotA;
      await readerBReady;
      expect(snapshotBEntered).toBe(true);
      expect(writeFinished).toBe(false);

      releaseB?.();
      await snapshotB;
      await write;
      expect(writeFinished).toBe(true);
      expect(
        plugin.execute.mock.calls.some(([options]) =>
          String((options as { statement: string }).statement).includes('INSERT INTO offline_sync_commands'),
        ),
      ).toBe(true);
    });
  });
});
