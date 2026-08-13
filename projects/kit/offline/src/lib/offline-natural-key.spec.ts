import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OFFLINE_REPLICA_PULLER, type OfflineReplicaPullPage } from './offline-replica-puller';
import { OfflineReplicaPullService } from './offline-replica-pull.service';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  integer,
  naturalKey,
  sha256OfflineReplicaSchema,
  text,
} from './offline-replica-schema';
import {
  IonicOfflineRepository,
  OFFLINE_REPOSITORY,
  OFFLINE_SCHEMA_VERSION,
  parseOfflineCommandIdentity,
  serializeOfflineCommandIdentity,
  type OfflineCommand,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { OFFLINE_AGGREGATE_INTENT_PROJECTOR } from './offline-aggregate-intent-projector';
import { naturalCommandIdentity, naturalReplicaIdentity, rematerializeTestAggregate } from './offline-test-helpers';

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
}

const entity = defineReplicaEntity<{ favFrom: number; favTo: string; label: string }>()({
  table: 'natural_favorites',
  sourceKey: 'natural_favorites',
  scope: 'partition',
  identity: naturalKey(['favFrom', 'favTo']),
  fields: { favFrom: integer(), favTo: text(), label: text() },
});

const schema = defineOfflineReplicaSchema({ version: 1, entities: [entity], migrations: [] });
const threePartEntity = defineReplicaEntity<{ z: number; tenant: string; a: number; label: string }>()({
  table: 'three_part_keys',
  sourceKey: 'three_part_keys',
  scope: 'partition',
  identity: naturalKey(['z', 'tenant', 'a']),
  fields: { z: integer(), tenant: text(), a: integer(), label: text() },
});
const threePartSchema = defineOfflineReplicaSchema({ version: 1, entities: [threePartEntity], migrations: [] });
const scope: OfflineScope = { userId: 1, scopeId: '10' };

const key42 = { favFrom: 7, favTo: '42' };
const key43 = { favFrom: 7, favTo: '43' };

function naturalRow(
  naturalKeyValues: { favFrom: number; favTo: string },
  label: string,
  options: { syncState?: 'confirmed' | 'pending'; confirmedValues?: { favFrom: number; favTo: string; label: string } | null } = {},
) {
  return {
    ...scope,
    sourceKey: 'natural_favorites' as const,
    identity: naturalReplicaIdentity(naturalKeyValues),
    values: { ...naturalKeyValues, label },
    confirmedValues: options.confirmedValues ?? null,
    serverRevision: null,
    fetchedAt: 1,
    syncState: options.syncState ?? ('pending' as const),
  };
}

async function createRepository(replicaSchema = schema): Promise<OfflineRepository> {
  const storage = new MemoryStorage();
  const schemaHash = await sha256OfflineReplicaSchema(replicaSchema);
  storage.values.set('offline:metadata', {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    lastUserId: null,
    replicaSchemaVersion: replicaSchema.version,
    replicaSchemaHash: schemaHash,
  });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      IonicOfflineRepository,
      { provide: KitStorageService, useValue: storage },
      { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test', replicaSchema } },
      { provide: OFFLINE_REPOSITORY, useExisting: IonicOfflineRepository },
    ],
  });
  const repository = TestBed.inject(OFFLINE_REPOSITORY);
  await repository.initialize();
  return repository;
}

