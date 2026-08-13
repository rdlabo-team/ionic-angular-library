/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { isOfflineFallbackError } from './offline-network.service';
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
import {
  canonicalOfflineReplicaIdentity,
  IonicOfflineRepository,
  OFFLINE_REPOSITORY,
  OFFLINE_SCHEMA_VERSION,
  selectOfflineRepository,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineRepository,
} from './offline-repository';
import { generatedCommandIdentity, generatedReplicaIdentity, naturalCommandIdentity, naturalReplicaIdentity } from './offline-test-helpers';

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
        id: generatedId('integer'),
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
        id: generatedId('integer'),
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
      scopeId: '10',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
      values: { id: 42, title: 'Local item' },
      confirmedValues: { id: 42, title: 'Confirmed item' },
      serverRevision: 7,
      fetchedAt: 99,
      syncState: 'confirmed',
    };

    it('add-field transformを成功させidentity/sync metadataとoutboxを保持する', async () => {
      const command: OfflineCommand = {
        userId: 1,
        scopeId: '10',
        commandId: 'update-1',
        aggregateType: 'test_items',
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-aaaa' },
        operation: 'test_items.update',
        payload: { title: 'Local item' },
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

      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-aaaa')),
      ).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
        serverRevision: 7,
        fetchedAt: 99,
        syncState: 'confirmed',
        values: { title: 'Local item', subtitle: 'migrated' },
        confirmedValues: { title: 'Confirmed item', subtitle: 'migrated-confirmed' },
      });
      expect(await repository.getCommands({ userId: 1, scopeId: '10' })).toHaveLength(1);
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
      expect(storage.values.get('offline:metadata')).toMatchObject({
        replicaSchemaVersion: 2,
        replicaSchemaHash: await sha256OfflineReplicaSchema(replicaSchemaV2),
      });
    });

    it('delete transformで行だけ削除しoutboxは保持する', async () => {
      const keepRow: OfflineReplicaRow = {
        ...baseRow,
        identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 43 },
        values: { id: 43, title: 'Keep me' },
        confirmedValues: null,
      };
      const dropRow: OfflineReplicaRow = {
        ...baseRow,
        identity: { kind: 'generated', localId: '019d-cccc', remoteId: 44 },
        values: { id: 44, title: 'drop-me' },
        confirmedValues: null,
      };
      const command: OfflineCommand = {
        userId: 1,
        scopeId: '10',
        commandId: 'delete-1',
        aggregateType: 'test_items',
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-cccc' },
        operation: 'test_items.delete',
        payload: {},
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

      expect(await repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-cccc'))).toBeNull();
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-bbbb')),
      ).resolves.toMatchObject({
        values: { title: 'Keep me', subtitle: 'kept' },
      });
      expect(await repository.getCommands({ userId: 1, scopeId: '10' })).toHaveLength(1);
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 2 });
    });

    it('invalid outputはmetadataを進めずoutboxを失わない', async () => {
      const command: OfflineCommand = {
        userId: 1,
        scopeId: '10',
        commandId: 'update-1',
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
              scopeId: '10',
              sourceKey: 'test_items',
              identity: { kind: 'generated', localId: '019d-new', remoteId: null },
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
        scopeId: '10',
        commandId: 'update-1',
        aggregateType: 'test_items',
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-aaaa' },
        operation: 'test_items.update',
        payload: { title: 'Local item' },
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

      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-aaaa')),
      ).resolves.toMatchObject({
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

      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-aaaa')),
      ).resolves.toMatchObject({
        values: { title: 'Local item', subtitle: 'migrated' },
      });
      expect(storage.values.get('offline:metadata')).toMatchObject({ replicaSchemaVersion: 2 });
      expect(storage.values.get('offline:replica:schema-migration')).toBeUndefined();
    });

    it('sourceKey re-key collisionはmigrationを拒否する', async () => {
      const rowA: OfflineReplicaRow = {
        ...baseRow,
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
        values: { id: 42, title: 'A' },
      };
      const rowB: OfflineReplicaRow = {
        ...baseRow,
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 43 },
        values: { id: 43, title: 'B' },
      };
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

      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-aaaa')),
      ).rejects.toThrow('Unknown offline replica source key "test_items".');
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'renamed_items', generatedCommandIdentity('019d-aaaa')),
      ).resolves.toMatchObject({
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

      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-aaaa')),
      ).resolves.toMatchObject({
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

  it('clearScopeはuser-scoped replica rowを保持しpartition-scoped rowだけ削除する', async () => {
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

    await repository.clearScope({ userId: 1, scopeId: '10' });

    await expect(
      repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-user')),
    ).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-user', remoteId: 42 },
    });
    expect(
      await repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_group_items', generatedCommandIdentity('019d-group')),
    ).toBeNull();
  });

  describe('user-scope cross-partition parity', () => {
    const scopeG10 = { userId: 1, scopeId: '10' };
    const scopeG11 = { userId: 1, scopeId: '11' };
    const userRow = {
      sourceKey: 'test_items',
      identity: generatedReplicaIdentity('019d-cross', 42),
      confirmedValues: { id: 42, title: 'Shared user row' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };

    it('同一localIdのremoteId再割当をdirect transactionでもrejectする', async () => {
      await expect(
        repository.transactReplica({
          putRows: [{ ...userRow, ...scopeG10, identity: generatedReplicaIdentity('019d-cross', 43), values: { id: 43, title: 'B' } }],
        }),
      ).rejects.toThrow('Offline replica remoteId is immutable: current=42, incoming=43.');
    });

    it('明示したidentity releaseだけがremoteIdをnullへ戻して後続createの再割当を許可する', async () => {
      const released = {
        ...userRow,
        ...scopeG10,
        identity: generatedReplicaIdentity('019d-cross', null),
        values: { id: 42, title: 'Recreate pending' },
        confirmedValues: null,
        syncState: 'pending' as const,
      };
      await repository.transactReplica({
        putRows: [released],
        releaseRemoteIds: [{ ...scopeG10, sourceKey: 'test_items', identity: generatedReplicaIdentity('019d-cross', 42), remoteId: 42 }],
      });
      await expect(repository.getReplicaRow(scopeG10, 'test_items', generatedCommandIdentity('019d-cross'))).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-cross', remoteId: null },
      });
      await repository.transactReplica({
        putRows: [
          {
            ...released,
            identity: generatedReplicaIdentity('019d-cross', 43),
            values: { id: 43, title: 'Recreated' },
            syncState: 'confirmed',
          },
        ],
      });
      await expect(repository.getReplicaRow(scopeG11, 'test_items', generatedCommandIdentity('019d-cross'))).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-cross', remoteId: 43 },
      });
    });

    beforeEach(async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            scopeId: '10',
            values: { id: 42, title: 'Shared user row' },
          },
        ],
      });
    });

    it('getReplicaRowは別scopeIdでも同一user rowを返す', async () => {
      await expect(repository.getReplicaRow(scopeG11, 'test_items', generatedCommandIdentity('019d-cross'))).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-cross' },
        scopeId: '11',
        values: { title: 'Shared user row' },
      });
    });

    it('getReplicaRowByRemoteIdは別scopeIdでも同一user rowを返す', async () => {
      await expect(repository.getReplicaRowByRemoteId(scopeG11, 'test_items', 42)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-cross', remoteId: 42 },
      });
    });

    it('transactReplica更新は別partition scopeからでも同一rowへ投影する', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            scopeId: '11',
            values: { id: 42, title: 'Updated from G11' },
            confirmedValues: { id: 42, title: 'Updated from G11' },
          },
        ],
      });

      await expect(repository.getReplicaRow(scopeG10, 'test_items', generatedCommandIdentity('019d-cross'))).resolves.toMatchObject({
        values: { title: 'Updated from G11' },
        scopeId: '10',
      });
    });
  });

  it('同一createdAtはcommandId昇順で決定的に並べる', async () => {
    const base: Omit<OfflineCommand, 'scopeId' | 'commandId' | 'createdAt'> = {
      userId: 1,
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'test_items.update',
      payload: {},
      baseRevision: null,
      state: 'pending' as const,
      attempts: 0,
      retryAt: null,
      lastErrorCode: null,
    };
    await repository.putCommand({ ...base, scopeId: '10', commandId: 'cmd-z', createdAt: 10 });
    await repository.putCommand({ ...base, scopeId: '10', commandId: 'cmd-a', createdAt: 10 });
    await repository.putCommand({ ...base, scopeId: '11', commandId: 'cmd-m', createdAt: 10 });
    expect((await repository.getCommands({ userId: 1, scopeId: '10' })).map((item) => item.commandId)).toEqual(['cmd-a', 'cmd-z']);
    expect((await repository.getCommandsForUser!(1)).map((item) => item.commandId)).toEqual(['cmd-a', 'cmd-m', 'cmd-z']);
  });

  it('legacy web outboxの送信中と複数回試行済みの最終失敗をcommit不明として安全側へnormalizeする', async () => {
    const base: OfflineCommand = {
      userId: 1,
      scopeId: '10',
      commandId: 'legacy-pending',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'legacy' },
      operation: 'test_items.update',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };
    storage.values.set('offline:outbox:commands', {
      pending: base,
      sending: { ...base, commandId: 'legacy-sending', state: 'sending' },
      retry: { ...base, commandId: 'legacy-retry', state: 'retry_wait' },
      conflict: { ...base, commandId: 'legacy-conflict', state: 'conflict', attempts: 2 },
      rejected: { ...base, commandId: 'legacy-rejected', state: 'rejected', attempts: 2 },
      firstRejected: { ...base, commandId: 'legacy-first-rejected', state: 'rejected', attempts: 1 },
      explicitSafe: { ...base, commandId: 'new-pretransport', state: 'retry_wait', serverCommitUnknown: false },
    });

    const restored = await repository.getCommands({ userId: 1, scopeId: '10' });
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandId: 'legacy-sending', serverCommitUnknown: true }),
        expect.objectContaining({ commandId: 'legacy-retry', serverCommitUnknown: true }),
        expect.objectContaining({ commandId: 'legacy-conflict', serverCommitUnknown: true }),
        expect.objectContaining({ commandId: 'legacy-rejected', serverCommitUnknown: true }),
        expect.objectContaining({ commandId: 'new-pretransport', serverCommitUnknown: false }),
      ]),
    );
    expect(restored.find(({ commandId }) => commandId === 'legacy-first-rejected')).not.toHaveProperty('serverCommitUnknown');
  });

  it('outboxを作成順で保持し、scope削除時もuser-scoped commandを保持する', async () => {
    const base: Omit<OfflineCommand, 'scopeId' | 'commandId' | 'createdAt'> = {
      userId: 1,
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'documents.upsert',
      payload: {},
      baseRevision: null,
      state: 'pending' as const,
      attempts: 0,
      retryAt: null,
      lastErrorCode: null,
    };
    await repository.putCommand({ ...base, scopeId: '10', commandId: 'later', createdAt: 20 });
    await repository.putCommand({ ...base, scopeId: '10', commandId: 'earlier', createdAt: 10 });
    await repository.putCommand({ ...base, scopeId: '11', commandId: 'keep', createdAt: 5 });
    expect((await repository.getCommands({ userId: 1, scopeId: '10' })).map((item) => item.commandId)).toEqual(['earlier', 'later']);

    await repository.clearScope({ userId: 1, scopeId: '10' });
    expect(await repository.getCommands({ userId: 1, scopeId: '10' })).toHaveLength(2);
    expect(await repository.getCommands({ userId: 1, scopeId: '11' })).toHaveLength(1);
  });

  it('session manifestをuserIdごとに保持しclearUserで削除する', async () => {
    const manifest = { userId: 1, scopeIds: ['10'], authSubject: 'uid-a', updatedAt: 1 };
    await repository.putSessionManifest(1, manifest);
    await expect(repository.getSessionManifest(1)).resolves.toEqual(manifest);
    await expect(repository.getSessionManifest(2)).resolves.toBeNull();

    await repository.clearUser(1);
    await expect(repository.getSessionManifest(1)).resolves.toBeNull();
  });

  it('clearScopeはsession manifestを削除しない', async () => {
    const manifest = { userId: 1, scopeIds: ['10'], authSubject: 'uid-a', updatedAt: 1 };
    await repository.putSessionManifest(1, manifest);
    await repository.clearScope({ userId: 1, scopeId: '10' });
    await expect(repository.getSessionManifest(1)).resolves.toEqual(manifest);
  });

  it('local UUIDを主キーとしてserver id未採番のreplica rowを保持する', async () => {
    const scope = { userId: 1, scopeId: '10' };
    const row = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: null },
      values: { id: 0, title: 'local' },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    } as const;
    const command: OfflineCommand = {
      userId: 1,
      scopeId: '10',
      commandId: 'create-1',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'test_items.create',
      payload: { title: 'local' },
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };
    await repository.transactReplica({ putRows: [row], putCommands: [command] });
    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-aaaa'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: null },
    });
    expect(await repository.getCommands(scope)).toHaveLength(1);

    await repository.transactReplica({
      putRows: [
        { ...row, identity: generatedReplicaIdentity('019d-aaaa', 38142), values: { id: 38142, title: 'local' }, syncState: 'confirmed' },
      ],
      removeCommandIds: ['create-1'],
    });
    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-aaaa'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 38142 },
    });
    expect(await repository.getCommands(scope)).toEqual([]);
  });

  it('local-only projectionをremoteIdなしでround-tripしremoteId lookupは常にnullを返す', async () => {
    repository = createRepository(localProjectionSchema);
    await repository.initialize();
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

    await expect(repository.getReplicaRows(scope, 'local_projections')).resolves.toEqual([
      expect.objectContaining({
        identity: { kind: 'local', localId: 'feed-home' },
        values: { feedKey: 'home' },
      }),
    ]);
    await expect(repository.getReplicaRowByRemoteId(scope, 'local_projections', 1)).resolves.toBeNull();
  });

  it('local-only projectionへgenerated identityを渡すと永続化前にrejectする', async () => {
    repository = createRepository(localProjectionSchema);
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
    await expect(repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'local_projections')).resolves.toEqual([]);
  });

  it('未知core schemaはOutboxを消さずlossless migrationが無い限りfail closedにする', async () => {
    storage.values.set('offline:metadata', { schemaVersion: 999, lastUserId: 1 });
    storage.values.set('offline:outbox:commands', { stale: {} });
    storage.values.set('firebaseToken', { token: 'keep' });
    await expect(repository.initialize()).rejects.toThrow(
      `Unsupported offline storage schema version 999; expected ${OFFLINE_SCHEMA_VERSION}`,
    );
    expect(storage.values.get('offline:outbox:commands')).toEqual({ stale: {} });
    expect(storage.values.get('offline:metadata')).toEqual({ schemaVersion: 999, lastUserId: 1 });
    expect(storage.values.get('firebaseToken')).toEqual({ token: 'keep' });
  });

  it('local replica fallbackは通信不能だけを対象にする', () => {
    expect(isOfflineFallbackError({ status: 0 })).toBe(true);
    expect(isOfflineFallbackError({ status: 403 })).toBe(false);
    expect(isOfflineFallbackError({ status: 500 })).toBe(false);
  });

  it('replica rowとoutbox commandを単一transactionで同時に読める', async () => {
    const scope = { userId: 1, scopeId: '10' };
    const row = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-bbbb', remoteId: null },
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
    };
    await repository.transactReplica({ putRows: [row], putCommands: [command] });
    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-bbbb'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-bbbb', remoteId: null },
      values: { title: 'Local item' },
    });
    expect(await repository.getCommands(scope)).toHaveLength(1);
  });

  it('pending_deleteはproduct readから隠しつつ、sync readとremote identityでbaselineを保持する', async () => {
    const scope = { userId: 1, scopeId: '10' };
    const row: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'delete-uuid', remoteId: 42 },
      values: { id: 42, title: 'visible before delete' },
      confirmedValues: { id: 42, title: 'confirmed baseline' },
      serverRevision: 7,
      fetchedAt: 1,
      syncState: 'pending',
      visibility: 'pending_delete',
    };
    const command: OfflineCommand = {
      ...scope,
      commandId: 'delete-command',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: generatedCommandIdentity('delete-uuid'),
      operation: 'test_items.delete',
      payload: { id: 42 },
      baseRevision: 7,
      replicaMutation: 'delete',
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };

    await repository.transactReplica({ putRows: [row], putCommands: [command] });

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('delete-uuid'))).resolves.toBeNull();
    await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toEqual([]);
    await expect(
      repository.getReplicaRowIncludingPendingDelete?.(scope, 'test_items', generatedCommandIdentity('delete-uuid')),
    ).resolves.toMatchObject({
      identity: { kind: 'generated', localId: 'delete-uuid', remoteId: 42 },
      visibility: 'pending_delete',
      confirmedValues: { title: 'confirmed baseline' },
      serverRevision: 7,
    });
    await expect(repository.getReplicaRowByRemoteIdentity(scope, 'test_items', { remoteId: 42 })).resolves.toMatchObject({
      identity: { kind: 'generated', localId: 'delete-uuid', remoteId: 42 },
      visibility: 'pending_delete',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({ commandId: 'delete-command', replicaMutation: 'delete' }),
    ]);
  });

  it('putRowsはvaluesとconfirmedValuesからremoteId列を投影で除去する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          userId: 1,
          scopeId: '10',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-projected', remoteId: 42 },
          values: { id: 42, title: 'Optimistic' },
          confirmedValues: { id: 42, title: 'Confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
    });

    await expect(
      repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-projected')),
    ).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-projected', remoteId: 42 },
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
    expect(await repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', generatedCommandIdentity('019d-bbbb'))).toBeNull();
  });

  it('未知core schemaではreplica rowsも破壊しない', async () => {
    storage.values.set('offline:replica:rows', {
      '1:10:test_items:019d-bbbb': {
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
    });
    storage.values.set('offline:metadata', { schemaVersion: 999, lastUserId: 1 });
    await expect(repository.initialize()).rejects.toThrow('Unsupported offline storage schema version 999');
    expect(storage.values.has('offline:replica:rows')).toBe(true);
  });

  describe('replica pull persistence', () => {
    const scope = { userId: 1, scopeId: '10' };
    const baseRow = {
      sourceKey: 'test_items',
      identity: generatedReplicaIdentity('019d-aaaa', 42),
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };

    it('getReplicaRowByRemoteIdはuser scopeでscopeIdを無視してlookupする', async () => {
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, scopeId: '10', values: { id: 42, title: 'G10' } },
          { ...baseRow, userId: 1, scopeId: '11', identity: generatedReplicaIdentity('019d-bbbb', 43), values: { id: 43, title: 'G11' } },
          {
            ...baseRow,
            userId: 2,
            scopeId: '10',
            identity: generatedReplicaIdentity('019d-cccc', 42),
            values: { id: 42, title: 'Other user' },
          },
        ],
      });

      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 42 },
        values: { title: 'G10' },
      });
      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 43)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 43 },
      });
      expect(await repository.getReplicaRowByRemoteId(scope, 'test_items', 99)).toBeNull();
    });

    it('getReplicaRowByRemoteIdはpartition scopeでscopeId一致のみ返す', async () => {
      const groupRow = {
        sourceKey: 'test_group_items',
        identity: generatedReplicaIdentity('019d-aaaa', 55),
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed' as const,
      };
      await repository.transactReplica({
        putRows: [
          { ...groupRow, userId: 1, scopeId: '10', values: { id: 55, name: 'G10' } },
          { ...groupRow, userId: 1, scopeId: '11', identity: generatedReplicaIdentity('019d-bbbb', 56), values: { id: 56, name: 'G11' } },
        ],
      });

      await expect(repository.getReplicaRowByRemoteId(scope, 'test_group_items', 55)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 55 },
      });
      expect(await repository.getReplicaRowByRemoteId(scope, 'test_group_items', 56)).toBeNull();
    });

    it('同じlocalIdを別principalと別partitionで独立して保持する', async () => {
      const sameLocalId = '019d-shared-local-id';
      await repository.transactReplica({
        putRows: [
          {
            ...baseRow,
            userId: 1,
            scopeId: '10',
            identity: generatedReplicaIdentity(sameLocalId, 42),
            values: { id: 42, title: 'User 1' },
          },
          {
            ...baseRow,
            userId: 2,
            scopeId: '10',
            identity: generatedReplicaIdentity(sameLocalId, 42),
            values: { id: 42, title: 'User 2' },
          },
          {
            ...baseRow,
            sourceKey: 'test_group_items',
            userId: 1,
            scopeId: '10',
            identity: generatedReplicaIdentity(sameLocalId, 55),
            values: { id: 55, name: 'Group 10' },
          },
          {
            ...baseRow,
            sourceKey: 'test_group_items',
            userId: 1,
            scopeId: '11',
            identity: generatedReplicaIdentity(sameLocalId, 55),
            values: { id: 55, name: 'Group 11' },
          },
        ],
      });

      await expect(
        repository.getReplicaRow({ userId: 2, scopeId: '10' }, 'test_items', generatedCommandIdentity(sameLocalId)),
      ).resolves.toMatchObject({ values: { title: 'User 2' } });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '11' }, 'test_group_items', generatedCommandIdentity(sameLocalId)),
      ).resolves.toMatchObject({ values: { name: 'Group 11' } });

      await repository.clearScope({ userId: 1, scopeId: '10' });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '11' }, 'test_group_items', generatedCommandIdentity(sameLocalId)),
      ).resolves.toMatchObject({ values: { name: 'Group 11' } });
      await expect(
        repository.getReplicaRow({ userId: 2, scopeId: '10' }, 'test_items', generatedCommandIdentity(sameLocalId)),
      ).resolves.toMatchObject({ values: { title: 'User 2' } });
    });

    it('TEXT generated idをnullからUUIDへ割り当て、lookup・collision・restartを同じ型で扱う', async () => {
      repository = createRepository(textIdSchema);
      const textScope = { userId: 1, scopeId: '10' };
      const localId = 'text-local-id';
      const remoteId = '018f6f6e-74ad-7cc4-b94f-4af0b13c4401';
      const row = (nextRemoteId: string | null, title: string): OfflineReplicaRow => ({
        ...textScope,
        sourceKey: 'text_id_items',
        identity: generatedReplicaIdentity(localId, nextRemoteId),
        values: { id: nextRemoteId ?? '', title },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      });
      await repository.transactReplica({ putRows: [row(null, 'local')] });
      await repository.transactReplica({ putRows: [row(remoteId, 'confirmed')] });
      await expect(repository.getReplicaRowByRemoteId(textScope, 'text_id_items', remoteId)).resolves.toMatchObject({
        identity: { kind: 'generated', localId, remoteId },
      });
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...row(remoteId, 'collision'),
              identity: generatedReplicaIdentity('another-local-id', remoteId),
            },
          ],
        }),
      ).rejects.toThrow('already mapped');
      await expect(repository.getReplicaRowByRemoteId(textScope, 'text_id_items', 42)).rejects.toThrow(
        'generated remote id must be a non-empty string',
      );

      repository = createRepository(textIdSchema, { preserveStorage: true });
      await expect(repository.getReplicaRowByRemoteId(textScope, 'text_id_items', remoteId)).resolves.toMatchObject({
        identity: { kind: 'generated', localId, remoteId },
      });
    });

    it('putCursorsはrow更新と同一transactionで原子的に永続化する', async () => {
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

      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ userId: 1, scopeId: '10', cursor: 'cursor-v1' });
      await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
        values: { title: 'Pulled' },
      });
    });

    it('row validation失敗時はcursorも永続化しない', async () => {
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
      expect(await repository.getReplicaCursor(scope)).toBeNull();
    });

    it('clearScopeはcursorを削除する', async () => {
      await repository.transactReplica({
        putCursors: [
          { userId: 1, scopeId: '10', cursor: 'cursor-g10' },
          { userId: 1, scopeId: '11', cursor: 'cursor-g11' },
        ],
      });
      await repository.clearScope(scope);
      expect(await repository.getReplicaCursor(scope)).toBeNull();
      await expect(repository.getReplicaCursor({ userId: 1, scopeId: '11' })).resolves.toEqual({
        userId: 1,
        scopeId: '11',
        cursor: 'cursor-g11',
      });
    });

    it('clearUserはcursorを削除する', async () => {
      await repository.transactReplica({
        putCursors: [
          { userId: 1, scopeId: '10', cursor: 'cursor-u1' },
          { userId: 2, scopeId: '10', cursor: 'cursor-u2' },
        ],
      });
      await repository.clearUser(1);
      expect(await repository.getReplicaCursor({ userId: 1, scopeId: '10' })).toBeNull();
      await expect(repository.getReplicaCursor({ userId: 2, scopeId: '10' })).resolves.toEqual({
        userId: 2,
        scopeId: '10',
        cursor: 'cursor-u2',
      });
    });
  });

  describe('pull attentions', () => {
    it('put/get/removeとtransactionでuser+scope attentionを永続化する', async () => {
      await repository.putPullAttention!({
        userId: 1,
        scopeId: '10',
        reason: 'schema_upgrade_required',
      });
      await repository.transactReplica({
        putPullAttentions: [{ userId: 1, scopeId: '20', reason: 'authorization_required', status: 403 }],
      });
      expect(await repository.getPullAttentions!(1)).toEqual([
        { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
        { userId: 1, scopeId: '20', reason: 'authorization_required', status: 403 },
      ]);
      await repository.removePullAttention!({ userId: 1, scopeId: '10' });
      await repository.transactReplica({ removePullAttentions: [{ userId: 1, scopeId: '20' }] });
      expect(await repository.getPullAttentions!(1)).toEqual([]);
    });

    it('clearScopeとclearUserはpull attentionを隔離削除する', async () => {
      await repository.transactReplica({
        putPullAttentions: [
          { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
          { userId: 1, scopeId: '11', reason: 'authorization_required', status: 401 },
          { userId: 2, scopeId: '10', reason: 'authorization_required', status: 403 },
        ],
      });
      await repository.clearScope({ userId: 1, scopeId: '10' });
      expect(await repository.getPullAttentions!(1)).toEqual([{ userId: 1, scopeId: '11', reason: 'authorization_required', status: 401 }]);
      expect(await repository.getPullAttentions!(2)).toEqual([{ userId: 2, scopeId: '10', reason: 'authorization_required', status: 403 }]);
      await repository.clearUser(1);
      expect(await repository.getPullAttentions!(1)).toEqual([]);
      expect(await repository.getPullAttentions!(2)).toEqual([{ userId: 2, scopeId: '10', reason: 'authorization_required', status: 403 }]);
    });
  });

  describe('replica remoteId uniqueness', () => {
    const scope = { userId: 1, scopeId: '10' };
    const groupRow = {
      sourceKey: 'test_group_items' as const,
      identity: generatedReplicaIdentity('019d-aaaa', 55),
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };
    const userRow = {
      sourceKey: 'test_items' as const,
      identity: generatedReplicaIdentity('019d-aaaa', 42),
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };

    it('partition-scopedで別localIdに同じremoteIdを割り当てるとrejectする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...groupRow,
            userId: 1,
            scopeId: '10',
            values: { id: 55, name: 'A' },
          },
        ],
      });
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...groupRow,
              userId: 1,
              scopeId: '10',
              identity: generatedReplicaIdentity('019d-bbbb', 55),
              values: { id: 55, name: 'B' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remote id 55 is already mapped to 019d-aaaa.');
    });

    it('user-scopedで別localIdに同じremoteIdを割り当てるとrejectする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            scopeId: '10',
            values: { id: 42, title: 'A' },
          },
        ],
      });
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...userRow,
              userId: 1,
              scopeId: '10',
              identity: generatedReplicaIdentity('019d-bbbb', 42),
              values: { id: 42, title: 'B' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remote id 42 is already mapped to 019d-aaaa.');
    });

    it('同一transaction内のremoteId重複は部分永続化せずrejectする', async () => {
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...groupRow,
              userId: 1,
              scopeId: '10',
              values: { id: 55, name: 'A' },
            },
            {
              ...groupRow,
              userId: 1,
              scopeId: '10',
              identity: generatedReplicaIdentity('019d-bbbb', 55),
              values: { id: 55, name: 'B' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remote id 55 is already mapped to 019d-aaaa.');
      expect(await repository.getReplicaRow(scope, 'test_group_items', generatedCommandIdentity('019d-aaaa'))).toBeNull();
      expect(await repository.getReplicaRow(scope, 'test_group_items', generatedCommandIdentity('019d-bbbb'))).toBeNull();
    });

    it('partition-scopedは別partitionなら同じremoteIdを許容する', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...groupRow,
            userId: 1,
            scopeId: '10',
            values: { id: 55, name: 'G10' },
          },
          {
            ...groupRow,
            userId: 1,
            scopeId: '11',
            identity: generatedReplicaIdentity('019d-bbbb', 55),
            values: { id: 55, name: 'G11' },
          },
        ],
      });
      await expect(repository.getReplicaRowByRemoteId(scope, 'test_group_items', 55)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 55 },
      });
      await expect(repository.getReplicaRowByRemoteId({ userId: 1, scopeId: '11' }, 'test_group_items', 55)).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-bbbb', remoteId: 55 },
      });
    });

    it('user-scopedは別partitionでも同じremoteIdをrejectする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...userRow,
            userId: 1,
            scopeId: '10',
            values: { id: 42, title: 'G10' },
          },
        ],
      });
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...userRow,
              userId: 1,
              scopeId: '11',
              identity: generatedReplicaIdentity('019d-bbbb', 42),
              values: { id: 42, title: 'G11' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remote id 42 is already mapped to 019d-aaaa.');
    });
  });

  describe('naturalKey identity', () => {
    const favoriteNaturalKey = { favFrom: 7, favTo: '42' };
    const row = (scopeId: string, label: string): OfflineReplicaRow => ({
      userId: 1,
      scopeId,
      sourceKey: 'natural_favorites',
      identity: naturalReplicaIdentity(favoriteNaturalKey),
      values: { favFrom: 7, favTo: '42', label },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    });

    beforeEach(() => {
      repository = createRepository(naturalFavoriteSchema);
    });

    it('same scopeの同一composite identityを同じrowとして更新する', async () => {
      await repository.transactReplica({ putRows: [row('10', 'A')] });
      await repository.transactReplica({ putRows: [row('10', 'B')] });
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'natural_favorites', naturalCommandIdentity(favoriteNaturalKey)),
      ).resolves.toMatchObject({ values: { label: 'B' } });
    });

    it('partitionが異なれば同じnaturalKeyを許可しidentity lookupできる', async () => {
      await repository.transactReplica({ putRows: [row('10', 'A'), row('11', 'B')] });

      await expect(
        repository.getReplicaRowByRemoteIdentity({ userId: 1, scopeId: '11' }, 'natural_favorites', {
          naturalKey: { favTo: '42', favFrom: 7 },
        }),
      ).resolves.toMatchObject({
        identity: naturalReplicaIdentity(favoriteNaturalKey),
      });
    });

    it('同一naturalKeyの再割当をdirect transactionでもrejectする', async () => {
      await repository.transactReplica({ putRows: [row('10', 'A')] });
      await expect(
        repository.transactReplica({
          putRows: [{ ...row('10', 'changed'), values: { favFrom: 8, favTo: '42', label: 'changed' } }],
        }),
      ).rejects.toThrow('Offline replica identity naturalKey must match values for "natural_favorites".');
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'natural_favorites', naturalCommandIdentity(favoriteNaturalKey)),
      ).resolves.toMatchObject({
        values: { favFrom: 7, favTo: '42', label: 'A' },
      });
    });

    it('confirmedValuesのnaturalKeyがvaluesと異なるrowを永続化しない', async () => {
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...row('10', 'optimistic'),
              confirmedValues: { favFrom: 8, favTo: '42', label: 'confirmed' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica confirmedValues naturalKey must match values for "natural_favorites".');
      await expect(
        repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'natural_favorites', naturalCommandIdentity(favoriteNaturalKey)),
      ).resolves.toBeNull();
    });
  });

  describe('getReplicaRows', () => {
    const baseRow = {
      sourceKey: 'test_items',
      identity: generatedReplicaIdentity('019d-placeholder', null),
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending' as const,
    };

    it('identity昇順で決定的に返す', async () => {
      await repository.transactReplica({
        putRows: [
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-cccc', null), values: { id: 0, title: 'C' } },
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-aaaa', null), values: { id: 0, title: 'A' } },
          { ...baseRow, userId: 1, scopeId: '10', identity: generatedReplicaIdentity('019d-bbbb', null), values: { id: 0, title: 'B' } },
        ],
      });

      const rows = await repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'test_items');
      expect(rows.map((row) => canonicalOfflineReplicaIdentity(row.identity))).toEqual([
        'generated:019d-aaaa',
        'generated:019d-bbbb',
        'generated:019d-cccc',
      ]);
    });

    it('user-scoped sourceはscopeIdを無視して同一userの行を返す', async () => {
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
      expect(rows.map((row) => canonicalOfflineReplicaIdentity(row.identity))).toEqual(['generated:019d-aaaa', 'generated:019d-bbbb']);
    });

    it('partition-scoped sourceはscopeId一致の行だけを返す', async () => {
      const groupRow = {
        sourceKey: 'test_group_items',
        identity: generatedReplicaIdentity('019d-placeholder', null),
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
      expect(rows[0]?.identity).toEqual(generatedReplicaIdentity('019d-aaaa', null));
    });

    it('legacy単一recordを一度だけ走査して全scope/source indexを構築する', async () => {
      const userRow: OfflineReplicaRow = {
        ...baseRow,
        userId: 1,
        scopeId: '10',
        identity: generatedReplicaIdentity('019d-user-index', 41),
        values: { id: 41, title: 'Indexed user row' },
      };
      const groupRow: OfflineReplicaRow = {
        userId: 1,
        scopeId: '20',
        sourceKey: 'test_group_items',
        identity: generatedReplicaIdentity('019d-group-index', 42),
        values: { id: 42, name: 'Indexed group row' },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      };
      repository = await createSeededRepository(replicaSchemaV1, async () => {
        await seedReplicaMetadata(replicaSchemaV1, {
          '1:user:test_items:generated:019d-user-index': userRow,
          '1:20:test_group_items:generated:019d-group-index': groupRow,
        });
      });
      const get = vi.spyOn(storage, 'get');

      await expect(repository.getReplicaRows({ userId: 1, scopeId: '10' }, 'test_items')).resolves.toHaveLength(1);
      await expect(repository.getReplicaRows({ userId: 1, scopeId: '20' }, 'test_group_items')).resolves.toHaveLength(1);

      expect(get.mock.calls.filter(([key]) => key === 'offline:replica:rows')).toHaveLength(1);
    });

    it('replica transactionと同じcommit境界で既存partition indexを更新する', async () => {
      const scope = { userId: 1, scopeId: '10' };
      const initial: OfflineReplicaRow = {
        ...baseRow,
        ...scope,
        identity: generatedReplicaIdentity('019d-index-update', 44),
        values: { id: 44, title: 'Before' },
      };
      await repository.transactReplica({ putRows: [initial] });
      await repository.getReplicaRows(scope, 'test_items');

      await repository.transactReplica({ putRows: [{ ...initial, values: { id: 44, title: 'After' } }] });

      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toMatchObject([{ values: { title: 'After' } }]);
    });

    it('初回partition構築と並行するtransactionを同じwrite laneで直列化する', async () => {
      const scope = { userId: 1, scopeId: '10' };
      const initial: OfflineReplicaRow = {
        ...baseRow,
        ...scope,
        identity: generatedReplicaIdentity('019d-index-race', 45),
        values: { id: 45, title: 'Before' },
      };
      await repository.transactReplica({ putRows: [initial] });
      for (const key of [...storage.values.keys()]) {
        if (key.startsWith('offline:replica:rows:index:v1:')) storage.values.delete(key);
      }
      let releaseRowsRead!: () => void;
      const rowsRead = new Promise<void>((resolve) => {
        releaseRowsRead = resolve;
      });
      const originalGet = storage.get.bind(storage);
      vi.spyOn(storage, 'get').mockImplementation(async <T>(key: string): Promise<T | null> => {
        if (key === 'offline:replica:rows') await rowsRead;
        return originalGet<T>(key);
      });

      const build = repository.getReplicaRows(scope, 'test_items');
      const update = repository.transactReplica({
        putRows: [{ ...initial, values: { id: 45, title: 'After' } }],
      });
      releaseRowsRead();

      await Promise.all([build, update]);
      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toMatchObject([{ values: { title: 'After' } }]);
    });

    it('進行中transactionの後にclearScopeを同じwrite laneで確定する', async () => {
      const scope = { userId: 1, scopeId: '10' };
      const initial: OfflineReplicaRow = {
        userId: 1,
        scopeId: '10',
        sourceKey: 'test_group_items',
        identity: generatedReplicaIdentity('019d-clear-race', 46),
        values: { id: 46, name: 'Before clear' },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      };
      await repository.transactReplica({ putRows: [initial] });
      let releaseRowsWrite!: () => void;
      let announceRowsWrite!: () => void;
      const rowsWriteStarted = new Promise<void>((resolve) => {
        announceRowsWrite = resolve;
      });
      const rowsWrite = new Promise<void>((resolve) => {
        releaseRowsWrite = resolve;
      });
      const originalSet = storage.set.bind(storage);
      let deferNextRowsWrite = true;
      vi.spyOn(storage, 'set').mockImplementation(async <T>(key: string, value: T): Promise<T> => {
        if (key === 'offline:replica:rows' && deferNextRowsWrite) {
          deferNextRowsWrite = false;
          announceRowsWrite();
          await rowsWrite;
        }
        return originalSet(key, value);
      });

      const update = repository.transactReplica({
        putRows: [{ ...initial, values: { id: 46, name: 'Concurrent update' } }],
      });
      await rowsWriteStarted;
      const clear = repository.clearScope(scope);
      releaseRowsWrite();

      await Promise.all([update, clear]);
      await expect(repository.getReplicaRows(scope, 'test_group_items')).resolves.toEqual([]);
    });

    it('standalone getReplicaRowsはreader leaseを保持し、完了までwriterを開始せずin-flight writeを観測しない', async () => {
      const scope = { userId: 1, scopeId: '10' };
      const initial: OfflineReplicaRow = {
        ...baseRow,
        ...scope,
        identity: generatedReplicaIdentity('019d-lease-read', 50),
        values: { id: 50, title: 'Before' },
        confirmedValues: { id: 50, title: 'Before' },
        serverRevision: 1,
        syncState: 'confirmed',
      };
      await repository.transactReplica({ putRows: [initial] });
      // Build indexes first so the deferred get is the leased partition read, not the write-lane build.
      await repository.getReplicaRows(scope, 'test_items');

      let releaseRead!: () => void;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let announceRead!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve;
      });
      const originalGet = storage.get.bind(storage);
      let deferPartitionRead = true;
      vi.spyOn(storage, 'get').mockImplementation(async <T>(key: string): Promise<T | null> => {
        if (deferPartitionRead && key === 'offline:replica:rows:index:v1:n:1:user:test_items') {
          deferPartitionRead = false;
          announceRead();
          await readGate;
        }
        return originalGet<T>(key);
      });

      const read = repository.getReplicaRows(scope, 'test_items');
      await readStarted;

      let writeFinished = false;
      const write = repository
        .transactReplica({
          putRows: [{ ...initial, values: { id: 50, title: 'After' }, confirmedValues: { id: 50, title: 'After' } }],
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
      const rowsBeforeRelease = storage.values.get('offline:replica:rows') as Record<string, OfflineReplicaRow>;
      expect(Object.values(rowsBeforeRelease)).toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'Before' }) })]);

      releaseRead();
      await expect(read).resolves.toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'Before' }) })]);
      await write;
      expect(writeFinished).toBe(true);

      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...initial,
              identity: generatedReplicaIdentity('019d-lease-read', 51),
              values: { id: 51, title: 'illegal-rebind' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remoteId is immutable');
      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toEqual([
        expect.objectContaining({
          values: expect.objectContaining({ title: 'After' }),
          identity: expect.objectContaining({ remoteId: 50 }),
        }),
      ]);
    });

    it('ready確認のawait中に開始したwriterを先に確定してからreaderを登録し、committed状態だけを観測する', async () => {
      const scope = { userId: 1, scopeId: '10' };
      const initial: OfflineReplicaRow = {
        ...baseRow,
        ...scope,
        identity: generatedReplicaIdentity('019d-admit-order', 60),
        values: { id: 60, title: 'Before' },
        confirmedValues: { id: 60, title: 'Before' },
        serverRevision: 1,
        syncState: 'confirmed',
      };
      await repository.transactReplica({ putRows: [initial] });
      // Indexes must already be ready so ensure only does an async ready check (admission gap).
      await repository.getReplicaRows(scope, 'test_items');

      let releaseReadyCheck!: () => void;
      const readyCheckGate = new Promise<void>((resolve) => {
        releaseReadyCheck = resolve;
      });
      let announceReadyCheck!: () => void;
      const readyCheckStarted = new Promise<void>((resolve) => {
        announceReadyCheck = resolve;
      });
      const originalGet = storage.get.bind(storage);
      let deferReadyCheck = true;
      vi.spyOn(storage, 'get').mockImplementation(async <T>(key: string): Promise<T | null> => {
        if (deferReadyCheck && key === 'offline:replica:rows:index:v1:ready') {
          deferReadyCheck = false;
          announceReadyCheck();
          await readyCheckGate;
        }
        return originalGet<T>(key);
      });

      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      let announceWrite!: () => void;
      const writeStarted = new Promise<void>((resolve) => {
        announceWrite = resolve;
      });
      const originalSet = storage.set.bind(storage);
      let deferRowsWrite = true;
      vi.spyOn(storage, 'set').mockImplementation(async <T>(key: string, value: T): Promise<T> => {
        if (deferRowsWrite && key === 'offline:replica:rows') {
          deferRowsWrite = false;
          announceWrite();
          await writeGate;
        }
        return originalSet(key, value);
      });

      const read = repository.getReplicaRows(scope, 'test_items');
      await readyCheckStarted;

      let writeFinished = false;
      const write = repository
        .transactReplica({
          putRows: [{ ...initial, values: { id: 60, title: 'After' }, confirmedValues: { id: 60, title: 'After' } }],
        })
        .then(() => {
          writeFinished = true;
        });
      void write.then(
        () => undefined,
        () => undefined,
      );
      await writeStarted;

      releaseReadyCheck();
      await Promise.resolve();
      await Promise.resolve();
      expect(writeFinished).toBe(false);
      // Reader must still be waiting on the write tail — not overlapping the in-flight write.
      let readSettled = false;
      void read.then(
        () => {
          readSettled = true;
        },
        () => {
          readSettled = true;
        },
      );
      await Promise.resolve();
      expect(readSettled).toBe(false);

      releaseWrite();
      await write;
      expect(writeFinished).toBe(true);
      await expect(read).resolves.toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'After' }) })]);
    });
  });

  describe('runReadSnapshot', () => {
    const scope = { userId: 1 as const, scopeId: '10' };
    const row: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: '019d-snap', remoteId: 7 },
      values: { id: 7, title: 'before' },
      confirmedValues: { id: 7, title: 'before' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    const command: OfflineCommand = {
      ...scope,
      commandId: 'cmd-snap',
      aggregateType: 'test_items',
      sourceKey: 'test_items',
      identity: generatedCommandIdentity('019d-snap'),
      operation: 'test_items.update',
      payload: {},
      baseRevision: 1,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };

    it('複数readを同一snapshotで一貫させ、in-flight writeのtorn readを防ぐ', async () => {
      await repository.transactReplica({ putRows: [row], putCommands: [command] });

      let releaseSnapshot: (() => void) | undefined;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      let writeStarted: (() => void) | undefined;
      const writeBegan = new Promise<void>((resolve) => {
        writeStarted = resolve;
      });

      const snapshot = repository.runReadSnapshot(async (reader) => {
        const commandsBefore = await reader.getCommands(scope);
        const write = repository.transactReplica({
          putRows: [{ ...row, values: { id: 7, title: 'after' }, confirmedValues: { id: 7, title: 'after' } }],
          putCommands: [{ ...command, state: 'retry_wait', retryAt: 99 }],
        });
        void write.then(
          () => undefined,
          () => undefined,
        );
        writeStarted?.();
        await snapshotGate;
        const rowsAfterWait = await reader.getReplicaRows(scope, 'test_items');
        const commandsAfterWait = await reader.getCommands(scope);
        return { commandsBefore, rowsAfterWait, commandsAfterWait, write };
      });

      await writeBegan;
      await Promise.resolve();
      expect(storage.values.get('offline:outbox:commands')).toEqual(
        expect.objectContaining({
          'cmd-snap': expect.objectContaining({ state: 'pending' }),
        }),
      );

      releaseSnapshot?.();
      const observed = await snapshot;
      await observed.write;

      expect(observed.commandsBefore).toEqual([expect.objectContaining({ commandId: 'cmd-snap', state: 'pending' })]);
      expect(observed.rowsAfterWait).toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'before' }) })]);
      expect(observed.commandsAfterWait).toEqual([expect.objectContaining({ state: 'pending' })]);
      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toEqual([
        expect.objectContaining({ values: expect.objectContaining({ title: 'after' }) }),
      ]);
    });

    it('独立した並行snapshotはそれぞれreader leaseを持ち、writerは両方の完了を待つ', async () => {
      await repository.transactReplica({ putRows: [row], putCommands: [command] });

      let releaseA: (() => void) | undefined;
      let releaseB: (() => void) | undefined;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      let bothReadersReady: (() => void) | undefined;
      const readersReady = new Promise<void>((resolve) => {
        bothReadersReady = resolve;
      });
      let readersHeld = 0;

      const snapshotA = repository.runReadSnapshot(async (reader) => {
        const before = await reader.getCommands(scope);
        readersHeld += 1;
        if (readersHeld === 2) bothReadersReady?.();
        await gateA;
        return before;
      });
      const snapshotB = repository.runReadSnapshot(async (reader) => {
        const before = await reader.getReplicaRows(scope, 'test_items');
        readersHeld += 1;
        if (readersHeld === 2) bothReadersReady?.();
        await gateB;
        return before;
      });

      await readersReady;
      let writeFinished = false;
      const write = repository
        .transactReplica({
          putRows: [{ ...row, values: { id: 7, title: 'after' }, confirmedValues: { id: 7, title: 'after' } }],
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

      releaseA?.();
      await snapshotA;
      await Promise.resolve();
      expect(writeFinished).toBe(false);

      releaseB?.();
      await expect(snapshotB).resolves.toEqual([expect.objectContaining({ values: expect.objectContaining({ title: 'before' }) })]);
      await write;
      expect(writeFinished).toBe(true);
      await expect(repository.getReplicaRows(scope, 'test_items')).resolves.toEqual([
        expect.objectContaining({ values: expect.objectContaining({ title: 'after' }) }),
      ]);
    });

    it('write開始前のvalidation失敗ではcommitted snapshotが変わらない', async () => {
      await repository.transactReplica({ putRows: [row], putCommands: [command] });
      await expect(
        repository.transactReplica({
          putRows: [
            {
              ...row,
              identity: { kind: 'generated', localId: '019d-snap', remoteId: 8 },
              values: { id: 8, title: 'illegal-rebind' },
            },
          ],
        }),
      ).rejects.toThrow('Offline replica remoteId is immutable');

      await expect(
        repository.runReadSnapshot(async (reader) => ({
          rows: await reader.getReplicaRows(scope, 'test_items'),
          commands: await reader.getCommands(scope),
        })),
      ).resolves.toEqual({
        rows: [
          expect.objectContaining({
            values: expect.objectContaining({ title: 'before' }),
            identity: expect.objectContaining({ remoteId: 7 }),
          }),
        ],
        commands: [expect.objectContaining({ commandId: 'cmd-snap', state: 'pending' })],
      });
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
