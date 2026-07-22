import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  OFFLINE_REPLICA_PULLER,
  type OfflineReplicaChange,
  type OfflineReplicaPullPage,
  type OfflineReplicaPullRequest,
} from './offline-replica-puller';
import { OfflineReplicaPullService } from './offline-replica-pull.service';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  serverId,
  sha256OfflineReplicaSchema,
  text,
} from './offline-replica-schema';
import {
  IonicOfflineRepository,
  OFFLINE_REPOSITORY,
  OFFLINE_SCHEMA_VERSION,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';

type TestItemSelect = { id: number; title: string };

const testItemEntity = defineReplicaEntity<TestItemSelect>()({
  table: 'test_items',
  sourceKey: 'test_items',
  scope: 'user',
  fields: {
    id: serverId(),
    title: text(),
  },
});

const replicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemEntity],
  migrations: [],
});

const scope: OfflineScope = { userId: 1, groupId: 10 };

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

function itemChange(
  serverIdValue: number,
  title: string,
  options: Partial<Pick<OfflineReplicaChange, 'serverRevision' | 'deleted' | 'values'>> = {},
): OfflineReplicaChange {
  return {
    sourceKey: 'test_items',
    serverId: serverIdValue,
    serverRevision: options.serverRevision ?? 1,
    values: options.deleted ? null : (options.values ?? { id: serverIdValue, title }),
    deleted: options.deleted ?? false,
  };
}

