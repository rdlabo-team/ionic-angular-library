/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { isOfflineFallbackError } from './offline-network.service';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  serverId,
  sha256OfflineReplicaSchema,
  text,
  type OfflineReplicaSchemaBundle,
} from './offline-replica-schema';
import {
  IonicOfflineRepository,
  OFFLINE_REPOSITORY,
  OFFLINE_SCHEMA_VERSION,
  selectOfflineRepository,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineRepository,
} from './offline-repository';

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
  entities: [testItemEntity, testGroupItemEntity],
  migrations: [],
});

const replicaSchemaV2 = defineOfflineReplicaSchema({
  version: 2,
  entities: [testItemWithSubtitleEntity, testGroupItemEntity],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items ADD COLUMN subtitle TEXT NOT NULL DEFAULT ""'],
      migrateWebRow: (row) => ({
        sourceKey: row.sourceKey,
        values: { ...row.values, subtitle: 'migrated' },
        confirmedValues: row.confirmedValues === null ? null : { ...row.confirmedValues, subtitle: 'migrated-confirmed' },
      }),
    },
  ],
});

const replicaSchemaV2DeleteRow = defineOfflineReplicaSchema({
  version: 2,
  entities: [testItemWithSubtitleEntity, testGroupItemEntity],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items ADD COLUMN subtitle TEXT NOT NULL DEFAULT ""'],
      migrateWebRow: (row) =>
        row.values['title'] === 'drop-me'
          ? null
          : {
              sourceKey: row.sourceKey,
              values: { ...row.values, subtitle: 'kept' },
              confirmedValues: row.confirmedValues === null ? null : { ...row.confirmedValues, subtitle: 'kept' },
            },
    },
  ],
});

const replicaSchemaV2InvalidOutput = defineOfflineReplicaSchema({
  version: 2,
  entities: [testItemWithSubtitleEntity, testGroupItemEntity],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items ADD COLUMN subtitle TEXT NOT NULL DEFAULT ""'],
      migrateWebRow: (row) => ({
        sourceKey: row.sourceKey,
        values: row.values,
        confirmedValues: row.confirmedValues,
      }),
    },
  ],
});
const replicaSchemaV2Rekey = defineOfflineReplicaSchema({
  version: 2,
  entities: [
    defineReplicaEntity<{ id: number; title: string }>()({
      table: 'renamed_items',
      sourceKey: 'renamed_items',
      scope: 'user',
      fields: {
        id: serverId(),
        title: text(),
      },
    }),
    testGroupItemEntity,
  ],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items RENAME TO renamed_items'],
      migrateWebRow: (row) => ({
        sourceKey: 'renamed_items',
        values: row.values,
        confirmedValues: row.confirmedValues,
      }),
    },
  ],
});

const replicaSchemaV2RekeyCollision = defineOfflineReplicaSchema({
  version: 2,
  entities: [
    defineReplicaEntity<{ id: number; title: string }>()({
      table: 'renamed_items',
      sourceKey: 'renamed_items',
      scope: 'user',
      fields: {
        id: serverId(),
        title: text(),
      },
    }),
    testGroupItemEntity,
  ],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE test_items RENAME TO renamed_items'],
      migrateWebRow: (row) => ({
        sourceKey: 'renamed_items',
        values: row.values,
        confirmedValues: row.confirmedValues,
      }),
    },
  ],
});