describe('natural-key replica identity', () => {
  it('uses exact composite natural identity as the row PRIMARY KEY', async () => {
    const repository = await createRepository();
    await repository.transactReplica({ putRows: [naturalRow(key42, 'A')] });

    await expect(repository.getReplicaRow(scope, 'natural_favorites', naturalCommandIdentity(key42))).resolves.toMatchObject({
      identity: { kind: 'natural', naturalKey: key42 },
      values: { favFrom: 7, favTo: '42', label: 'A' },
    });
    await expect(repository.getReplicaRows(scope, 'natural_favorites')).resolves.toEqual([
      expect.objectContaining({
        identity: { kind: 'natural', naturalKey: key42 },
      }),
    ]);
  });

  it('rejects rows whose identity naturalKey does not match values', async () => {
    const repository = await createRepository();
    await expect(
      repository.transactReplica({
        putRows: [
          {
            ...naturalRow(key42, 'mismatch'),
            identity: naturalReplicaIdentity(key42),
            values: { favFrom: 8, favTo: '42', label: 'mismatch' },
          },
        ],
      }),
    ).rejects.toThrow('Offline replica identity naturalKey must match values for "natural_favorites".');
    await expect(repository.getReplicaRow(scope, 'natural_favorites', naturalCommandIdentity(key42))).resolves.toBeNull();
  });

  it('treats natural key change as delete old row plus insert new row', async () => {
    const repository = await createRepository();
    await repository.transactReplica({ putRows: [naturalRow(key42, 'A')] });
    await expect(
      repository.transactReplica({
        putRows: [{ ...naturalRow(key42, 'changed'), values: { favFrom: 8, favTo: '42', label: 'changed' } }],
      }),
    ).rejects.toThrow('Offline replica identity naturalKey must match values for "natural_favorites".');

    await repository.transactReplica({
      removeRows: [{ ...scope, sourceKey: 'natural_favorites', identity: naturalReplicaIdentity(key42) }],
      putRows: [naturalRow(key43, 'B')],
    });
    await expect(repository.getReplicaRows(scope, 'natural_favorites')).resolves.toEqual([
      expect.objectContaining({ identity: { kind: 'natural', naturalKey: key43 }, values: { favFrom: 7, favTo: '43', label: 'B' } }),
    ]);
    await expect(repository.getReplicaRow(scope, 'natural_favorites', naturalCommandIdentity(key42))).resolves.toBeNull();
  });

  it('upserts the same natural key into one durable row', async () => {
    const repository = await createRepository();
    await repository.transactReplica({ putRows: [naturalRow(key42, 'first')] });
    await repository.transactReplica({
      putRows: [naturalRow(key42, 'second', { syncState: 'confirmed', confirmedValues: { ...key42, label: 'second' } })],
    });

    await expect(repository.getReplicaRows(scope, 'natural_favorites')).resolves.toHaveLength(1);
    await expect(repository.getReplicaRow(scope, 'natural_favorites', naturalCommandIdentity(key42))).resolves.toMatchObject({
      identity: { kind: 'natural', naturalKey: key42 },
      values: { favFrom: 7, favTo: '42', label: 'second' },
      confirmedValues: { favFrom: 7, favTo: '42', label: 'second' },
      syncState: 'confirmed',
    });
  });

  it('roundtrips natural command identity through outbox JSON', () => {
    const identity = naturalCommandIdentity(key42);
    const json = serializeOfflineCommandIdentity(identity);
    expect(parseOfflineCommandIdentity(JSON.parse(json))).toEqual(identity);
  });

  it('supports an ordered three-part mixed key for DDL, lookup, upsert, ordering, and remove', async () => {
    expect(threePartEntity.createTableSql[0]).toContain('PRIMARY KEY (_offline_user_id, _offline_scope_id, z, tenant, a)');
    const repository = await createRepository(threePartSchema);
    const firstKey = { z: 2, tenant: 'tenant-a', a: 9 };
    const secondKey = { z: 10, tenant: 'tenant-a', a: 1 };
    const row = (key: typeof firstKey, label: string) => ({
      ...scope,
      sourceKey: 'three_part_keys',
      identity: naturalReplicaIdentity(key),
      values: { ...key, label },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending' as const,
    });

    await repository.transactReplica({ putRows: [row(secondKey, 'second'), row(firstKey, 'first')] });
    await repository.transactReplica({ putRows: [row(firstKey, 'updated')] });
    await expect(repository.getReplicaRow(scope, 'three_part_keys', naturalCommandIdentity(firstKey))).resolves.toMatchObject({
      values: { label: 'updated' },
    });
    await expect(repository.getReplicaRows(scope, 'three_part_keys')).resolves.toEqual([
      expect.objectContaining({ identity: naturalReplicaIdentity(firstKey) }),
      expect.objectContaining({ identity: naturalReplicaIdentity(secondKey) }),
    ]);

    await repository.transactReplica({
      removeRows: [{ ...scope, sourceKey: 'three_part_keys', identity: naturalReplicaIdentity(firstKey) }],
    });
    await expect(repository.getReplicaRow(scope, 'three_part_keys', naturalCommandIdentity(firstKey))).resolves.toBeNull();
  });
});