describe('OfflineReplicaPullService', () => {
  let service: OfflineReplicaPullService;
  let repository: OfflineRepository;
  let storage: MemoryStorage;
  let schemaHash: string;
  let pull: ReturnType<typeof vi.fn<(request: OfflineReplicaPullRequest) => Promise<OfflineReplicaPullPage>>>;

  function page(
    changes: readonly OfflineReplicaChange[],
    options: {
      nextCursor?: string;
      hasMore?: boolean;
      schemaVersion?: number;
      schemaHash?: string;
    } = {},
  ): OfflineReplicaPullPage {
    return {
      schemaVersion: options.schemaVersion ?? replicaSchema.version,
      schemaHash: options.schemaHash ?? schemaHash,
      changes,
      nextCursor: options.nextCursor ?? 'cursor-v1',
      hasMore: options.hasMore ?? false,
    };
  }

  async function expectPullRejectsPreservingCursor(setup: () => void, message: string | RegExp): Promise<void> {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    setup();
    await expect(service.pull(scope)).rejects.toThrow(message);
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
    expect(await repository.getReplicaRows(scope, 'test_items')).toEqual([]);
  }

  async function seedReplicaMetadata(): Promise<void> {
    schemaHash = await sha256OfflineReplicaSchema(replicaSchema);
    storage.values.set('offline:metadata', {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      lastUserId: null,
      replicaSchemaVersion: replicaSchema.version,
      replicaSchemaHash: schemaHash,
    });
    storage.values.set('offline:replica:rows', {});
    storage.values.set('offline:outbox:commands', {});
    storage.values.set('offline:replica:cursors', {});
  }

  function configureTestBed(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        OfflineReplicaPullService,
        IonicOfflineRepository,
        { provide: KitStorageService, useValue: storage },
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', replicaSchema } },
        { provide: OFFLINE_REPOSITORY, useExisting: IonicOfflineRepository },
        { provide: OFFLINE_REPLICA_PULLER, useValue: { pull } },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (command: Pick<OfflineCommand, 'operation' | 'aggregateType'>) => command.aggregateType },
        },
      ],
    });
    repository = TestBed.inject(OFFLINE_REPOSITORY);
    service = TestBed.inject(OfflineReplicaPullService);
  }

  beforeEach(async () => {
    storage = new MemoryStorage();
    pull = vi.fn(async () => page([]));
    await seedReplicaMetadata();
    configureTestBed();
    await repository.initialize();
  });

  it('initial empty cursor requestをpullerへ送る', async () => {
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(pull).toHaveBeenCalledOnce();
    expect(pull.mock.calls[0]?.[0]).toEqual({
      scope,
      cursor: '',
      schemaVersion: replicaSchema.version,
      schemaHash,
    });
  });

  it('exact schema version/hash handshakeを要求し、一致ページだけ受理する', async () => {
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(pull.mock.calls[0]?.[0].schemaVersion).toBe(1);
    expect(pull.mock.calls[0]?.[0].schemaHash).toBe(schemaHash);
  });

  it('multi-page cursor progressionでstored cursorをページングする', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull
      .mockResolvedValueOnce(page([itemChange(42, 'Page 1')], { nextCursor: 'cursor-v1', hasMore: true }))
      .mockResolvedValueOnce(page([itemChange(43, 'Page 2')], { nextCursor: 'cursor-v2', hasMore: false }));

    await service.pull(scope);

    expect(pull.mock.calls.map(([request]) => request.cursor)).toEqual(['cursor-v0', 'cursor-v1']);
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v2' });
    await expect(repository.getReplicaRowByServerId(scope, 'test_items', 42)).resolves.toMatchObject({
      confirmedValues: { title: 'Page 1' },
    });
    await expect(repository.getReplicaRowByServerId(scope, 'test_items', 43)).resolves.toMatchObject({
      confirmedValues: { title: 'Page 2' },
    });
  });

  it('row更新とcursor更新を同一transactReplica呼び出しで原子的に書く', async () => {
    const transactReplica = vi.spyOn(repository, 'transactReplica');
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(transactReplica).toHaveBeenCalledOnce();
    expect(transactReplica.mock.calls[0]?.[0]).toMatchObject({
      putRows: [expect.objectContaining({ serverId: 42, confirmedValues: { title: 'Created' } })],
      putCursors: [{ ...scope, cursor: 'cursor-v1' }],
    });
  });

  it('new remote rowにlocal UUIDとserver IDを割り当てる', async () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('019d0000-0000-7000-8000-000000000001');
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', '019d0000-0000-7000-8000-000000000001')).resolves.toMatchObject({
      localId: '019d0000-0000-7000-8000-000000000001',
      serverId: 42,
      sourceKey: 'test_items',
      syncState: 'confirmed',
      values: { title: 'Created' },
      confirmedValues: { title: 'Created' },
    });
    randomUuid.mockRestore();
  });

  it('existing remote rowをupdateする', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          localId: '019d-existing',
          serverId: 42,
          values: { id: 42, title: 'Old' },
          confirmedValues: { id: 42, title: 'Old' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Updated', { serverRevision: 2 })], { nextCursor: 'cursor-v1' }),
    );

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', '019d-existing')).resolves.toMatchObject({
      localId: '019d-existing',
      serverId: 42,
      serverRevision: 2,
      values: { title: 'Updated' },
      confirmedValues: { title: 'Updated' },
      syncState: 'confirmed',
    });
  });

  it('pending commandが無いdeleteはreplica rowを削除する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          localId: '019d-delete',
          serverId: 42,
          values: { id: 42, title: 'Gone' },
          confirmedValues: { id: 42, title: 'Gone' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Gone', { deleted: true, serverRevision: 2 })], { nextCursor: 'cursor-v1' }),
    );

    await service.pull(scope);

    expect(await repository.getReplicaRow(scope, 'test_items', '019d-delete')).toBeNull();
    expect(await repository.getReplicaRowByServerId(scope, 'test_items', 42)).toBeNull();
  });

  it('duplicate changeはlast-winsでcollapseする', async () => {
    pull.mockResolvedValueOnce(
      page(
        [
          itemChange(42, 'First', { serverRevision: 1 }),
          itemChange(42, 'Second', { serverRevision: 2 }),
          itemChange(42, 'Third', { serverRevision: 3 }),
        ],
        { nextCursor: 'cursor-v1' },
      ),
    );

    await service.pull(scope);

    const rows = await repository.getReplicaRows(scope, 'test_items');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      confirmedValues: { title: 'Third' },
      serverRevision: 3,
    });
  });

  it('invalid valuesはrejectしcursorを進めない', async () => {
    await expectPullRejectsPreservingCursor(
      () =>
        pull.mockResolvedValueOnce(
          page([itemChange(42, 'Broken', { values: { id: 42 } })], { nextCursor: 'cursor-v1' }),
        ),
      'Replica row is missing required source key "title".',
    );
  });

  describe('pull page boundary validation', () => {
    it('malformed nextCursorはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce({
            ...page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }),
            nextCursor: 1 as unknown as string,
          }),
        'Offline replica pull page nextCursor must be a string.',
      );
    });

    it('malformed hasMoreはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce({
            ...page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }),
            hasMore: 'yes' as unknown as boolean,
          }),
        'Offline replica pull page hasMore must be a boolean.',
      );
    });

    it('malformed changesはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce({
            ...page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }),
            changes: null as unknown as OfflineReplicaChange[],
          }),
        'Offline replica pull page changes must be an array.',
      );
    });

    it('non-positive serverIdはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page([{ ...itemChange(42, 'Created'), serverId: 0 }], { nextCursor: 'cursor-v1' }),
          ),
        'Offline replica pull page changes[0].serverId must be a positive integer.',
      );
    });

    it('non-integer serverIdはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page([{ ...itemChange(42, 'Created'), serverId: 42.5 }], { nextCursor: 'cursor-v1' }),
          ),
        'Offline replica pull page changes[0].serverId must be a positive integer.',
      );
    });

    it('invalid serverRevision typeはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page([{ ...itemChange(42, 'Created'), serverRevision: true as unknown as number }], {
              nextCursor: 'cursor-v1',
            }),
          ),
        'Offline replica pull page changes[0].serverRevision must be a string or number.',
      );
    });

    it('deleted change with non-null valuesはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page(
              [{ ...itemChange(42, 'Gone', { deleted: true, serverRevision: 2 }), values: { id: 42, title: 'Gone' } }],
              { nextCursor: 'cursor-v1' },
            ),
          ),
        'Offline replica pull page changes[0] with deleted=true must have null values.',
      );
    });
  });

  it('unknown source keyはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(
      page(
        [{ sourceKey: 'unknown_items', serverId: 42, serverRevision: 1, values: { id: 42, title: 'X' }, deleted: false }],
        { nextCursor: 'cursor-v1' },
      ),
    );

    await expect(service.pull(scope)).rejects.toThrow('Unknown offline replica source key "unknown_items".');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('missing valuesはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(
      page([{ sourceKey: 'test_items', serverId: 42, serverRevision: 1, values: null, deleted: false }], {
        nextCursor: 'cursor-v1',
      }),
    );

    await expect(service.pull(scope)).rejects.toThrow('Offline replica change "test_items"/42 is missing values.');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('schema mismatchはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1', schemaVersion: 99, schemaHash: 'deadbeef' }),
    );

    await expect(service.pull(scope)).rejects.toThrow('Offline replica schema mismatch');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
    expect(await repository.getReplicaRows(scope, 'test_items')).toEqual([]);
  });

  it('non-advancing cursorはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v0', hasMore: true }));

    await expect(service.pull(scope)).rejects.toThrow('Offline replica pull cursor did not advance');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
    expect(await repository.getReplicaRows(scope, 'test_items')).toEqual([]);
  });

  it('pending optimistic rowはconfirmed baselineだけ更新しoptimistic valuesを保持する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          localId: '019d-pending',
          serverId: 42,
          values: { id: 42, title: 'Optimistic draft' },
          confirmedValues: { id: 42, title: 'Confirmed baseline' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-pending',
          aggregateType: 'test_items',
          aggregateLocalId: '019d-pending',
          operation: 'test_items.update',
          payload: { title: 'Optimistic draft' },
          optimisticValue: { id: 42, title: 'Optimistic draft' },
          payloadHash: 'hash',
          baseRevision: 2,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Server truth', { serverRevision: 2 })], { nextCursor: 'cursor-v1' }),
    );

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', '019d-pending')).resolves.toMatchObject({
      values: { title: 'Optimistic draft' },
      confirmedValues: { title: 'Server truth' },
      serverRevision: 2,
      syncState: 'pending',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({ commandId: 'cmd-pending', state: 'pending' }),
    ]);
  });

  it('revision conflictはreplicaとcommandをconflictへ遷移する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          localId: '019d-conflict',
          serverId: 42,
          values: { id: 42, title: 'Local edit' },
          confirmedValues: { id: 42, title: 'Old confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-conflict',
          aggregateType: 'test_items',
          aggregateLocalId: '019d-conflict',
          operation: 'test_items.update',
          payload: { title: 'Local edit' },
          optimisticValue: { id: 42, title: 'Local edit' },
          payloadHash: 'hash',
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Remote truth', { serverRevision: 9 })], { nextCursor: 'cursor-v1' }),
    );

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', '019d-conflict')).resolves.toMatchObject({
      syncState: 'conflict',
      confirmedValues: { title: 'Remote truth' },
      serverRevision: 9,
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({
        commandId: 'cmd-conflict',
        state: 'conflict',
        lastErrorCode: 'remote_revision',
        retryAt: null,
      }),
    ]);
  });

  it('remote tombstone conflictはpending commandをremote_deleted conflictへ遷移する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          localId: '019d-tombstone',
          serverId: 42,
          values: { id: 42, title: 'Pending delete' },
          confirmedValues: { id: 42, title: 'Confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-tombstone',
          aggregateType: 'test_items',
          aggregateLocalId: '019d-tombstone',
          operation: 'test_items.delete',
          payload: {},
          optimisticValue: { id: 42, title: 'Pending delete' },
          payloadHash: 'hash',
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page([itemChange(42, 'Confirmed', { deleted: true, serverRevision: 2 })], { nextCursor: 'cursor-v1' }),
    );

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', '019d-tombstone')).resolves.toMatchObject({
      localId: '019d-tombstone',
      syncState: 'conflict',
      serverRevision: 2,
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({
        commandId: 'cmd-tombstone',
        state: 'conflict',
        lastErrorCode: 'remote_deleted',
        retryAt: null,
      }),
    ]);
    expect(await repository.getReplicaRowByServerId(scope, 'test_items', 42)).not.toBeNull();
  });
});
