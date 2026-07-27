import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_EXECUTOR } from './offline-command-executor';
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
  type OfflineCommand,
  type OfflineRepository,
  type OfflineScope,
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
}

const entity = defineReplicaEntity<{ favFrom: number; favTo: string; label: string }>()({
  table: 'natural_favorites',
  sourceKey: 'natural_favorites',
  scope: 'partition',
  identity: naturalKey(['favFrom', 'favTo']),
  fields: { favFrom: integer(), favTo: text(), label: text() },
});

const schema = defineOfflineReplicaSchema({ version: 1, entities: [entity], migrations: [] });
const scope: OfflineScope = { userId: 1, scopeId: '10' };

describe('natural-key pull reconciliation', () => {
  it('same-page lost ACK keeps UUID, pending tombstone conflicts, and wrong identity kind rejects', async () => {
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
            naturalKey: { favFrom: 7, favTo: '42' },
            serverRevision: 1,
            acknowledgedCommandIds: ['create-1'],
            values: { favFrom: 7, favTo: '42', label: 'intermediate' },
            deleted: false,
          },
          {
            sourceKey: 'natural_favorites',
            naturalKey: { favFrom: 7, favTo: '42' },
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
            naturalKey: { favFrom: 7, favTo: '42' },
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
            serverId: 7,
            serverRevision: 4,
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
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute: vi.fn(),
            withServerRevision: (command: OfflineCommand, revision: string | number) => ({ ...command, baseRevision: revision }),
          },
        },
      ],
    });
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    const service = TestBed.inject(OfflineReplicaPullService);
    await repository.initialize();
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'natural_favorites',
          localId: 'immutable-local-uuid',
          serverId: null,
          values: { favFrom: 7, favTo: '42', label: 'optimistic' },
          confirmedValues: null,
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'create-1',
          aggregateType: 'natural_favorites',
          aggregateLocalId: 'immutable-local-uuid',
          operation: 'create',
          payload: {},
          optimisticValue: { favFrom: 7, favTo: '42', label: 'optimistic' },
          payloadHash: 'hash',
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
        localId: 'immutable-local-uuid',
        serverId: null,
        values: { favFrom: 7, favTo: '42', label: 'confirmed' },
      }),
    ]);
    await expect(repository.getCommands(scope)).resolves.toEqual([]);

    await repository.transactReplica({
      putRows: [
        {
          ...(await repository.getReplicaRow(scope, 'natural_favorites', 'immutable-local-uuid'))!,
          values: { favFrom: 7, favTo: '42', label: 'pending edit' },
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'update-1',
          aggregateType: 'natural_favorites',
          aggregateLocalId: 'immutable-local-uuid',
          operation: 'update',
          payload: {},
          optimisticValue: { favFrom: 7, favTo: '42', label: 'pending edit' },
          payloadHash: 'hash-2',
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
        localId: 'immutable-local-uuid',
        values: { favFrom: 7, favTo: '42', label: 'pending edit' },
        syncState: 'conflict',
      }),
    ]);
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({ commandId: 'update-1', state: 'conflict', lastErrorCode: 'remote_deleted' }),
    ]);

    await expect(service.pull(scope)).rejects.toThrow('requires naturalKey identity');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: '2' });
  });
});