describe('natural-key pull reconciliation', () => {
  it('ACKs create, pending tombstone conflicts, and rejects immutable naturalKey reassignment', async () => {
    const storage = new MemoryStorage();
    const schemaHash = await sha256OfflineReplicaSchema(schema);
    storage.values.set('offline:metadata', {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      lastUserId: null,
      replicaSchemaVersion: schema.version,
      replicaSchemaHash: schemaHash,
    });
    const pages: OfflineReplicaPullPage[] = [
      {
        schemaVersion: 1,
        schemaHash,
        changes: [
          {
            sourceKey: 'natural_favorites',
            naturalKey: key42,
            serverRevision: 1,
            acknowledgedCommandIds: ['create-1'],
            values: { favFrom: 7, favTo: '42', label: 'intermediate' },
            deleted: false,
          },
          {
            sourceKey: 'natural_favorites',
            naturalKey: key42,
            serverRevision: 2,
            values: { favFrom: 7, favTo: '42', label: 'confirmed' },
            deleted: false,
          },
        ],
        nextCursor: '1',
        hasMore: false,
      },
      {
        schemaVersion: 1,
        schemaHash,
        changes: [
          {
            sourceKey: 'natural_favorites',
            naturalKey: key42,
            serverRevision: 3,
            values: null,
            deleted: true,
          },
        ],
        nextCursor: '2',
        hasMore: false,
      },
      {
        schemaVersion: 1,
        schemaHash,
        changes: [
          {
            sourceKey: 'natural_favorites',
            naturalKey: key43,
            serverRevision: 4,
            acknowledgedCommandIds: ['update-1'],
            values: null,
            deleted: true,
          },
        ],
        nextCursor: '3',
        hasMore: false,
      },
    ];
    const pull = vi.fn(async () => pages.shift()!);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        OfflineReplicaPullService,
        IonicOfflineRepository,
        { provide: KitStorageService, useValue: storage },
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test', replicaSchema: schema } },
        { provide: OFFLINE_REPOSITORY, useExisting: IonicOfflineRepository },
        { provide: OFFLINE_REPLICA_PULLER, useValue: { pull } },
        { provide: OFFLINE_COMMAND_HOOKS, useValue: { entityType: (command: OfflineCommand) => command.aggregateType } },
        { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project: rematerializeTestAggregate } },
      ],
    });
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    const service = TestBed.inject(OfflineReplicaPullService);
    await repository.initialize();
    await repository.transactReplica({
      putRows: [naturalRow(key42, 'optimistic')],
      putCommands: [
        {
          ...scope,
          commandId: 'create-1',
          aggregateType: 'natural_favorites',
          sourceKey: 'natural_favorites',
          identity: naturalCommandIdentity(key42),
          operation: 'create',
          payload: { favTo: '42', label: 'optimistic' },
          baseRevision: null,
          state: 'pending',
          attempts: 1,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });

    await service.pull(scope);
    await expect(repository.getReplicaRows(scope, 'natural_favorites')).resolves.toEqual([
      expect.objectContaining({
        identity: { kind: 'natural', naturalKey: key42 },
        values: { favFrom: 7, favTo: '42', label: 'confirmed' },
        confirmedValues: { favFrom: 7, favTo: '42', label: 'confirmed' },
        syncState: 'confirmed',
      }),
    ]);
    await expect(repository.getCommands(scope)).resolves.toEqual([]);

    await repository.transactReplica({
      putRows: [
        {
          ...(await repository.getReplicaRow(scope, 'natural_favorites', naturalCommandIdentity(key42)))!,
          values: { favFrom: 7, favTo: '42', label: 'pending edit' },
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'update-1',
          aggregateType: 'natural_favorites',
          sourceKey: 'natural_favorites',
          identity: naturalCommandIdentity(key42),
          operation: 'update',
          payload: { favTo: '42', label: 'pending edit' },
          baseRevision: 2,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 2,
          lastErrorCode: null,
        },
      ],
    });
    await service.pull(scope);
    await expect(repository.getReplicaRows(scope, 'natural_favorites')).resolves.toEqual([
      expect.objectContaining({
        identity: { kind: 'natural', naturalKey: key42 },
        values: { favFrom: 7, favTo: '42', label: 'pending edit' },
        syncState: 'conflict',
      }),
    ]);
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({ commandId: 'update-1', state: 'conflict', lastErrorCode: 'remote_deleted' }),
    ]);

    await expect(service.pull(scope)).rejects.toThrow('Replica naturalKey is immutable for "natural_favorites".');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: '2' });
  });
});
