/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { TestBed } from '@angular/core/testing';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_EXECUTOR } from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  OFFLINE_REPLICA_PROJECTOR,
  OFFLINE_REPLICA_PULLER,
  type OfflineReplicaChange,
  type OfflineReplicaPullPage,
  type OfflineReplicaPullRequest,
} from './offline-replica-puller';
import { OfflineReplicaPullService, OfflineReplicaSchemaMismatchError } from './offline-replica-pull.service';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import { generatedCommandIdentity, generatedReplicaIdentity, rematerializeTestAggregate } from './offline-test-helpers';
import { OFFLINE_AGGREGATE_INTENT_PROJECTOR, type OfflineAggregateIntentProjector } from './offline-aggregate-intent-projector';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  integer,
  generatedId,
  localOnly,
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
    id: generatedId('integer'),
    title: text(),
  },
});

const testViewEntity = defineReplicaEntity<{ title: string }>()({
  table: 'test_views',
  sourceKey: 'test_views',
  scope: 'user',
  identity: localOnly(),
  fields: { title: text() },
});

const replicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [testItemEntity, testViewEntity],
  migrations: [],
});

const scope: OfflineScope = { userId: 1, scopeId: '10' };

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
  remoteIdValue: number,
  title: string,
  options: Partial<Pick<OfflineReplicaChange, 'serverRevision' | 'deleted' | 'values' | 'acknowledgedCommandIds'>> = {},
): OfflineReplicaChange {
  return {
    sourceKey: 'test_items',
    remoteId: remoteIdValue,
    serverRevision: options.serverRevision ?? 1,
    acknowledgedCommandIds: options.acknowledgedCommandIds ?? [],
    values: options.deleted ? null : (options.values ?? { id: remoteIdValue, title }),
    deleted: options.deleted ?? false,
  };
}