const replicaSchemaV1HashDrift = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemWithSubtitleEntity, testGroupItemEntity],
  migrations: [],
});

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

  function createRepository(
    replicaSchema: OfflineReplicaSchemaBundle = replicaSchemaV1,
    options: { preserveStorage?: boolean } = {},
  ): OfflineRepository {
    TestBed.resetTestingModule();
    if (!options.preserveStorage) {
      storage = new MemoryStorage();
    }
    TestBed.configureTestingModule({
      providers: [
        IonicOfflineRepository,
        { provide: KitStorageService, useValue: storage },
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', replicaSchema } },
        { provide: OFFLINE_REPOSITORY, useExisting: IonicOfflineRepository },
      ],
    });
    return TestBed.inject(OFFLINE_REPOSITORY);
  }

  async function createSeededRepository(replicaSchema: OfflineReplicaSchemaBundle, seed: () => Promise<void>): Promise<OfflineRepository> {
    storage = new MemoryStorage();
    await seed();
    return createRepository(replicaSchema, { preserveStorage: true });
  }

  beforeEach(() => {
    repository = createRepository();
  });

  async function seedReplicaMetadata(
    replicaSchema: OfflineReplicaSchemaBundle,
    rows: Record<string, OfflineReplicaRow> = {},
    commands: Record<string, OfflineCommand> = {},
  ): Promise<{ version: number; schemaHash: string }> {
    const schemaHash = await sha256OfflineReplicaSchema(replicaSchema);
    storage.values.set('offline:metadata', {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      lastUserId: null,
      replicaSchemaVersion: replicaSchema.version,
      replicaSchemaHash: schemaHash,
    });
    storage.values.set('offline:replica:rows', structuredClone(rows));
    storage.values.set('offline:outbox:commands', structuredClone(commands));
    return { version: replicaSchema.version, schemaHash };
  }

  describe('web replica schema migration', () => {
    const baseRow: OfflineReplicaRow = {
      userId: 1,
      groupId: 10,
      sourceKey: 'test_items',
      localId: '019d-aaaa',
      serverId: 42,
      values: { id: 42, title: 'Local item' },
      confirmedValues: { id: 42, title: 'Confirmed item' },
      serverRevision: 7,
      fetchedAt: 99,
      syncState: 'confirmed',
    };

    it('add-field transformを成功させidentity/sync metadataとoutboxを保持する', async () => {
      const command: OfflineCommand = {
        userId: 1,
        groupId: 10,
        commandId: 'update-1',
        aggregateType: 'test_items',
        aggregateLocalId: '019d-aaaa',
        operation: 'test_items.update',
        payload: { title: 'Local item' },
        optimisticValue: { id: 42, title: 'Local item' },
        payloadHash: 'hash',
        baseRevision: 7,
        state: 'pending',
        attempts: 0,
        retryAt: null,
        createdAt: 1,
        lastErrorCode: null,
      };
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow }, { 'update-1': command });
      });
      await repository.initialize();

      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-aaaa')).resolves.toMatchObject({
        localId: '019d-aaaa',
        serverId: 42,
        serverRevision: 7,
        fetchedAt: 99,
        syncState: 'confirmed',
        values: { title: 'Local item', subtitle: 'migrated' },
        confirmedValues: { title: 'Confirmed item', subtitle: 'migrated-confirmed' },
      });
      expect(await repository.getCommands({ userId: 1, groupId: 10 })).toHaveLength(1);
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
      expect(storage.values.get('offline:metadata')).toMatchObject({
        replicaSchemaVersion: 2,
        replicaSchemaHash: await sha256OfflineReplicaSchema(replicaSchemaV2),
      });
    });

    it('delete transformで行だけ削除しoutboxは保持する', async () => {
      const keepRow: OfflineReplicaRow = {
        ...baseRow,
        localId: '019d-bbbb',
        values: { id: 43, title: 'Keep me' },
        confirmedValues: null,
      };
      const dropRow: OfflineReplicaRow = {
        ...baseRow,
        localId: '019d-cccc',
        values: { id: 44, title: 'drop-me' },
        confirmedValues: null,
      };
      const command: OfflineCommand = {
        userId: 1,
        groupId: 10,
        commandId: 'delete-1',
        aggregateType: 'test_items',
        aggregateLocalId: '019d-cccc',
        operation: 'test_items.delete',
        payload: {},
        optimisticValue: {},
        payloadHash: 'hash',
        baseRevision: null,
        state: 'pending',
        attempts: 0,
        retryAt: null,
        createdAt: 1,
        lastErrorCode: null,
      };
      repository = await createSeededRepository(replicaSchemaV2DeleteRow, async () => {
        await seedReplicaMetadata(
          replicaSchemaV1,
          {
            '1:10:test_items:019d-bbbb': keepRow,
            '1:10:test_items:019d-cccc': dropRow,
          },
          { 'delete-1': command },
        );
      });
      await repository.initialize();

      expect(await repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-cccc')).toBeNull();
      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-bbbb')).resolves.toMatchObject({
        values: { title: 'Keep me', subtitle: 'kept' },
      });
      expect(await repository.getCommands({ userId: 1, groupId: 10 })).toHaveLength(1);
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 2 });
    });

    it('invalid outputはmetadataを進めずoutboxを失わない', async () => {
      const command: OfflineCommand = {
        userId: 1,
        groupId: 10,
        commandId: 'update-1',
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
        createdAt: 1,
        lastErrorCode: null,
      };
      repository = await createSeededRepository(replicaSchemaV2InvalidOutput, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow }, { 'update-1': command });
      });

      await expect(repository.initialize()).rejects.toThrow('Replica row is missing required source key "subtitle".');
      const schemaHash = await sha256OfflineReplicaSchema(replicaSchemaV1);
      expect(storage.values.get('offline:metadata')).toMatchObject({
        replicaSchemaVersion: 1,
        replicaSchemaHash: schemaHash,
      });
      expect(Object.keys(storage.values.get('offline:outbox:commands') as object)).toEqual(['update-1']);
      expect(storage.values.get('offline:replica:rows')).toMatchObject({
        '1:10:test_items:019d-aaaa': expect.objectContaining({
          values: { id: 42, title: 'Local item' },
        }),
      });
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });

    it('same-version hash driftはrow/outbox mutation前に拒否する', async () => {
      repository = await createSeededRepository(replicaSchemaV1HashDrift, async () => {
        await seedReplicaMetadata(replicaSchemaV1);
      });

      await expect(repository.initialize()).rejects.toThrow('Offline replica schema hash mismatch at version 1');
      await expect(
        repository.transactReplica({
          putRows: [
            {
              userId: 1,
              groupId: 10,
              sourceKey: 'test_items',
              localId: '019d-new',
              serverId: null,
              values: { id: 0, title: 'New', subtitle: 'added' },
              confirmedValues: null,
              serverRevision: null,
              fetchedAt: 1,
              syncState: 'pending',
            },
          ],
        }),
      ).rejects.toThrow('Offline replica schema hash mismatch at version 1');
    });

    it('ROWS成功後のmetadata失敗は旧状態へrollbackする', async () => {
      const command: OfflineCommand = {
        userId: 1,
        groupId: 10,
        commandId: 'update-1',
        aggregateType: 'test_items',
        aggregateLocalId: '019d-aaaa',
        operation: 'test_items.update',
        payload: { title: 'Local item' },
        optimisticValue: { id: 42, title: 'Local item' },
        payloadHash: 'hash',
        baseRevision: 7,
        state: 'pending',
        attempts: 0,
        retryAt: null,
        createdAt: 1,
        lastErrorCode: null,
      };
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow }, { 'update-1': command });
      });
      const kitStorage = TestBed.inject(KitStorageService) as MemoryStorage & KitStorageService;
      const originalSet = kitStorage.set.bind(kitStorage);
      vi.spyOn(kitStorage, 'set').mockImplementation(async (key, value) => {
        if (key === 'offline:metadata' && (value as { replicaSchemaVersion?: number }).replicaSchemaVersion === replicaSchemaV2.version) {
          throw new Error('metadata write failed');
        }
        return originalSet(key, value) as Promise<void>;
      });

      await expect(repository.initialize()).rejects.toThrow('metadata write failed');
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
      expect(storage.values.get('offline:metadata')).toMatchObject({
        replicaSchemaVersion: 1,
        replicaSchemaHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
      });
      expect(storage.values.get('offline:replica:rows')).toMatchObject({
        '1:10:test_items:019d-aaaa': expect.objectContaining({
          values: { id: 42, title: 'Local item' },
        }),
      });
      expect(Object.keys(storage.values.get('offline:outbox:commands') as object)).toEqual(['update-1']);
    });

    it('target metadataとjournalからrecovery後にmigrationを再実行する', async () => {
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:user:test_items:019d-aaaa': baseRow });
        storage.values.set('offline:replica:schema-migration', {
          originalRows: { '1:user:test_items:019d-aaaa': structuredClone(baseRow) },
          fromVersion: 1,
          fromHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
          targetVersion: 2,
          targetHash: await sha256OfflineReplicaSchema(replicaSchemaV2),
        });
        storage.values.set('offline:replica:rows', {
          '1:user:test_items:019d-aaaa': {
            ...baseRow,
            values: { id: 42, title: 'Corrupted partial migration' },
          },
        });
      });
      await repository.initialize();

      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-aaaa')).resolves.toMatchObject({
        values: { title: 'Local item', subtitle: 'migrated' },
      });
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });

    it('recovery失敗時はjournalを保持する', async () => {
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow });
      });
      const kitStorage = TestBed.inject(KitStorageService) as MemoryStorage & KitStorageService;
      const originalSet = kitStorage.set.bind(kitStorage);
      const originalRemove = kitStorage.remove.bind(kitStorage);
      vi.spyOn(kitStorage, 'set').mockImplementation(async (key, value) => {
        if (key === 'offline:metadata' && (value as { replicaSchemaVersion?: number }).replicaSchemaVersion === replicaSchemaV2.version) {
          throw new Error('metadata write failed');
        }
        return originalSet(key, value) as Promise<void>;
      });
      vi.spyOn(kitStorage, 'remove').mockImplementation(async (key) => {
        if (key === 'offline:replica:schema-migration') {
          throw new Error('journal remove failed');
        }
        return originalRemove(key);
      });

      await expect(repository.initialize()).rejects.toThrow('journal remove failed');
      expect(storage.values.get('offline:replica:schema-migration')).toBeDefined();
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 1 });
    });

    it('失敗後の再initializeで旧状態から新schemaへ収束する', async () => {
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:user:test_items:019d-aaaa': baseRow });
      });
      const kitStorage = TestBed.inject(KitStorageService) as MemoryStorage & KitStorageService;
      const originalSet = kitStorage.set.bind(kitStorage);
      let failMetadataOnce = true;
      vi.spyOn(kitStorage, 'set').mockImplementation(async (key, value) => {
        if (failMetadataOnce && key === 'offline:metadata' && (value as { replicaSchemaVersion?: number }).replicaSchemaVersion === 2) {
          failMetadataOnce = false;
          throw new Error('metadata write failed once');
        }
        return originalSet(key, value) as Promise<void>;
      });

      await expect(repository.initialize()).rejects.toThrow('metadata write failed once');
      vi.restoreAllMocks();
      repository = createRepository(replicaSchemaV2, { preserveStorage: true });
      await repository.initialize();

      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-aaaa')).resolves.toMatchObject({
        values: { title: 'Local item', subtitle: 'migrated' },
      });
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 2 });
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });

    it('sourceKey re-key collisionはmigrationを拒否する', async () => {
      const rowA: OfflineReplicaRow = { ...baseRow, localId: '019d-aaaa', serverId: 42, values: { id: 42, title: 'A' } };
      const rowB: OfflineReplicaRow = { ...baseRow, localId: '019d-aaaa', serverId: 43, values: { id: 43, title: 'B' } };
      repository = await createSeededRepository(replicaSchemaV2RekeyCollision, async () => {
        await seedReplicaMetadata(replicaSchemaV1, {
          '1:10:test_items:019d-aaaa': rowA,
          '1:user:test_items:019d-aaaa': rowB,
        });
      });

      await expect(repository.initialize()).rejects.toThrow('Replica schema migration produced duplicate row key');
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 1 });
    });

    it('sourceKey re-keyはstorage keyを更新してlookupできる', async () => {
      repository = await createSeededRepository(replicaSchemaV2Rekey, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow });
      });
      await repository.initialize();

      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-aaaa')).rejects.toThrow(
        'Unknown offline replica source key "test_items".',
      );
      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'renamed_items', '019d-aaaa')).resolves.toMatchObject({
        sourceKey: 'renamed_items',
        values: { title: 'Local item' },
      });
    });

    it('中断されたmigration journalをrollbackして再実行する', async () => {
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        await seedReplicaMetadata(replicaSchemaV1, { '1:10:test_items:019d-aaaa': baseRow });
        storage.values.set('offline:replica:schema-migration', {
          originalRows: { '1:10:test_items:019d-aaaa': structuredClone(baseRow) },
          fromVersion: 1,
          fromHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
          targetVersion: 2,
          targetHash: await sha256OfflineReplicaSchema(replicaSchemaV2),
        });
        storage.values.set('offline:replica:rows', {
          '1:10:test_items:019d-aaaa': {
            ...baseRow,
            values: { id: 42, title: 'Corrupted partial migration' },
          },
        });
      });
      await repository.initialize();

      await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-aaaa')).resolves.toMatchObject({
        values: { title: 'Local item', subtitle: 'migrated' },
      });
      expect(storage.values.get('offline:metadata')).toMatchObject({
        replicaSchemaVersion: 2,
        replicaSchemaHash: await sha256OfflineReplicaSchema(replicaSchemaV2),
      });
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });

    it('committed metadataと残存journalだけならjournalを掃除する', async () => {
      const targetHash = await sha256OfflineReplicaSchema(replicaSchemaV2);
      repository = await createSeededRepository(replicaSchemaV2, async () => {
        storage.values.set('offline:metadata', {
          schemaVersion: OFFLINE_SCHEMA_VERSION,
          lastUserId: null,
          replicaSchemaVersion: 2,
          replicaSchemaHash: targetHash,
        });
        storage.values.set('offline:replica:schema-migration', {
          originalRows: { '1:10:test_items:019d-aaaa': baseRow },
          fromVersion: 1,
          fromHash: await sha256OfflineReplicaSchema(replicaSchemaV1),
          targetVersion: 2,
          targetHash,
        });
      });

      await repository.initialize();

      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });
  });

  it('clearGroupはuser-scoped replica rowを保持しgroup-scoped rowだけ削除する', async () => {
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

    await repository.clearGroup({ userId: 1, groupId: 10 });

    await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-user')).resolves.toMatchObject({
      localId: '019d-user',
    });
    expect(await repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_group_items', '019d-group')).toBeNull();
  });

  describe('user-scope cross-group parity', () => {
    const scopeG10 = { userId: 1, groupId: 10 };
    const scopeG11 = { userId: 1, groupId: 11 };
    const userRow = {
      sourceKey: 'test_items',
      localId: '019d-cross',
      serverId: 42,
      confirmedValues: { id: 42, title: 'Shared user row' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };

    beforeEach(async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            groupId: 10,
            values: { id: 42, title: 'Shared user row' },
          },
        ],
      });
    });

    it('getReplicaRowは別groupIdでも同一user rowを返す', async () => {
      await expect(repository.getReplicaRow(scopeG11, 'test_items', '019d-cross')).resolves.toMatchObject({
        localId: '019d-cross',
        groupId: 11,
        values: { title: 'Shared user row' },
      });
    });

    it('getReplicaRowByServerIdは別groupIdでも同一user rowを返す', async () => {
      await expect(repository.getReplicaRowByServerId(scopeG11, 'test_items', 42)).resolves.toMatchObject({
        localId: '019d-cross',
      });
    });

    it('transactReplica更新は別group scopeからでも同一rowへ投影する', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            groupId: 11,
            values: { id: 42, title: 'Updated from G11' },
            confirmedValues: { id: 42, title: 'Updated from G11' },
          },
        ],
      });

      await expect(repository.getReplicaRow(scopeG10, 'test_items', '019d-cross')).resolves.toMatchObject({
        values: { title: 'Updated from G11' },
        groupId: 10,
      });
    });
  });

  it('同一createdAtはcommandId昇順で決定的に並べる', async () => {
    const base: Omit<OfflineCommand, 'groupId' | 'commandId' | 'createdAt'> = {
      userId: 1,
      aggregateType: 'test_items',
      aggregateLocalId: '019d-aaaa',
      operation: 'test_items.update',
      payload: {},
      optimisticValue: {},
      payloadHash: 'hash',
      baseRevision: null,
      state: 'pending' as const,
      attempts: 0,
      retryAt: null,
      lastErrorCode: null,
    };
    await repository.putCommand({ ...base, groupId: 10, commandId: 'cmd-z', createdAt: 10 });
    await repository.putCommand({ ...base, groupId: 10, commandId: 'cmd-a', createdAt: 10 });
    await repository.putCommand({ ...base, groupId: 11, commandId: 'cmd-m', createdAt: 10 });
    expect((await repository.getCommands({ userId: 1, groupId: 10 })).map((item) => item.commandId)).toEqual(['cmd-a', 'cmd-z']);
    expect((await repository.getCommandsForUser!(1)).map((item) => item.commandId)).toEqual(['cmd-a', 'cmd-m', 'cmd-z']);
  });

  it('outboxを作成順で保持し、group削除時はそのscopeだけを消す', async () => {
    const base: Omit<OfflineCommand, 'groupId' | 'commandId' | 'createdAt'> = {
      userId: 1,
      aggregateType: 'documents',
      aggregateLocalId: '019d-aaaa',
      operation: 'documents.upsert',
      payload: {},
      optimisticValue: {},
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

  it('session manifestをuserIdごとに保持しclearUserで削除する', async () => {
    const manifest = { userId: 1, scopeIds: [10], authSubject: 'uid-a', updatedAt: 1 };
    await repository.putSessionManifest(1, manifest);
    await expect(repository.getSessionManifest(1)).resolves.toEqual(manifest);
    await expect(repository.getSessionManifest(2)).resolves.toBeNull();

    await repository.clearUser(1);
    await expect(repository.getSessionManifest(1)).resolves.toBeNull();
  });

  it('clearGroupはsession manifestを削除しない', async () => {
    const manifest = { userId: 1, scopeIds: [10], authSubject: 'uid-a', updatedAt: 1 };
    await repository.putSessionManifest(1, manifest);
    await repository.clearGroup({ userId: 1, groupId: 10 });
    await expect(repository.getSessionManifest(1)).resolves.toEqual(manifest);
  });

  it('local UUIDを主キーとしてserver id未採番のreplica rowを保持する', async () => {
    const scope = { userId: 1, groupId: 10 };
    const row = {
      ...scope,
      sourceKey: 'test_items',
      localId: '019d-aaaa',
      serverId: null,
      values: { id: 0, title: 'local' },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    } as const;
    const command: OfflineCommand = {
      userId: 1,
      groupId: 10,
      commandId: 'create-1',
      aggregateType: 'test_items',
      aggregateLocalId: '019d-aaaa',
      operation: 'test_items.create',
      payload: { title: 'local' },
      optimisticValue: { id: 0, title: 'local' },
      payloadHash: 'hash',
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };
    await repository.transactReplica({ putRows: [row], putCommands: [command] });
    await expect(repository.getReplicaRow(scope, 'test_items', '019d-aaaa')).resolves.toMatchObject({
      localId: '019d-aaaa',
      serverId: null,
    });
    expect(await repository.getCommands(scope)).toHaveLength(1);

    await repository.transactReplica({
      putRows: [{ ...row, serverId: 38142, values: { id: 38142, title: 'local' }, syncState: 'confirmed' }],
      removeCommandIds: ['create-1'],
    });
    await expect(repository.getReplicaRow(scope, 'test_items', '019d-aaaa')).resolves.toMatchObject({
      localId: '019d-aaaa',
      serverId: 38142,
    });
    expect(await repository.getCommands(scope)).toEqual([]);
  });

  it('未知schemaではoffline領域だけ初期化し他のstorage keyを保持する', async () => {
    storage.values.set('offline:metadata', { schemaVersion: 999, lastUserId: 1 });
    storage.values.set('offline:outbox:commands', { stale: {} });
    storage.values.set('firebaseToken', { token: 'keep' });
    await repository.initialize();
    expect(storage.values.has('offline:outbox:commands')).toBe(false);
    expect(storage.values.get('firebaseToken')).toEqual({ token: 'keep' });
  });

  it('local replica fallbackは通信不能だけを対象にする', () => {
    expect(isOfflineFallbackError({ status: 0 })).toBe(true);
    expect(isOfflineFallbackError({ status: 403 })).toBe(false);
    expect(isOfflineFallbackError({ status: 500 })).toBe(false);
  });

  it('replica rowとoutbox commandを単一transactionで同時に読める', async () => {
    const scope = { userId: 1, groupId: 10 };
    const row = {
      ...scope,
      sourceKey: 'test_items',
      localId: '019d-bbbb',
      serverId: null,
      values: { id: 0, title: 'Local item' },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    } as const;
    const command: OfflineCommand = {
      ...scope,
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
    };
    await repository.transactReplica({ putRows: [row], putCommands: [command] });
    await expect(repository.getReplicaRow(scope, 'test_items', '019d-bbbb')).resolves.toMatchObject({
      localId: '019d-bbbb',
      values: { title: 'Local item' },
    });
    expect(await repository.getCommands(scope)).toHaveLength(1);
  });

  it('putRowsはvaluesとconfirmedValuesからserverId列を投影で除去する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          groupId: 10,
          sourceKey: 'test_items',
          localId: '019d-projected',
          serverId: 42,
          values: { id: 42, title: 'Optimistic' },
          confirmedValues: { id: 42, title: 'Confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
    });

    await expect(repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-projected')).resolves.toMatchObject({
      serverId: 42,
      values: { title: 'Optimistic' },
      confirmedValues: { title: 'Confirmed' },
    });
  });

  it('replica row保存前にschema driftを拒否する', async () => {
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
    expect(await repository.getReplicaRow({ userId: 1, groupId: 10 }, 'test_items', '019d-bbbb')).toBeNull();
  });

  it('schema reset時にreplica rowsも消す', async () => {
    storage.values.set('offline:replica:rows', {
      '1:10:test_items:019d-bbbb': {
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
    });
    storage.values.set('offline:metadata', { schemaVersion: 999, lastUserId: 1 });
    await repository.initialize();
    expect(storage.values.has('offline:replica:rows')).toBe(false);
  });

  describe('replica pull persistence', () => {
    const scope = { userId: 1, groupId: 10 };
    const baseRow = {
      sourceKey: 'test_items',
      serverId: 42,
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };

    it('getReplicaRowByServerIdはuser scopeでgroupIdを無視してlookupする', async () => {
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, groupId: 10, localId: '019d-aaaa', values: { id: 42, title: 'G10' } },
          { ...baseRow, userId: 1, groupId: 11, localId: '019d-bbbb', serverId: 43, values: { id: 43, title: 'G11' } },
          { ...baseRow, userId: 2, groupId: 10, localId: '019d-cccc', serverId: 42, values: { id: 42, title: 'Other user' } },
        ],
      });

      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 42)).resolves.toMatchObject({
        localId: '019d-aaaa',
        values: { title: 'G10' },
      });
      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 43)).resolves.toMatchObject({
        localId: '019d-bbbb',
      });
      expect(await repository.getReplicaRowByServerId(scope, 'test_items', 99)).toBeNull();
    });

    it('getReplicaRowByServerIdはgroup scopeでgroupId一致のみ返す', async () => {
      const groupRow = {
        sourceKey: 'test_group_items',
        serverId: 55,
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed' as const,
      };
      await repository.transactReplica({
        putRows: [
          { ...groupRow, userId: 1, groupId: 10, localId: '019d-aaaa', values: { id: 55, name: 'G10' } },
          { ...groupRow, userId: 1, groupId: 11, localId: '019d-bbbb', serverId: 56, values: { id: 56, name: 'G11' } },
        ],
      });

      await expect(repository.getReplicaRowByServerId(scope, 'test_group_items', 55)).resolves.toMatchObject({
        localId: '019d-aaaa',
      });
      expect(await repository.getReplicaRowByServerId(scope, 'test_group_items', 56)).toBeNull();
    });

    it('putCursorsはrow更新と同一transactionで原子的に永続化する', async () => {
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

      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ userId: 1, groupId: 10, cursor: 'cursor-v1' });
      await expect(repository.getReplicaRowByServerId(scope, 'test_items', 42)).resolves.toMatchObject({
        values: { title: 'Pulled' },
      });
    });

    it('row validation失敗時はcursorも永続化しない', async () => {
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
      expect(await repository.getReplicaCursor(scope)).toBeNull();
    });

    it('clearGroupはcursorを削除する', async () => {
      await repository.transactReplica({
        putCursors: [
          { userId: 1, groupId: 10, cursor: 'cursor-g10' },
          { userId: 1, groupId: 11, cursor: 'cursor-g11' },
        ],
      });
      await repository.clearGroup(scope);
      expect(await repository.getReplicaCursor(scope)).toBeNull();
      await expect(repository.getReplicaCursor({ userId: 1, groupId: 11 })).resolves.toEqual({
        userId: 1,
        groupId: 11,
        cursor: 'cursor-g11',
      });
    });

    it('clearUserはcursorを削除する', async () => {
      await repository.transactReplica({
        putCursors: [
          { userId: 1, groupId: 10, cursor: 'cursor-u1' },
          { userId: 2, groupId: 10, cursor: 'cursor-u2' },
        ],
      });
      await repository.clearUser(1);
      expect(await repository.getReplicaCursor({ userId: 1, groupId: 10 })).toBeNull();
      await expect(repository.getReplicaCursor({ userId: 2, groupId: 10 })).resolves.toEqual({
        userId: 2,
        groupId: 10,
        cursor: 'cursor-u2',
      });
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

    it('localId昇順で決定的に返す', async () => {
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