describe('OfflineReplicaPullService', () => {
  let service: OfflineReplicaPullService;
  let repository: OfflineRepository;
  let storage: MemoryStorage;
  let schemaHash: string;
  let pull: ReturnType<typeof vi.fn<(request: OfflineReplicaPullRequest) => Promise<OfflineReplicaPullPage>>>;
  let projector: { project: ReturnType<typeof vi.fn> };
  let aggregateProject: OfflineAggregateIntentProjector['project'];

  function page(
    changes: readonly OfflineReplicaChange[],
    options: {
      nextCursor?: string;
      hasMore?: boolean;
      schemaVersion?: number;
      schemaHash?: string;
      rebaselineRequired?: boolean;
    } = {},
  ): OfflineReplicaPullPage {
    return {
      schemaVersion: options.schemaVersion ?? replicaSchema.version,
      schemaHash: options.schemaHash ?? schemaHash,
      changes,
      nextCursor: options.nextCursor ?? 'cursor-v1',
      hasMore: options.hasMore ?? false,
      ...(options.rebaselineRequired ? { rebaselineRequired: true } : {}),
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
        { provide: OFFLINE_REPLICA_PROJECTOR, useValue: projector },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (command: Pick<OfflineCommand, 'operation' | 'aggregateType'>) => command.aggregateType },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR,
          useValue: { project: (...args: Parameters<typeof rematerializeTestAggregate>) => aggregateProject(...args) },
        },
      ],
    });
    repository = TestBed.inject(OFFLINE_REPOSITORY);
    service = TestBed.inject(OfflineReplicaPullService);
  }

  beforeEach(async () => {
    storage = new MemoryStorage();
    pull = vi.fn(async () => page([]));
    projector = { project: vi.fn(async () => ({})) };
    aggregateProject = rematerializeTestAggregate;
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
      reconciliationTargets: [],
    });
  });

  it('applies rebaseline reset, derived projection, base rows, and cursor in one transaction', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'stale', remoteId: 10 },
          values: { id: 10, title: 'Stale' },
          confirmedValues: { id: 10, title: 'Stale' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
      putCursors: [{ ...scope, cursor: 'expired' }],
    });
    projector.project.mockResolvedValue({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-42' },
          values: { title: 'Derived' },
          confirmedValues: { title: 'Derived' },
          serverRevision: null,
          fetchedAt: 2,
          syncState: 'confirmed',
        },
      ],
    });
    const transact = vi.spyOn(repository, 'transactReplica');
    pull.mockResolvedValueOnce(page([itemChange(42, 'Fresh')], { nextCursor: 'snapshot-1', rebaselineRequired: true }));

    await service.pull(scope);

    expect(transact).toHaveBeenCalledTimes(1);
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 10)).resolves.toBeNull();
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Fresh' },
    });
    await expect(repository.getReplicaRow(scope, 'test_views', { kind: 'local', localId: 'view-42' })).resolves.toMatchObject({
      values: { title: 'Derived' },
    });
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'snapshot-1' });
  });

  it('keeps snapshot and derived rows whose keys overlap the rebaseline removal set', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'existing', remoteId: 42 },
          values: { id: 42, title: 'Stale' },
          confirmedValues: { id: 42, title: 'Stale' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-42' },
          values: { title: 'Stale derived' },
          confirmedValues: { title: 'Stale derived' },
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
      putCursors: [{ ...scope, cursor: 'expired' }],
    });
    projector.project.mockResolvedValue({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-42' },
          values: { title: 'Fresh derived' },
          confirmedValues: { title: 'Fresh derived' },
          serverRevision: null,
          fetchedAt: 2,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Fresh')], { nextCursor: 'snapshot-1', rebaselineRequired: true }));

    await service.pull(scope);

    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Fresh' },
    });
    await expect(repository.getReplicaRow(scope, 'test_views', { kind: 'local', localId: 'view-42' })).resolves.toMatchObject({
      values: { title: 'Fresh derived' },
    });
  });

  it('preserves pending companions by canonical identity across user-scoped partitions', async () => {
    const otherScope = { userId: scope.userId, scopeId: '20' };
    const companion: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'shared', remoteId: 42 },
      values: { id: 42, title: 'Optimistic' },
      confirmedValues: { id: 42, title: 'Confirmed' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    await repository.transactReplica({
      putRows: [companion],
      putCommands: [
        {
          ...otherScope,
          commandId: 'other-scope-command',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'shared' },
          operation: 'test_items.update',
          payload: { title: 'Optimistic' },
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
      putCursors: [{ ...scope, cursor: 'expired' }],
    });
    pull
      .mockResolvedValueOnce(page([], { nextCursor: 'snapshot-1', rebaselineRequired: true, hasMore: true }))
      .mockResolvedValueOnce(page([], { nextCursor: 'snapshot-1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Optimistic' },
    });
  });

  it('keeps the previous replica durable until the first rebaseline snapshot can commit atomically', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'stale', remoteId: 10 },
          values: { id: 10, title: 'Stale' },
          confirmedValues: { id: 10, title: 'Stale' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
      putCursors: [{ ...scope, cursor: 'expired' }],
    });
    const transact = vi.spyOn(repository, 'transactReplica');
    transact.mockClear();
    pull
      .mockResolvedValueOnce(page([], { nextCursor: '', hasMore: true, rebaselineRequired: true }))
      .mockResolvedValueOnce(page([itemChange(42, 'Fresh')], { nextCursor: 'snapshot-1' }));

    await service.pull(scope);

    expect(pull.mock.calls.map(([request]) => request.cursor)).toEqual(['expired', '']);
    expect(transact).toHaveBeenCalledTimes(1);
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 10)).resolves.toBeNull();
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
      values: { title: 'Fresh' },
    });
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'snapshot-1' });
  });

  it('preserves the previous replica and cursor when the first rebaseline snapshot fails', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'stale', remoteId: 10 },
          values: { id: 10, title: 'Stale' },
          confirmedValues: { id: 10, title: 'Stale' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
      putCursors: [{ ...scope, cursor: 'expired' }],
    });
    pull
      .mockResolvedValueOnce(page([], { nextCursor: '', hasMore: true, rebaselineRequired: true }))
      .mockRejectedValueOnce(new Error('snapshot unavailable'));

    await expect(service.pull(scope)).rejects.toThrow('snapshot unavailable');

    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 10)).resolves.toMatchObject({
      values: { title: 'Stale' },
    });
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'expired' });
  });

  it('rejects a terminal rebaseline marker without clearing the previous replica', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'expired' }] });
    pull.mockResolvedValueOnce(page([], { nextCursor: '', rebaselineRequired: true }));

    await expect(service.pull(scope)).rejects.toThrow('Offline replica rebaseline marker must lead to a snapshot page.');

    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'expired' });
  });

  it('rejects projector attempts to mutate synchronized base rows without advancing the cursor', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    projector.project.mockResolvedValue({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: 'illegal', remoteId: 42 },
          values: { id: 42, title: 'Illegal' },
          confirmedValues: { id: 42, title: 'Illegal' },
          serverRevision: 2,
          fetchedAt: 2,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Fresh')], { nextCursor: 'cursor-v1' }));

    await expect(service.pull(scope)).rejects.toThrow('Offline replica projector may only mutate localOnly source "test_items".');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('does not hold the mutation lane during transport and preserves an enqueue completed before stale page apply', async () => {
    let releasePull!: (value: OfflineReplicaPullPage) => void;
    pull.mockImplementationOnce(() => new Promise((resolve) => (releasePull = resolve)));
    const pendingPull = service.pull(scope);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    const optimisticRow: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_items',
      identity: { kind: 'generated', localId: 'race-local', remoteId: 42 },
      values: { id: 42, title: 'Optimistic edit' },
      confirmedValues: { id: 42, title: 'Baseline' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'pending',
    };
    await coordinator.run(() =>
      repository.transactReplica({
        putRows: [optimisticRow],
        putCommands: [
          {
            ...scope,
            commandId: 'race-command',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: 'race-local' },
            operation: 'test_items.update',
            payload: { title: 'Optimistic edit' },
            baseRevision: 2,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
        ],
      }),
    );
    releasePull(page([itemChange(42, 'Server edit', { serverRevision: 2 })]));
    await pendingPull;

    await expect(repository.getReplicaRow(scope, 'test_items', optimisticRow.identity)).resolves.toMatchObject({
      values: { title: 'Optimistic edit' },
      confirmedValues: { title: 'Server edit' },
    });
  });

  it('exact schema version/hash handshakeを要求し、一致ページだけ受理する', async () => {
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(pull.mock.calls[0]?.[0].schemaVersion).toBe(1);
    expect(pull.mock.calls[0]?.[0].schemaHash).toBe(schemaHash);
  });

  it('wire protocol fingerprintをlocal replica schemaから独立して送受信検証する', async () => {
    const options = TestBed.inject(OFFLINE_KIT_OPTIONS);
    options.wireProtocol = { version: 7, hash: 'wire-v7' };
    pull.mockResolvedValueOnce(page([], { nextCursor: '', schemaVersion: 7, schemaHash: 'wire-v7' }));

    await service.pull(scope);

    expect(pull).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 7, schemaHash: 'wire-v7' }));
  });

  it('multi-page cursor progressionでstored cursorをページングする', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull
      .mockResolvedValueOnce(page([itemChange(42, 'Page 1')], { nextCursor: 'cursor-v1', hasMore: true }))
      .mockResolvedValueOnce(page([itemChange(43, 'Page 2')], { nextCursor: 'cursor-v2', hasMore: false }));

    await service.pull(scope);

    expect(pull.mock.calls.map(([request]) => request.cursor)).toEqual(['cursor-v0', 'cursor-v1']);
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v2' });
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).resolves.toMatchObject({
      confirmedValues: { title: 'Page 1' },
    });
    await expect(repository.getReplicaRowByRemoteId(scope, 'test_items', 43)).resolves.toMatchObject({
      confirmedValues: { title: 'Page 2' },
    });
  });

  it('row更新とcursor更新を同一transactReplica呼び出しで原子的に書く', async () => {
    const transactReplica = vi.spyOn(repository, 'transactReplica');
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(transactReplica).toHaveBeenCalledOnce();
    expect(transactReplica.mock.calls[0]?.[0]).toMatchObject({
      putRows: [
        expect.objectContaining({
          identity: expect.objectContaining({ kind: 'generated', remoteId: 42 }),
          confirmedValues: { title: 'Created' },
        }),
      ],
      putCursors: [{ ...scope, cursor: 'cursor-v1' }],
    });
  });

  it('new remote rowにlocal UUIDとserver IDを割り当てる', async () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue('019d0000-0000-7000-8000-000000000001');
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(
      repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d0000-0000-7000-8000-000000000001')),
    ).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d0000-0000-7000-8000-000000000001', remoteId: 42 },
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
          identity: { kind: 'generated', localId: '019d-existing', remoteId: 42 },
          values: { id: 42, title: 'Old' },
          confirmedValues: { id: 42, title: 'Old' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Updated', { serverRevision: 2 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-existing'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-existing', remoteId: 42 },
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
          identity: { kind: 'generated', localId: '019d-delete', remoteId: 42 },
          values: { id: 42, title: 'Gone' },
          confirmedValues: { id: 42, title: 'Gone' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Gone', { deleted: true, serverRevision: 2 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    expect(await repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-delete'))).toBeNull();
    expect(await repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).toBeNull();
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
      () => pull.mockResolvedValueOnce(page([itemChange(42, 'Broken', { values: { id: 42 } })], { nextCursor: 'cursor-v1' })),
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

    it('rejects a malformed rebaseline marker without advancing the cursor', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce({
            ...page([], { nextCursor: 'snapshot-1' }),
            rebaselineRequired: 'yes',
          } as unknown as OfflineReplicaPullPage),
        'Offline replica pull page rebaselineRequired must be a boolean when present.',
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

    it('non-positive remoteIdはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page([{ ...itemChange(42, 'Created'), remoteId: 0 } as unknown as OfflineReplicaChange], { nextCursor: 'cursor-v1' }),
          ),
        'Offline replica pull page changes[0].remoteId must be a valid generated remote id.',
      );
    });

    it('non-integer remoteIdはrejectしcursorを進めない', async () => {
      await expectPullRejectsPreservingCursor(
        () =>
          pull.mockResolvedValueOnce(
            page([{ ...itemChange(42, 'Created'), remoteId: 42.5 } as unknown as OfflineReplicaChange], { nextCursor: 'cursor-v1' }),
          ),
        'Offline replica pull page changes[0].remoteId must be a valid generated remote id.',
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
            page([{ ...itemChange(42, 'Gone', { deleted: true, serverRevision: 2 }), values: { id: 42, title: 'Gone' } }], {
              nextCursor: 'cursor-v1',
            }),
          ),
        'Offline replica pull page changes[0] with deleted=true must have null values.',
      );
    });
  });

  it('unknown source keyはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(
      page(
        [
          {
            sourceKey: 'unknown_items',
            remoteId: 42,
            serverRevision: 1,
            acknowledgedCommandIds: [],
            values: { id: 42, title: 'X' },
            deleted: false,
          },
        ],
        { nextCursor: 'cursor-v1' },
      ),
    );

    await expect(service.pull(scope)).rejects.toThrow('Unknown offline replica source key "unknown_items".');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('missing valuesはrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(
      page([{ sourceKey: 'test_items', remoteId: 42, serverRevision: 1, acknowledgedCommandIds: [], values: null, deleted: false }], {
        nextCursor: 'cursor-v1',
      }),
    );

    await expect(service.pull(scope)).rejects.toThrow('Offline replica change "test_items"/42 is missing values.');
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('schema mismatchはtyped errorでrejectしcursorを進めない', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Created')], { nextCursor: 'cursor-v1', schemaVersion: 99, schemaHash: 'deadbeef' }));

    const rejection = service.pull(scope);
    await expect(rejection).rejects.toBeInstanceOf(OfflineReplicaSchemaMismatchError);
    await expect(rejection).rejects.toMatchObject({
      code: OfflineReplicaSchemaMismatchError.code,
      clientVersion: 1,
      serverVersion: 99,
      serverHash: 'deadbeef',
    });
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

  it('unchanged empty deltaはmutation laneとrepository applyをスキップする', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(page([], { nextCursor: 'cursor-v0', hasMore: false }));
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    const run = vi.spyOn(coordinator, 'run');
    const transactReplica = vi.spyOn(repository, 'transactReplica');
    const getCommands = vi.spyOn(repository, 'getCommands');

    await service.pull(scope);

    expect(run).not.toHaveBeenCalled();
    expect(transactReplica).not.toHaveBeenCalled();
    expect(getCommands).toHaveBeenCalledOnce();
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
  });

  it('cursorを進めるempty pageはtransactReplicaでcursorを永続化する', async () => {
    await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
    pull.mockResolvedValueOnce(page([], { nextCursor: 'cursor-v1', hasMore: false }));
    const transactReplica = vi.spyOn(repository, 'transactReplica');

    await service.pull(scope);

    expect(transactReplica).toHaveBeenCalledOnce();
    expect(transactReplica.mock.calls[0]?.[0]).toMatchObject({
      putRows: [],
      removeRows: [],
      putCommands: [],
      removeCommandIds: [],
      putCursors: [{ ...scope, cursor: 'cursor-v1' }],
    });
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v1' });
  });

  it('pending optimistic rowはconfirmed baselineだけ更新しoptimistic valuesを保持する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-pending', remoteId: 42 },
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
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-pending' },
          operation: 'test_items.update',
          payload: { title: 'Optimistic draft' },
          baseRevision: 2,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Server truth', { serverRevision: 2 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-pending'))).resolves.toMatchObject({
      values: { title: 'Optimistic draft' },
      confirmedValues: { title: 'Server truth' },
      serverRevision: 2,
      syncState: 'pending',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([expect.objectContaining({ commandId: 'cmd-pending', state: 'pending' })]);
  });

  it('external revision rematerializes remaining pending intents onto the new confirmed baseline', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-conflict', remoteId: 42 },
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
          commandId: 'cmd-remaining',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-conflict' },
          operation: 'test_items.update',
          payload: { title: 'Local edit' },
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Remote truth', { serverRevision: 9 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-conflict'))).resolves.toMatchObject({
      values: { title: 'Local edit' },
      confirmedValues: { title: 'Remote truth' },
      serverRevision: 9,
      syncState: 'pending',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({
        commandId: 'cmd-remaining',
        state: 'pending',
        baseRevision: 9,
      }),
    ]);
  });

  it('external revision rematerializes remaining intents onto the new confirmed base and localOnly rows', async () => {
    const view: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_views',
      identity: { kind: 'local', localId: 'view-42' },
      values: { title: 'Local delta' },
      confirmedValues: { title: 'Old confirmed view' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    };
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-rebase', remoteId: 42 },
          values: { id: 42, title: 'Local delta' },
          confirmedValues: { id: 42, title: 'Old confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
        view,
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-remaining',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-rebase' },
          operation: 'test_items.update',
          payload: { title: 'Local delta' },
          localOnlyFootprint: [view],
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    projector.project.mockResolvedValue({
      putRows: [{ ...view, confirmedValues: { title: 'Remote view' } }],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Remote truth', { serverRevision: 9 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-rebase'))).resolves.toMatchObject({
      values: { title: 'Local delta' },
      confirmedValues: { title: 'Remote truth' },
      serverRevision: 9,
      syncState: 'pending',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({
        commandId: 'cmd-remaining',
        payload: { title: 'Local delta' },
        baseRevision: 9,
        state: 'pending',
      }),
    ]);
    await expect(repository.getReplicaRow(scope, 'test_views', { kind: 'local', localId: 'view-42' })).resolves.toMatchObject({
      values: { title: 'Local delta' },
      confirmedValues: { title: 'Remote view' },
    });
  });

  it('remote tombstone conflictはpending commandをremote_deleted conflictへ遷移する', async () => {
    const derived: OfflineReplicaRow = {
      ...scope,
      sourceKey: 'test_views',
      identity: { kind: 'local', localId: 'view-42' },
      values: { title: 'Pending delete' },
      confirmedValues: { title: 'Confirmed' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    };
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-tombstone', remoteId: 42 },
          values: { id: 42, title: 'Pending delete' },
          confirmedValues: { id: 42, title: 'Confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
        derived,
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-tombstone',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-tombstone' },
          operation: 'test_items.delete',
          payload: { title: 'Pending delete' },
          localOnlyFootprint: [derived],
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
        },
      ],
    });
    projector.project.mockResolvedValueOnce({ removeRows: [derived] });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Confirmed', { deleted: true, serverRevision: 2 })], { nextCursor: 'cursor-v1' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-tombstone'))).resolves.toMatchObject({
      identity: { kind: 'generated', localId: '019d-tombstone', remoteId: 42 },
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
    expect(await repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).not.toBeNull();
    await expect(repository.getReplicaRow(scope, 'test_views', derived.identity)).resolves.toMatchObject({
      values: { title: 'Pending delete' },
      confirmedValues: null,
      syncState: 'conflict',
    });
    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v1' });
  });

  describe('lost ACK correlation', () => {
    async function seedPendingCreate(localId = '019d-create'): Promise<void> {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: generatedReplicaIdentity(localId, null),
            values: { id: 0, title: 'Draft create' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-create',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: generatedCommandIdentity(localId),
            operation: 'test_items.create',
            payload: { title: 'Draft create' },
            baseRevision: null,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
        ],
      });
    }

    it('create lost ACKは既存localId行をreconcileしremoteIdを割り当ててcommandを除去する', async () => {
      await seedPendingCreate();
      pull.mockResolvedValueOnce(
        page([itemChange(42, 'Created', { serverRevision: 1, acknowledgedCommandIds: ['cmd-create'] })], { nextCursor: 'cursor-v1' }),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-create'))).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-create', remoteId: 42 },
        confirmedValues: { title: 'Created' },
        syncState: 'confirmed',
      });
      expect(await repository.getCommands(scope)).toEqual([]);
      expect(await repository.getReplicaRows(scope, 'test_items')).toHaveLength(1);
    });

    it('journal retention後のrebaselineでもawaiting-pull targetをhydrateしACK changeと同じtransactionで除去する', async () => {
      await seedPendingCreate();
      const current = (await repository.getCommands(scope))[0]!;
      await repository.putCommand({ ...current, state: 'awaiting_pull' });
      const row = (await repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-create')))!;
      await repository.transactReplica({
        putRows: [{ ...row, identity: { kind: 'generated', localId: '019d-create', remoteId: 42 } }],
      });
      pull.mockImplementationOnce(async (request) => {
        expect(request).toMatchObject({
          cursor: '',
          reconciliationTargets: [
            {
              commandId: 'cmd-create',
              operation: 'test_items.create',
              sourceKey: 'test_items',
              identity: { remoteId: 42 },
            },
          ],
        });
        return page([itemChange(42, 'Created after retention', { acknowledgedCommandIds: ['cmd-create'] })], {
          nextCursor: 'snapshot-after-retention',
          rebaselineRequired: true,
        });
      });

      await service.pull(scope);

      expect(await repository.getCommands(scope)).toEqual([]);
      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'snapshot-after-retention' });
      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-create'))).resolves.toMatchObject({
        confirmedValues: { title: 'Created after retention' },
        syncState: 'confirmed',
      });
    });

    it('generated deleteはrelease済みremote identityをdurable targetからreconcileする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-retained', remoteId: null },
            values: { id: 42, title: 'Pending delete' },
            confirmedValues: { id: 42, title: 'Confirmed' },
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
            visibility: 'pending_delete',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-delete-retained',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-retained' },
            operation: 'test_items.delete',
            payload: {},
            replicaMutation: 'delete',
            baseRevision: 1,
            state: 'awaiting_pull',
            attempts: 1,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
            reconciliationIdentity: { remoteId: 42 },
          },
        ],
      });
      pull.mockImplementationOnce(async (request) => {
        expect(request.reconciliationTargets).toEqual([
          expect.objectContaining({ commandId: 'cmd-delete-retained', identity: { remoteId: 42 } }),
        ]);
        return page([
          itemChange(43, 'Wrong delete', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-delete-retained'] }),
        ]);
      });

      await expect(service.pull(scope)).rejects.toThrow('does not match the requested remote identity');
      await expect(repository.getCommands(scope)).resolves.toEqual([expect.objectContaining({ commandId: 'cmd-delete-retained' })]);

      pull.mockResolvedValueOnce(
        page([itemChange(42, 'Deleted', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-delete-retained'] })]),
      );
      await service.pull(scope);

      expect(await repository.getCommands(scope)).toEqual([]);
      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-delete-retained'))).resolves.toBeNull();
    });

    it('update lost ACKはprefix commandを除去しfollowing commandをrebaseする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-update', remoteId: 42 },
            values: { id: 42, title: 'Follow-up edit' },
            confirmedValues: { id: 42, title: 'Confirmed baseline' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-update-1',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-update' },
            operation: 'test_items.update',
            payload: { title: 'First edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
          {
            ...scope,
            commandId: 'cmd-update-2',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-update' },
            operation: 'test_items.update',
            payload: { title: 'Follow-up edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 2,
            lastErrorCode: null,
          },
        ],
      });
      pull.mockResolvedValueOnce(
        page([itemChange(42, 'First edit applied', { serverRevision: 2, acknowledgedCommandIds: ['cmd-update-1'] })], {
          nextCursor: 'cursor-v1',
        }),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-update'))).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-update', remoteId: 42 },
        values: { title: 'Follow-up edit' },
        confirmedValues: { title: 'First edit applied' },
        serverRevision: 2,
        syncState: 'pending',
      });
      expect(await repository.getCommands(scope)).toEqual([
        expect.objectContaining({ commandId: 'cmd-update-2', baseRevision: 2, state: 'pending' }),
      ]);
    });

    it('delete lost ACKはfollowing commandが無ければ行を削除する', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-ack', remoteId: 42 },
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
            commandId: 'cmd-delete',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-ack' },
            operation: 'test_items.delete',
            payload: { title: 'Pending delete' },
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
        page([itemChange(42, 'Confirmed', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-delete'] })], {
          nextCursor: 'cursor-v1',
        }),
      );

      await service.pull(scope);

      expect(await repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-delete-ack'))).toBeNull();
      expect(await repository.getReplicaRowByRemoteId(scope, 'test_items', 42)).toBeNull();
      expect(await repository.getCommands(scope)).toEqual([]);
    });

    it('delete ACKは同じaggregateのfollowing commandをremote_deleted conflictへ遷移する', async () => {
      const base: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-delete-following', remoteId: 42 },
        values: { id: 42, title: 'Following upsert' },
        confirmedValues: { id: 42, title: 'Confirmed' },
        serverRevision: 1,
        fetchedAt: 1,
        syncState: 'pending',
      };
      const command = (commandId: string, operation: string, createdAt: number): OfflineCommand => ({
        ...scope,
        commandId,
        aggregateType: 'test_items',
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-delete-following' },
        operation,
        payload: { title: operation.endsWith('delete') ? 'Pending delete' : 'Following upsert' },
        replicaMutation: operation.endsWith('delete') ? 'delete' : 'upsert',
        baseRevision: 1,
        state: 'pending',
        attempts: 0,
        retryAt: null,
        createdAt,
        lastErrorCode: null,
      });
      await repository.transactReplica({
        putRows: [base],
        putCommands: [command('cmd-delete-ack', 'test_items.delete', 1), command('cmd-following-upsert', 'test_items.update', 2)],
      });
      pull.mockResolvedValueOnce(
        page([itemChange(42, 'Deleted', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-delete-ack'] })]),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-delete-following'))).resolves.toMatchObject(
        {
          values: { title: 'Following upsert' },
          confirmedValues: null,
          serverRevision: 2,
          syncState: 'conflict',
        },
      );
      await expect(repository.getCommands(scope)).resolves.toEqual([
        expect.objectContaining({ commandId: 'cmd-following-upsert', state: 'conflict', lastErrorCode: 'remote_deleted', retryAt: null }),
      ]);
    });

    it('同一pageでdelete ACKの後にtombstoneが続く場合はfollowing commandをconflictにして旧baselineを残さない', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-superseded', remoteId: 42 },
            values: { id: 42, title: 'Following upsert' },
            confirmedValues: { id: 42, title: 'Old confirmed baseline' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-delete-ack',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-superseded' },
            operation: 'test_items.delete',
            payload: { title: 'Pending delete' },
            replicaMutation: 'delete',
            baseRevision: 1,
            state: 'pending',
            attempts: 1,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
          {
            ...scope,
            commandId: 'cmd-following-upsert',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-delete-superseded' },
            operation: 'test_items.update',
            payload: { title: 'Following upsert' },
            replicaMutation: 'upsert',
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 2,
            lastErrorCode: null,
          },
        ],
      });
      pull.mockResolvedValueOnce(
        page([
          itemChange(42, 'Delete acknowledged', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-delete-ack'] }),
          itemChange(42, 'Remote tombstone', { deleted: true, serverRevision: 3 }),
        ]),
      );

      await service.pull(scope);

      await expect(
        repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-delete-superseded')),
      ).resolves.toMatchObject({
        values: { title: 'Following upsert' },
        confirmedValues: null,
        serverRevision: 3,
        syncState: 'conflict',
      });
      expect(await repository.getCommands(scope)).toEqual([
        expect.objectContaining({ commandId: 'cmd-following-upsert', state: 'conflict', lastErrorCode: 'remote_deleted' }),
      ]);
    });

    it('same-kind remoteId tombstone ACKが別idを返した場合はlocal identityを再割当しない', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-server-id-immutable', remoteId: 42 },
            values: { id: 42, title: 'Pending delete' },
            confirmedValues: { id: 42, title: 'Confirmed' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
            visibility: 'pending_delete',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-server-id-immutable',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-server-id-immutable' },
            operation: 'test_items.delete',
            payload: { title: 'Pending delete' },
            replicaMutation: 'delete',
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
        page([itemChange(43, 'Wrong identity', { deleted: true, serverRevision: 2, acknowledgedCommandIds: ['cmd-server-id-immutable'] })]),
      );

      await expect(service.pull(scope)).rejects.toThrow('Replica remote id is immutable: current=42, incoming=43.');
      await expect(
        repository.getReplicaRowIncludingPendingDelete?.(scope, 'test_items', generatedCommandIdentity('019d-server-id-immutable')),
      ).resolves.toMatchObject({
        identity: { kind: 'generated', localId: '019d-server-id-immutable', remoteId: 42 },
        visibility: 'pending_delete',
      });
    });

    it('duplicate deltaはacknowledgedCommandIdsをマージする', async () => {
      await seedPendingCreate();
      pull.mockResolvedValueOnce(
        page(
          [
            itemChange(42, 'Partial', { serverRevision: 1, acknowledgedCommandIds: ['cmd-create'] }),
            itemChange(42, 'Final', { serverRevision: 2, acknowledgedCommandIds: ['cmd-create'] }),
          ],
          { nextCursor: 'cursor-v1' },
        ),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-create'))).resolves.toMatchObject({
        confirmedValues: { title: 'Final' },
        serverRevision: 2,
        syncState: 'confirmed',
      });
      expect(await repository.getCommands(scope)).toEqual([]);
    });

    it('lost ACKの後に外部更新が同じpageへ入ってもfollowing commandを最新revisionへrebaseしない', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-lost-update', remoteId: 42 },
            values: { id: 42, title: 'Follow-up edit' },
            confirmedValues: { id: 42, title: 'Baseline' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-ack-lost',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-lost-update' },
            operation: 'test_items.update',
            payload: { title: 'First edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 1,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
          {
            ...scope,
            commandId: 'cmd-following',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-lost-update' },
            operation: 'test_items.update',
            payload: { title: 'Follow-up edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 2,
            lastErrorCode: null,
          },
        ],
      });
      pull.mockResolvedValueOnce(
        page(
          [
            itemChange(42, 'First edit applied', {
              serverRevision: 2,
              acknowledgedCommandIds: ['cmd-ack-lost'],
            }),
            itemChange(42, 'Other device edit', {
              serverRevision: 3,
              acknowledgedCommandIds: ['cmd-other-device'],
            }),
          ],
          { nextCursor: 'cursor-v1' },
        ),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-lost-update'))).resolves.toMatchObject({
        values: { title: 'Follow-up edit' },
        confirmedValues: { title: 'Other device edit' },
        serverRevision: 3,
        syncState: 'conflict',
      });
      await expect(repository.getCommands(scope)).resolves.toEqual([
        expect.objectContaining({
          commandId: 'cmd-following',
          baseRevision: 1,
          state: 'conflict',
          lastErrorCode: 'remote_revision',
        }),
      ]);
    });

    it('page内のackが全て他端末由来ならlocal commandをconflictへ遷移しない', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-other-acks', remoteId: 42 },
            values: { id: 42, title: 'Local edit' },
            confirmedValues: { id: 42, title: 'Baseline' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-local',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-other-acks' },
            operation: 'test_items.update',
            payload: { title: 'Local edit' },
            baseRevision: 3,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
        ],
      });
      pull.mockResolvedValueOnce(
        page(
          [
            itemChange(42, 'Other device edit 1', {
              serverRevision: 2,
              acknowledgedCommandIds: ['cmd-other-1'],
            }),
            itemChange(42, 'Other device edit 2', {
              serverRevision: 3,
              acknowledgedCommandIds: ['cmd-other-2'],
            }),
          ],
          { nextCursor: 'cursor-v1' },
        ),
      );

      await service.pull(scope);

      await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-other-acks'))).resolves.toMatchObject({
        confirmedValues: { title: 'Other device edit 2' },
        serverRevision: 3,
        syncState: 'pending',
      });
      await expect(repository.getCommands(scope)).resolves.toEqual([
        expect.objectContaining({ commandId: 'cmd-local', baseRevision: 3, state: 'pending' }),
      ]);
    });

    it('skipped-prefix acknowledgementはrejectする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-skip', remoteId: 42 },
            values: { id: 42, title: 'Second edit' },
            confirmedValues: { id: 42, title: 'Baseline' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'pending',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-first',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-skip' },
            operation: 'test_items.update',
            payload: { title: 'First edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
          {
            ...scope,
            commandId: 'cmd-second',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-skip' },
            operation: 'test_items.update',
            payload: { title: 'Second edit' },
            baseRevision: 1,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 2,
            lastErrorCode: null,
          },
        ],
      });
      await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
      pull.mockResolvedValueOnce(
        page([itemChange(42, 'Only second', { serverRevision: 2, acknowledgedCommandIds: ['cmd-second'] })], { nextCursor: 'cursor-v1' }),
      );

      await expect(service.pull(scope)).rejects.toThrow('Replica acknowledgement skipped an earlier aggregate command.');
      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
      expect(await repository.getCommands(scope)).toHaveLength(2);
    });

    it('server id collisionはrejectする', async () => {
      await repository.transactReplica({
        putRows: [
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-local-a', remoteId: null },
            values: { id: 0, title: 'Pending create A' },
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: 1,
            syncState: 'pending',
          },
          {
            ...scope,
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-local-b', remoteId: 99 },
            values: { id: 99, title: 'Existing remote' },
            confirmedValues: { id: 99, title: 'Existing remote' },
            serverRevision: 1,
            fetchedAt: 1,
            syncState: 'confirmed',
          },
        ],
        putCommands: [
          {
            ...scope,
            commandId: 'cmd-create-a',
            aggregateType: 'test_items',
            sourceKey: 'test_items',
            identity: { kind: 'generated', localId: '019d-local-a' },
            operation: 'test_items.create',
            payload: { title: 'Pending create A' },
            baseRevision: null,
            state: 'pending',
            attempts: 0,
            retryAt: null,
            createdAt: 1,
            lastErrorCode: null,
          },
        ],
      });
      await repository.transactReplica({ putCursors: [{ ...scope, cursor: 'cursor-v0' }] });
      pull.mockResolvedValueOnce(
        page([itemChange(99, 'Collision', { serverRevision: 2, acknowledgedCommandIds: ['cmd-create-a'] })], { nextCursor: 'cursor-v1' }),
      );

      await expect(service.pull(scope)).rejects.toThrow('Server id 99 is already mapped to another local replica row.');
      await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v0' });
    });
  });

  it('acknowledgedCommandIds欠落changeは外部変更として受理する', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-external', remoteId: 42 },
          values: { id: 42, title: 'Local baseline' },
          confirmedValues: { id: 42, title: 'Local baseline' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(
      page(
        [
          {
            sourceKey: 'test_items',
            remoteId: 42,
            serverRevision: 2,
            values: { id: 42, title: 'Remote edit' },
            deleted: false,
          },
        ],
        { nextCursor: 'cursor-v1' },
      ),
    );

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-external'))).resolves.toMatchObject({
      values: { title: 'Remote edit' },
      confirmedValues: { title: 'Remote edit' },
      serverRevision: 2,
      syncState: 'confirmed',
    });
  });

  it('revision-sensitive projector conflict advances the cursor while preserving the local display', async () => {
    await repository.transactReplica({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-sensitive', remoteId: 42 },
          values: { id: 42, title: 'Pending absolute intent' },
          confirmedValues: { id: 42, title: 'Old confirmed' },
          serverRevision: 1,
          fetchedAt: 1,
          syncState: 'pending',
        },
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-sensitive' },
          values: { title: 'Optimistic derived' },
          confirmedValues: { title: 'Old derived' },
          serverRevision: null,
          fetchedAt: 1,
          syncState: 'pending',
        },
      ],
      putCommands: [
        {
          ...scope,
          commandId: 'cmd-sensitive',
          aggregateType: 'test_items',
          sourceKey: 'test_items',
          identity: { kind: 'generated', localId: '019d-sensitive' },
          operation: 'test_items.absolute',
          payload: { title: 'Pending absolute intent' },
          baseRevision: 1,
          state: 'pending',
          attempts: 0,
          retryAt: null,
          createdAt: 1,
          lastErrorCode: null,
          localOnlyFootprint: [
            {
              ...scope,
              sourceKey: 'test_views',
              identity: { kind: 'local', localId: 'view-sensitive' },
            },
          ],
        },
      ],
    });
    aggregateProject = (input) =>
      input.trigger === 'pull' ? { kind: 'conflict', reason: 'revision_sensitive' } : rematerializeTestAggregate(input);
    projector.project.mockResolvedValueOnce({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-sensitive' },
          values: { title: 'Remote derived' },
          confirmedValues: { title: 'Remote derived' },
          serverRevision: null,
          fetchedAt: 2,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Remote edit', { serverRevision: 2 })], { nextCursor: 'cursor-v2' }));

    await service.pull(scope);

    await expect(repository.getReplicaCursor(scope)).resolves.toEqual({ ...scope, cursor: 'cursor-v2' });
    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-sensitive'))).resolves.toMatchObject({
      values: { title: 'Pending absolute intent' },
      confirmedValues: { title: 'Remote edit' },
      serverRevision: 2,
      syncState: 'conflict',
    });
    await expect(repository.getCommands(scope)).resolves.toEqual([
      expect.objectContaining({ commandId: 'cmd-sensitive', state: 'conflict', lastErrorCode: 'revision_sensitive' }),
    ]);
    await expect(repository.getReplicaRow(scope, 'test_views', { kind: 'local', localId: 'view-sensitive' })).resolves.toMatchObject({
      values: { title: 'Optimistic derived' },
      confirmedValues: { title: 'Remote derived' },
      syncState: 'conflict',
    });

    projector.project.mockResolvedValueOnce({
      putRows: [
        {
          ...scope,
          sourceKey: 'test_views',
          identity: { kind: 'local', localId: 'view-sensitive' },
          values: { title: 'Newer remote derived' },
          confirmedValues: { title: 'Newer remote derived' },
          serverRevision: null,
          fetchedAt: 3,
          syncState: 'confirmed',
        },
      ],
    });
    pull.mockResolvedValueOnce(page([itemChange(42, 'Newer remote edit', { serverRevision: 3 })], { nextCursor: 'cursor-v3' }));

    await service.pull(scope);

    await expect(repository.getReplicaRow(scope, 'test_items', generatedCommandIdentity('019d-sensitive'))).resolves.toMatchObject({
      values: { title: 'Pending absolute intent' },
      confirmedValues: { title: 'Newer remote edit' },
      serverRevision: 3,
      syncState: 'conflict',
    });
    await expect(repository.getReplicaRow(scope, 'test_views', { kind: 'local', localId: 'view-sensitive' })).resolves.toMatchObject({
      values: { title: 'Optimistic derived' },
      confirmedValues: { title: 'Newer remote derived' },
      syncState: 'conflict',
    });
  });

  it('optional getCommandsForUser未実装repositoryでもpullがthrowしない', async () => {
    TestBed.resetTestingModule();
    pull = vi.fn(async () => page([]));
    TestBed.configureTestingModule({
      providers: [
        OfflineReplicaPullService,
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', replicaSchema } },
        { provide: OFFLINE_REPLICA_PULLER, useValue: { pull } },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (command: Pick<OfflineCommand, 'operation' | 'aggregateType'>) => command.aggregateType },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: OFFLINE_REPOSITORY,
          useValue: {
            getReplicaCursor: vi.fn(async () => null),
            getCommands: vi.fn(async () => []),
            transactReplica: vi.fn(async () => undefined),
            getReplicaRow: vi.fn(async () => null),
            getReplicaRowByRemoteId: vi.fn(async () => null),
            getReplicaRowByRemoteIdentity: vi.fn(async (_scope, _sourceKey, identity) => {
              if (identity.remoteId === undefined) throw new Error('Natural identity unsupported');
              return null;
            }),
          },
        },
      ],
    });
    service = TestBed.inject(OfflineReplicaPullService);
    await expect(service.pull(scope)).resolves.toBeUndefined();
  });

  it('non-finite numeric serverRevisionはrejectしcursorを進めない', async () => {
    await expectPullRejectsPreservingCursor(
      () => pull.mockResolvedValueOnce(page([{ ...itemChange(42, 'Created'), serverRevision: Number.NaN }], { nextCursor: 'cursor-v1' })),
      'Offline replica pull page changes[0].serverRevision must be a string or number.',
    );
  });
});
