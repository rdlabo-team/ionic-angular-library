import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_COMMAND_EXECUTOR,
  OFFLINE_SYNC_CONTEXT,
  offlineCommandWithBaseRevision,
  type OfflineCommandResult,
  type OfflineCommandTarget,
} from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS, type OfflineKitOptions } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineMutationAdmissionService, OfflineMutationPersistenceDisabledError } from './offline-mutation-admission.service';
import { OfflineReplicaPullService, OfflineReplicaSchemaMismatchError } from './offline-replica-pull.service';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  integer,
  localOnly,
  naturalKey,
  generatedId,
  text,
} from './offline-replica-schema';
import {
  canonicalOfflineReplicaIdentity,
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineCommandIdentity,
  type OfflinePullAttention,
  type OfflineReplicaAddress,
  type OfflineReplicaRow,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { generatedCommandIdentity, rematerializeTestAggregate } from './offline-test-helpers';
import { OFFLINE_AGGREGATE_INTENT_PROJECTOR } from './offline-aggregate-intent-projector';
import {
  OfflineCommandInFlightError,
  OfflinePayloadValidationError,
  OfflineSyncService,
  OFFLINE_RETRY_RANDOM,
  offlineRetryDelayMs,
  type PreparedOfflineCommand,
} from './offline-sync.service';

const replicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ id: number; title: string }>()({
      table: 'documents',
      sourceKey: 'documents',
      scope: 'partition',
      fields: {
        id: generatedId('integer'),
        title: text(),
      },
    }),
    defineReplicaEntity<{ title: string }>()({
      table: 'document_views',
      sourceKey: 'document_views',
      scope: 'partition',
      identity: localOnly(),
      fields: { title: text() },
    }),
  ],
  migrations: [],
});

const naturalReplicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ favFrom: number; favTo: string; title: string }>()({
      table: 'natural_documents',
      sourceKey: 'natural_documents',
      scope: 'partition',
      identity: naturalKey(['favFrom', 'favTo']),
      fields: { favFrom: integer(), favTo: text(), title: text() },
    }),
  ],
  migrations: [],
});

const textReplicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ id: string; title: string }>()({
      table: 'text_documents',
      sourceKey: 'text_documents',
      scope: 'partition',
      fields: { id: generatedId('text'), title: text() },
    }),
  ],
  migrations: [],
});

describe('offlineCommandWithBaseRevision', () => {
  it('baseRevisionだけを差し替えpayloadは同一参照かつ同一JSONのまま残す', () => {
    const payload = { title: 'unchanged', nested: { n: 1 } };
    const command: OfflineCommand = {
      userId: 1,
      scopeId: '10',
      commandId: 'cmd-1',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'local-1' },
      operation: 'documents.update',
      payload,
      baseRevision: 1,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };
    const updated = offlineCommandWithBaseRevision(command, 9);
    expect(updated.baseRevision).toBe(9);
    expect(updated.payload).toBe(payload);
    expect(JSON.stringify(updated.payload)).toBe(JSON.stringify(payload));
    const cleared = offlineCommandWithBaseRevision(updated, null);
    expect(cleared.baseRevision).toBeNull();
    expect(cleared.payload).toBe(payload);
    expect(JSON.stringify(cleared.payload)).toBe(JSON.stringify(payload));
  });
});

describe('OfflineSyncService', () => {
  let service: OfflineSyncService;
  let commands: OfflineCommand[];
  let rows: OfflineReplicaRow[];
  let pullAttentions: OfflinePullAttention[];
  let connected: ReturnType<typeof signal<boolean>>;
  let appActive: ReturnType<typeof signal<boolean>>;
  let lifecycleRevision: ReturnType<typeof signal<number>>;
  let networkConnected: () => boolean;
  let session: { userId: number; scopes: OfflineScope[] } | null;
  let localSession: { userId: number; scopes: OfflineScope[] } | null | undefined;
  let beforePutCommand: ((command: OfflineCommand) => Promise<void>) | null;
  let beforeGetCommands: (() => Promise<void>) | null;
  let beforeGetReplicaRow: (() => Promise<void>) | null;
  let beforeTransactReplica: (() => Promise<void>) | null;
  let repositoryInitialize: ReturnType<typeof vi.fn>;
  let putCommand: ReturnType<typeof vi.fn>;
  let pull: ReturnType<typeof vi.fn<(scope: OfflineScope) => Promise<void>>>;
  let handleError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  let onCommandRemoved: ReturnType<typeof vi.fn<(command: OfflineCommand) => Promise<void>>>;
  let options: OfflineKitOptions;
  const execute = vi.fn(
    async (_command: OfflineCommand, _target: OfflineCommandTarget): Promise<OfflineCommandResult> => ({
      response: null,
    }),
  );
  const provesCommandNotCommitted = vi.fn((_error: unknown, _command: OfflineCommand) => false);

  function expectAwaitingPull(count = commands.length): void {
    expect(commands).toHaveLength(count);
    expect(commands.every((command) => command.state === 'awaiting_pull')).toBe(true);
    expect(service.pendingCount()).toBe(count);
    expect(onCommandRemoved).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    commands = [];
    rows = [];
    pullAttentions = [];
    connected = signal(false);
    appActive = signal(true);
    lifecycleRevision = signal(0);
    networkConnected = connected;
    session = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    localSession = undefined;
    beforePutCommand = null;
    beforeGetCommands = null;
    beforeGetReplicaRow = null;
    beforeTransactReplica = null;
    pull = vi.fn(async () => undefined);
    handleError = vi.fn();
    onCommandRemoved = vi.fn(async () => undefined);
    options = { databaseName: 'test-offline', databaseEncryption: false, replicaSchema };
    execute.mockReset();
    execute.mockResolvedValue({ response: null });
    provesCommandNotCommitted.mockReset();
    provesCommandNotCommitted.mockReturnValue(false);
    repositoryInitialize = vi.fn(async () => undefined);
    putCommand = vi.fn(async (command: OfflineCommand) => {
      await beforePutCommand?.(command);
      commands = commands.filter((item) => item.commandId !== command.commandId);
      commands.push(structuredClone(command));
      commands.sort((left, right) => left.createdAt - right.createdAt);
    });
    const repository = {
      initialize: repositoryInitialize,
      getCommands: vi.fn(async (scope: OfflineScope) => {
        await beforeGetCommands?.();
        return commands.filter((item) => item.userId === scope.userId && item.scopeId === scope.scopeId);
      }),
      getCommandsForUser: vi.fn(async (userId: number) => {
        await beforeGetCommands?.();
        return commands.filter((item) => item.userId === userId);
      }),
      putCommand,
      replaceCommand: vi.fn(async (command: OfflineCommand) => {
        commands = commands.filter((item) => item.commandId !== command.commandId);
        commands.push(structuredClone(command));
        commands.sort((left, right) => left.createdAt - right.createdAt);
      }),
      removeCommand: vi.fn(async (commandId: string) => {
        commands = commands.filter((item) => item.commandId !== commandId);
      }),
      getReplicaRow: vi.fn(async (scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) => {
        await beforeGetReplicaRow?.();
        return (
          rows.find((item) => {
            if (item.userId !== scope.userId || item.scopeId !== scope.scopeId || item.sourceKey !== sourceKey) return false;
            if (identity.kind === 'generated') {
              return item.identity.kind === 'generated' && item.identity.localId === identity.localId;
            }
            if (identity.kind === 'local') {
              return item.identity.kind === 'local' && item.identity.localId === identity.localId;
            }
            return item.identity.kind === 'natural' && JSON.stringify(item.identity.naturalKey) === JSON.stringify(identity.naturalKey);
          }) ?? null
        );
      }),
      getReplicaRowIncludingPendingDelete: vi.fn(async (scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) => {
        await beforeGetReplicaRow?.();
        return (
          rows.find((item) => {
            if (item.userId !== scope.userId || item.scopeId !== scope.scopeId || item.sourceKey !== sourceKey) return false;
            if (identity.kind === 'generated') {
              return item.identity.kind === 'generated' && item.identity.localId === identity.localId;
            }
            if (identity.kind === 'local') {
              return item.identity.kind === 'local' && item.identity.localId === identity.localId;
            }
            return item.identity.kind === 'natural' && JSON.stringify(item.identity.naturalKey) === JSON.stringify(identity.naturalKey);
          }) ?? null
        );
      }),
      getReplicaRowByRemoteId: vi.fn(
        async (scope: OfflineScope, sourceKey: string, remoteId: number) =>
          rows.find(
            (item) =>
              item.userId === scope.userId &&
              item.scopeId === scope.scopeId &&
              item.sourceKey === sourceKey &&
              item.identity.kind === 'generated' &&
              item.identity.remoteId === remoteId,
          ) ?? null,
      ),
      getReplicaRowByRemoteIdentity: vi.fn(async (scope: OfflineScope, sourceKey: string, identity) => {
        if (identity.naturalKey !== undefined) {
          return (
            rows.find(
              (item) =>
                item.userId === scope.userId &&
                item.scopeId === scope.scopeId &&
                item.sourceKey === sourceKey &&
                Object.entries(identity.naturalKey).every(([key, value]) => (item.values as Record<string, unknown>)[key] === value),
            ) ?? null
          );
        }
        return (
          rows.find(
            (item) =>
              item.userId === scope.userId &&
              item.scopeId === scope.scopeId &&
              item.sourceKey === sourceKey &&
              item.identity.kind === 'generated' &&
              item.identity.remoteId === identity.remoteId,
          ) ?? null
        );
      }),
      getReplicaCursor: vi.fn(async () => null),
      getPullAttentions: vi.fn(async (userId: number) =>
        pullAttentions.filter((attention) => attention.userId === userId).map((attention) => structuredClone(attention)),
      ),
      putPullAttention: vi.fn(async (attention: OfflinePullAttention) => {
        pullAttentions = pullAttentions.filter(
          (candidate) => candidate.userId !== attention.userId || candidate.scopeId !== attention.scopeId,
        );
        pullAttentions.push(structuredClone(attention));
      }),
      removePullAttention: vi.fn(async (scope: OfflineScope) => {
        pullAttentions = pullAttentions.filter((candidate) => candidate.userId !== scope.userId || candidate.scopeId !== scope.scopeId);
      }),
      clearUser: vi.fn(async (userId: number) => {
        commands = commands.filter((item) => item.userId !== userId);
        rows = rows.filter((item) => item.userId !== userId);
        pullAttentions = pullAttentions.filter((attention) => attention.userId !== userId);
      }),
      clearScope: vi.fn(async (scope: OfflineScope) => {
        commands = commands.filter((item) => item.userId !== scope.userId || item.scopeId !== scope.scopeId);
        pullAttentions = pullAttentions.filter((candidate) => candidate.userId !== scope.userId || candidate.scopeId !== scope.scopeId);
      }),
      transactReplica: vi.fn(async (transaction) => {
        await beforeTransactReplica?.();
        for (const row of transaction.putRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== row.userId ||
              item.scopeId !== row.scopeId ||
              item.sourceKey !== row.sourceKey ||
              canonicalOfflineReplicaIdentity(item.identity) !== canonicalOfflineReplicaIdentity(row.identity),
          );
          rows.push(structuredClone(row));
        }
        for (const key of transaction.removeRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== key.userId ||
              item.scopeId !== key.scopeId ||
              item.sourceKey !== key.sourceKey ||
              canonicalOfflineReplicaIdentity(item.identity) !== canonicalOfflineReplicaIdentity(key.identity),
          );
        }
        for (const command of transaction.putCommands ?? []) {
          commands = commands.filter((item) => item.commandId !== command.commandId);
          commands.push(structuredClone(command));
        }
        commands = commands.filter((command) => !(transaction.removeCommandIds ?? []).includes(command.commandId));
        for (const attention of transaction.putPullAttentions ?? []) {
          pullAttentions = pullAttentions.filter(
            (candidate) => candidate.userId !== attention.userId || candidate.scopeId !== attention.scopeId,
          );
          pullAttentions.push(structuredClone(attention));
        }
        for (const scope of transaction.removePullAttentions ?? []) {
          pullAttentions = pullAttentions.filter((candidate) => candidate.userId !== scope.userId || candidate.scopeId !== scope.scopeId);
        }
        commands.sort((left, right) => left.createdAt - right.createdAt);
      }),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [
        OfflineSyncService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        {
          provide: OfflineNetworkService,
          useValue: { connected: () => networkConnected(), appActive, lifecycleRevision },
        },
        { provide: OFFLINE_KIT_OPTIONS, useValue: options },
        { provide: OfflineReplicaPullService, useValue: { pull } },
        { provide: ErrorHandler, useValue: { handleError } },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (command: OfflineCommand) => command.aggregateType, onCommandRemoved },
        },
        {
          provide: OFFLINE_SYNC_CONTEXT,
          useValue: {
            getLocalSession: vi.fn(async () => (localSession === undefined ? session : localSession)),
            getSession: vi.fn(async () => session),
          },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute,
            provesCommandNotCommitted,
          },
        },
        { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project: rematerializeTestAggregate } },
        // Fixed sample so backoff stays deterministic (except dedicated jitter unit tests).
        { provide: OFFLINE_RETRY_RANDOM, useValue: () => 0.5 },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
  });

  afterEach(() => {
    connected.set(false);
    service.revokeSession();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('readCacheOnly mode rejects enqueue before creating replica or Outbox state', async () => {
    options.mode = 'readCacheOnly';

    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'forbidden-write' },
          operation: 'documents.create',
          payload: { title: 'write' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('read-only cache');
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('rejects every new command entry point after mutation admission closes', async () => {
    await TestBed.inject(OfflineMutationAdmissionService).close();
    const request = {
      scopeId: '10',
      aggregateType: 'documents',
      identity: { kind: 'generated' as const, localId: 'closed-write' },
      operation: 'documents.create',
      payload: { title: 'write' },
    };
    const prepare = vi.fn(async () => ({ request }));
    const prepareBatch = vi.fn(async () => [{ request }]);

    await expect(service.enqueue(request, { flush: false })).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
    await expect(service.enqueuePrepared(prepare, { flush: false })).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
    await expect(service.enqueuePreparedBatch(prepareBatch, { flush: false })).rejects.toBeInstanceOf(
      OfflineMutationPersistenceDisabledError,
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(prepareBatch).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it('prepared enqueue rematerializes the base row and declared localOnly footprint', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'view-1' },
      values: { title: 'Baseline view' },
      confirmedValues: { title: 'Baseline view' },
      serverRevision: null,
      fetchedAt: 2,
      syncState: 'confirmed',
    };
    rows.push(structuredClone(companion));

    await service.enqueuePrepared(
      async (repository) => {
        const current = await repository.getReplicaRow({ userId: 1, scopeId: '10' }, 'document_views', companion.identity);
        expect(current?.values).toEqual({ title: 'Baseline view' });
        return {
          request: {
            scopeId: '10',
            aggregateType: 'documents',
            identity: { kind: 'generated', localId: 'prepared-1' },
            operation: 'documents.create',
            payload: { title: 'Optimistic' },
            localOnlyFootprint: [companion],
          },
        };
      },
      { flush: false },
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: 'documents', values: { id: 0, title: 'Optimistic' } }),
        expect.objectContaining({
          sourceKey: 'document_views',
          values: { title: 'Optimistic' },
          confirmedValues: { title: 'Baseline view' },
        }),
      ]),
    );
    expect(commands[0]?.localOnlyFootprint).toEqual([
      expect.objectContaining({ sourceKey: 'document_views', identity: { kind: 'local', localId: 'view-1' } }),
    ]);
  });

  it('prepared enqueue persists nothing when preparation fails', async () => {
    await expect(
      service.enqueuePrepared(async () => {
        throw new Error('derive failed');
      }),
    ).rejects.toThrow('derive failed');
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('prepared enqueue rejects duplicate or cross-scope localOnly footprint keys before persistence', async () => {
    const base = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local' as const, localId: 'duplicate' },
    };
    const request = {
      scopeId: '10',
      aggregateType: 'documents',
      identity: { kind: 'generated' as const, localId: 'prepared-invalid' },
      operation: 'documents.create',
      payload: { title: 'x' },
    };
    await expect(
      service.enqueuePrepared(async () => ({
        request: { ...request, localOnlyFootprint: [base, structuredClone(base)] },
      })),
    ).rejects.toThrow('duplicate replica row');
    await expect(
      service.enqueuePrepared(async () => ({
        request: { ...request, localOnlyFootprint: [{ ...base, scopeId: '11' }] },
      })),
    ).rejects.toThrow('must use the command scope');
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('discard rematerializes remaining intents onto confirmed localOnly values', async () => {
    const before: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'discard-view' },
      values: { title: 'Baseline' },
      confirmedValues: { title: 'Baseline' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    rows.push(before);
    const commandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'discard-prepared' },
          operation: 'documents.create',
          payload: { title: 'Optimistic' },
          localOnlyFootprint: [before],
        },
      }),
      { flush: false },
    );

    await service.discard(commandId, { flush: false });

    expect(rows.find((row) => row.sourceKey === 'document_views')?.values).toEqual({ title: 'Baseline' });
    expect(commands).toEqual([]);
  });

  it('pull適用中の複数command一括discardは最新confirmed companionを待って復元する', async () => {
    const before: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'discard-race-view' },
      values: { title: 'Baseline' },
      confirmedValues: { title: 'Baseline' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    rows.push(before);
    for (const [index, title] of ['First optimistic', 'Second optimistic'].entries()) {
      await service.enqueuePrepared(
        async () => ({
          request: {
            scopeId: '10',
            aggregateType: 'documents',
            identity: { kind: 'generated', localId: 'discard-race' },
            operation: 'documents.update',
            payload: { title },
            localOnlyFootprint: [before],
          },
        }),
        { flush: false },
      );
    }

    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pullApply = coordinator.run(async () => {
      started();
      await barrier;
      rows = rows.map((row) =>
        row.sourceKey === 'document_views' ? { ...row, confirmedValues: { title: 'Server after pull' }, fetchedAt: 10 } : row,
      );
    });
    await applying;

    const discard = service.discardAllPending();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(commands).toHaveLength(2);

    release();
    await Promise.all([pullApply, discard]);
    expect(commands).toEqual([]);
    expect(rows.find((row) => row.sourceKey === 'document_views')?.values).toEqual({ title: 'Server after pull' });
  });

  it('Outbox件数上限では既存commandを失わず新規enqueueを拒否する', async () => {
    options.outboxLimits = { maxCommandsPerUser: 1 };
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'first' },
        operation: 'documents.create',
        payload: { title: 'first' },
      },
      { flush: false },
    );

    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'second' },
          operation: 'documents.create',
          payload: { title: 'second' },
        },
        { flush: false },
      ),
    ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'command_count' });
    expect(commands).toHaveLength(1);
    expect(rows.map((row) => (row.identity.kind === 'generated' ? row.identity.localId : ''))).toEqual(['first']);
  });

  it('Outbox容量上限では既存commandとreplicaを失わず新規enqueueを拒否する', async () => {
    options.outboxLimits = { maxBytesPerUser: 1 };

    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'oversized' },
          operation: 'documents.create',
          payload: { title: 'too large' },
        },
        { flush: false },
      ),
    ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'serialized_bytes' });
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  describe('enqueuePreparedBatch', () => {
    const prepared = (localId: string, title: string, companion?: OfflineReplicaRow): PreparedOfflineCommand => ({
      request: {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId },
        operation: 'documents.create',
        payload: { title },
        localOnlyFootprint: companion ? [companion] : undefined,
      },
    });

    it('2件の成功は1回のtransactReplicaでFIFO createdAtを永続化する', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);
      const commandIds = await service.enqueuePreparedBatch(async () => [prepared('batch-a', 'A'), prepared('batch-b', 'B')], {
        flush: false,
      });

      expect(commandIds).toHaveLength(2);
      expect(transactReplica).toHaveBeenCalledTimes(1);
      expect(commands).toHaveLength(2);
      expect(commands.map((command) => (command.identity.kind === 'generated' ? command.identity.localId : ''))).toEqual([
        'batch-a',
        'batch-b',
      ]);
      expect(commands[0]!.createdAt).toBeLessThan(commands[1]!.createdAt);
      expect(commands.map((command) => command.commandId)).toEqual([...commandIds]);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity: expect.objectContaining({ localId: 'batch-a' }),
            values: { id: 0, title: 'A' },
          }),
          expect.objectContaining({
            identity: expect.objectContaining({ localId: 'batch-b' }),
            values: { id: 0, title: 'B' },
          }),
        ]),
      );
    });

    it('product lease失効時は全prepare後もcommit直前にbatch全体を拒否する', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);
      const assertCurrent = vi.fn(() => {
        throw new Error('product principal changed');
      });

      await expect(
        service.enqueuePreparedBatch(async () => [prepared('lease-a', 'A'), prepared('lease-b', 'B')], {
          flush: false,
          assertCurrent,
        }),
      ).rejects.toThrow('product principal changed');

      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });

    it('同一principalの複数scopeを1回のtransactionで受け付ける', async () => {
      localSession = {
        userId: 1,
        scopes: [
          { userId: 1, scopeId: '10' },
          { userId: 1, scopeId: '20' },
        ],
      };
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);

      await service.enqueuePreparedBatch(
        async () => [
          prepared('scope-10', 'A'),
          { ...prepared('scope-20', 'B'), request: { ...prepared('scope-20', 'B').request, scopeId: '20' } },
        ],
        { flush: false },
      );

      expect(transactReplica).toHaveBeenCalledTimes(1);
      expect(commands.map(({ scopeId }) => scopeId)).toEqual(['10', '20']);
    });

    it('k番目のprepare/validation失敗では一切書き込まない', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);

      await expect(
        service.enqueuePreparedBatch(async () => {
          throw new Error('prepare failed at second derive');
        }),
      ).rejects.toThrow('prepare failed at second derive');
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);

      await expect(
        service.enqueuePreparedBatch(async () => [
          prepared('batch-ok', 'ok'),
          {
            request: {
              scopeId: '10',
              aggregateType: 'documents',
              identity: { kind: 'natural', naturalKey: { favFrom: 1, favTo: 'x' } },
              operation: 'documents.create',
              payload: { title: 'bad' },
            },
          },
        ]),
      ).rejects.toThrow('requires generated identity');
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });

    it('aggregateまたはreplica footprintの重複を拒否して書き込まない', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);
      const companion = (localId: string): OfflineReplicaRow => ({
        userId: 1,
        scopeId: '10',
        sourceKey: 'document_views',
        identity: { kind: 'local', localId },
        values: { title: localId },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed',
      });

      await expect(
        service.enqueuePreparedBatch(async () => [prepared('same-aggregate', 'one'), prepared('same-aggregate', 'two')], {
          flush: false,
        }),
      ).rejects.toThrow('overlapping aggregate intents');
      expect(transactReplica).not.toHaveBeenCalled();

      await expect(
        service.enqueuePreparedBatch(
          async () => [prepared('doc-a', 'A', companion('shared-view')), prepared('doc-b', 'B', companion('shared-view'))],
          { flush: false },
        ),
      ).rejects.toThrow('overlapping replica footprints');
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });

    it('空batchを拒否し、件数とシリアライズbyteを合算してcapacity判定する', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);

      await expect(service.enqueuePreparedBatch(async () => [], { flush: false })).rejects.toThrow(
        'Prepared offline batch must contain at least one command.',
      );
      expect(transactReplica).not.toHaveBeenCalled();

      options.outboxLimits = { maxCommandsPerUser: 1 };
      await expect(
        service.enqueuePreparedBatch(async () => [prepared('cap-a', 'A'), prepared('cap-b', 'B')], { flush: false }),
      ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'command_count' });
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);

      options.outboxLimits = { maxBytesPerUser: 1 };
      await expect(
        service.enqueuePreparedBatch(async () => [prepared('byte-a', 'A'), prepared('byte-b', 'B')], { flush: false }),
      ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'serialized_bytes' });
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });

    it('generation/session失効では永続化前に失敗し状態を残さない', async () => {
      let releasePrepare: (() => void) | undefined;
      let prepareStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        prepareStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);

      const enqueue = service.enqueuePreparedBatch(async () => {
        prepareStarted?.();
        await gate;
        return [prepared('revoked-batch', 'stale')];
      });
      await started;

      service.revokeSession();
      releasePrepare?.();

      await expect(enqueue).rejects.toThrow('Offline session changed');
      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });

    it('durable commit後のstate refreshが失敗してもIDを返し後続refreshで収束する', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const getCommandsForUser = vi.mocked(repository.getCommandsForUser!);
      await service.initialize({ flush: false });
      let failRefresh = true;
      getCommandsForUser.mockImplementation(async (userId) => {
        if (failRefresh && commands.length > 0) {
          failRefresh = false;
          throw new Error('postcommit read failed');
        }
        return commands.filter((item) => item.userId === userId);
      });

      const commandIds = await service.enqueuePreparedBatch(async () => [prepared('committed-a', 'A'), prepared('committed-b', 'B')], {
        flush: false,
      });

      expect(commandIds).toHaveLength(2);
      expect(commands.map(({ commandId }) => commandId)).toEqual([...commandIds]);
      expect(rows).toHaveLength(2);
      expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'postcommit read failed' }));
      expect(service.pendingCount()).toBe(0);

      await service.reloadPendingCommands();
      expect(service.pendingCount()).toBe(2);
    });
  });

  it('local sessionはoutboxへenqueueできるがremote session確立までは送信しない', async () => {
    localSession = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    session = null;
    await service.refreshLocalSession();

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'offline-local' },
        operation: 'documents.create',
        payload: { title: 'offline' },
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();

    expect(execute).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    expect(service.pendingCount()).toBe(1);
  });

  it('session principalと型まで一致しないscopeをactivation前に拒否する', async () => {
    localSession = { userId: 7, scopes: [{ userId: '7', scopeId: '10' }] };

    await expect(service.refreshLocalSession()).rejects.toThrow('Offline sync session scope belongs to a different principal.');
    expect(service.pendingCount()).toBe(0);
  });

  it('offline初期化後の再接続でpending outboxを自動送信する', async () => {
    await service.initialize();
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'reconnect-local' },
        operation: 'documents.create',
        payload: { title: 'queued offline' },
      },
      { flush: false },
    );
    expect(execute).not.toHaveBeenCalled();

    connected.set(true);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(commands[0]?.state).toBe('awaiting_pull'));
    expect(service.pendingCount()).toBe(1);
  });

  it('session失効前に開始したenqueueを永続commitせずreset完了まで直列化する', async () => {
    let releaseRead: (() => void) | undefined;
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    beforeGetReplicaRow = async () => {
      readStarted?.();
      await gate;
    };

    const enqueue = service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'revoked' },
        operation: 'documents.create',
        payload: { title: 'stale' },
      },
      { flush: false },
    );
    await started;

    service.revokeSession();
    const reset = service.resetSession();
    releaseRead?.();

    await expect(enqueue).rejects.toThrow('Offline session changed');
    await reset;
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('旧flushが失敗してもresetを中断せずdurable cleanupへ進める', async () => {
    const pullError = new Error('pull failed during revocation');
    let rejectPull: ((error: unknown) => void) | undefined;
    pull.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPull = reject;
        }),
    );
    connected.set(true);
    const flush = service.flush();
    const flushRejected = expect(flush).rejects.toBe(pullError);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());

    const reset = service.resetSession();
    rejectPull?.(pullError);

    await flushRejected;
    await expect(reset).resolves.toBeUndefined();
    expect(service.pendingCount()).toBe(0);
  });

  it('同じaggregateの操作を作成順に送り、成功後だけoutboxから除く', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 2 },
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(execute.mock.calls.map(([command]) => (command as OfflineCommand<{ seq: number }>).payload.seq)).toEqual([1, 2]);
    expect(pull).toHaveBeenCalledTimes(2);
    expectAwaitingPull(2);
  });

  it('送信成功後は同一scopeの複数aggregateを一度だけ再pullする', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'post-pull-1' },
        operation: 'documents.create',
        payload: { title: 'one' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'post-pull-2' },
        operation: 'documents.create',
        payload: { title: 'two' },
      },
      { flush: false },
    );

    connected.set(true);
    await service.flush();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(pull.mock.calls.map(([scope]) => scope)).toEqual([
      { userId: 1, scopeId: '10' },
      { userId: 1, scopeId: '10' },
    ]);
    expectAwaitingPull(2);
  });

  it('送信ACK後のpullが完了するまでflushを完了せずauthoritative projectionを公開する', async () => {
    const commandCountsAtPull: number[] = [];
    execute.mockResolvedValueOnce({
      remoteId: 55,
      serverRevision: 2,
      confirmedValues: { id: 55, title: 'base response' },
      response: null,
    });
    pull.mockImplementation(async () => {
      commandCountsAtPull.push(commands.length);
      if (commandCountsAtPull.length !== 2) return;
      const row = rows.find(
        (candidate) =>
          candidate.sourceKey === 'documents' && candidate.identity.kind === 'generated' && candidate.identity.localId === 'snap-back',
      );
      if (!row) throw new Error('post-send pull requires the acknowledged replica row');
      // Product pullers materialize sibling-table state here. Model that server-authoritative
      // projection explicitly so this test catches a regression that resolves flush after ACK
      // but before the post-send pull has replaced the transient base-only projection.
      row.values = { id: 55, title: 'authoritative projection' };
      row.confirmedValues = row.values;
      row.serverRevision = 3;
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'snap-back' },
        operation: 'documents.create',
        payload: { title: 'optimistic projection' },
      },
      { flush: false },
    );

    connected.set(true);
    await service.flush();

    expect(commandCountsAtPull).toEqual([1, 1]);
    expect(rows).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ localId: 'snap-back', remoteId: 55 }),
        values: { id: 55, title: 'authoritative projection' },
        confirmedValues: { id: 55, title: 'authoritative projection' },
        serverRevision: 3,
      }),
    );
    expectAwaitingPull(1);
  });

  it('送信後pull失敗ではcommit済みcommandを再送せず次flushのpre-pullで回収する', async () => {
    const postPullError = new Error('post-send pull failed');
    pull.mockResolvedValueOnce(undefined).mockRejectedValueOnce(postPullError).mockResolvedValue(undefined);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'post-pull-failure' },
        operation: 'documents.create',
        payload: { title: 'one' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(postPullError);
    expectAwaitingPull(1);
    expect(execute).toHaveBeenCalledOnce();

    await service.flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledTimes(3);
    expectAwaitingPull(1);
  });

  it.each([0, 408])('background遷移をまたいだpost-send pullのstatus %sも報告せず復帰後に回収する', async (status) => {
    let rejectPostPull!: (error: unknown) => void;
    pull
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (rejectPostPull = reject)))
      .mockResolvedValue(undefined);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: `interrupted-post-pull-${status}` },
        operation: 'documents.create',
        payload: { title: 'one' },
      },
      { flush: false },
    );

    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(false);
    rejectPostPull({ status });
    await expect(flush).resolves.toBeUndefined();
    expectAwaitingPull(1);
    expect(handleError).not.toHaveBeenCalled();

    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(true);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(3));
    expect(execute).toHaveBeenCalledOnce();
    expect(handleError).not.toHaveBeenCalled();
  });

  it('partial flushのACK後pull失敗scopeをOutbox削除後もreconnectで再pullする', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    let scope20Pulls = 0;
    const postPullError = new Error('scope 20 post-send pull failed');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '20' && ++scope20Pulls === 2) throw postPullError;
    });
    await service.refreshSession(['10']);
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'partial-post-pull-failure' },
        operation: 'documents.create',
        payload: { title: 'one' },
      },
      { flush: false },
    );

    connected.set(true);
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(postPullError));
    expectAwaitingPull(1);
    expect(execute).toHaveBeenCalledOnce();

    connected.set(false);
    connected.set(true);
    await vi.waitFor(() => expect(scope20Pulls).toBe(3));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('ACK後pull失敗scopeをreset後もdurable awaiting_pullから復元しcommandを再送しない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    let scope20Pulls = 0;
    const postPullError = new Error('scope 20 post-send pull failed before restart');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '20' && ++scope20Pulls === 2) throw postPullError;
    });
    await service.refreshSession(['10']);
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'durable-post-pull-failure' },
        operation: 'documents.create',
        payload: { title: 'one' },
      },
      { flush: false },
    );

    connected.set(true);
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(postPullError));
    expectAwaitingPull(1);

    connected.set(false);
    await service.resetSession();
    await service.refreshSession(['10']);
    connected.set(true);
    await vi.waitFor(() => expect(scope20Pulls).toBe(3));

    expect(execute).toHaveBeenCalledOnce();
    expect(commands).toEqual([expect.objectContaining({ scopeId: '20', state: 'awaiting_pull' })]);
  });

  it('pre-pull: 無関係なscope A失敗でも成功したscope Bのeligible aggregateは送信する', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const scopeAError = new Error('scope A pre-pull failed');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw scopeAError;
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-a' },
        operation: 'documents.create',
        payload: { title: 'a' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(scopeAError);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([command]) => (command as OfflineCommand).identity)).toEqual([
      expect.objectContaining({ localId: 'scope-b' }),
    ]);
    expect(commands.map((command) => command.identity)).toEqual([
      expect.objectContaining({ localId: 'scope-a' }),
      expect.objectContaining({ localId: 'scope-b' }),
    ]);
    expect(commands.find((command) => command.identity.kind === 'generated' && command.identity.localId === 'scope-b')?.state).toBe(
      'awaiting_pull',
    );
  });

  it('pre-pull: 同一scopeのpull失敗ではそのscopeのcommandを送らない', async () => {
    const scopeError = new Error('same scope pre-pull failed');
    pull.mockRejectedValue(scopeError);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'blocked-by-pull' },
        operation: 'documents.create',
        payload: { title: 'blocked' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(scopeError);
    expect(execute).not.toHaveBeenCalled();
    expect(commands).toEqual([expect.objectContaining({ identity: expect.objectContaining({ localId: 'blocked-by-pull' }) })]);
  });

  it('pre-pull失敗があってもsend workerが全てsettledしてからflushがrejectする', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const scopeAError = new Error('scope A pre-pull failed after workers');
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw scopeAError;
    });
    execute.mockImplementation(async () => {
      sendStarted?.();
      await sendGate;
      return { response: null };
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-a-wait' },
        operation: 'documents.create',
        payload: { title: 'a' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b-wait' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    const flush = service.flush();
    const flushRejected = expect(flush).rejects.toBe(scopeAError);
    await started;
    expect(execute).toHaveBeenCalledOnce();
    releaseSend?.();
    await flushRejected;
    expect(execute).toHaveBeenCalledOnce();
    expect(commands.map((command) => command.identity)).toEqual([
      expect.objectContaining({ localId: 'scope-a-wait' }),
      expect.objectContaining({ localId: 'scope-b-wait' }),
    ]);
    expect(commands.find((command) => command.identity.kind === 'generated' && command.identity.localId === 'scope-b-wait')?.state).toBe(
      'awaiting_pull',
    );
  });

  it('status無しworker失敗でも他workerのACK完了までflushをrejectしない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const statuslessFailure = new Error('status-less transport failure');
    let releaseSuccess!: () => void;
    const successGate = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    let successStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      successStarted = resolve;
    });
    execute.mockImplementation(async (command) => {
      if (command.identity.kind === 'generated' && command.identity.localId === 'fail-early') {
        throw statuslessFailure;
      }
      successStarted();
      await successGate;
      return { response: null, serverRevision: 2 };
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'fail-early' },
        operation: 'documents.create',
        payload: { title: 'fail' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'succeed-deferred' },
        operation: 'documents.create',
        payload: { title: 'ok' },
      },
      { flush: false },
    );

    connected.set(true);
    const flush = service.flush();
    const flushRejected = expect(flush).rejects.toBe(statuslessFailure);
    await started;
    expect(commands.some((command) => command.identity.kind === 'generated' && command.identity.localId === 'succeed-deferred')).toBe(true);
    releaseSuccess();
    await flushRejected;
    expect(commands.map((command) => command.identity)).toEqual([
      expect.objectContaining({ localId: 'fail-early' }),
      expect.objectContaining({ localId: 'succeed-deferred' }),
    ]);
    expect(commands[0]).toMatchObject({ state: 'retry_wait', serverCommitUnknown: true });
    expect(commands[1]).toMatchObject({ state: 'awaiting_pull' });
    expect(service.syncState()).toBe('attention');
    expect(pull.mock.calls.some((call) => call[0]?.scopeId === '20')).toBe(true);
  });

  it('typed schema mismatchのpre-pull fatalでは残りscopeを止め成功scopeも送らない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const schemaError = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw schemaError;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b-fatal' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(schemaError);
    expect(execute).not.toHaveBeenCalled();
    expect(pull.mock.calls.map((call) => call[0]?.scopeId)).toEqual(['10']);
    expect(service.syncState()).toBe('attention');
    expect(service.pullAttentions()).toEqual([
      { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
      { userId: 1, scopeId: '20', reason: 'schema_upgrade_required' },
    ]);

    connected.set(false);
    await service.resetSession();
    await service.refreshLocalSession();
    expect(service.syncState()).toBe('attention');
    expect(execute).not.toHaveBeenCalled();

    pull.mockResolvedValue(undefined);
    connected.set(true);
    await expect(service.flush()).resolves.toBeUndefined();
    expect(service.pullAttentions()).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('empty Outboxのschema fatalはattentionとして可視でrestart後もdurable、pendingは未送信のまま', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const schemaError = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw schemaError;
    });

    connected.set(true);
    await expect(service.flush()).rejects.toBe(schemaError);
    expect(commands).toEqual([]);
    expect(service.syncState()).toBe('attention');
    expect(service.pullAttentions()).toEqual([
      { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
      { userId: 1, scopeId: '20', reason: 'schema_upgrade_required' },
    ]);
    expect(pullAttentions).toEqual(service.pullAttentions());

    TestBed.resetTestingModule();
    // Rebuild with the same durable pullAttentions / empty Outbox to simulate restart.
    connected = signal(false);
    pull = vi.fn(async () => undefined);
    handleError = vi.fn();
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async () => []),
      getCommandsForUser: vi.fn(async () => []),
      putCommand: vi.fn(),
      replaceCommand: vi.fn(),
      removeCommand: vi.fn(),
      getReplicaRow: vi.fn(async () => null),
      getReplicaRowIncludingPendingDelete: vi.fn(async () => null),
      getReplicaRowByRemoteId: vi.fn(async () => null),
      getReplicaRowByRemoteIdentity: vi.fn(async () => null),
      getReplicaCursor: vi.fn(async () => null),
      getPullAttentions: vi.fn(async (userId: number) =>
        pullAttentions.filter((attention) => attention.userId === userId).map((attention) => structuredClone(attention)),
      ),
      transactReplica: vi.fn(async () => undefined),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [
        OfflineSyncService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: { connected } },
        { provide: OFFLINE_KIT_OPTIONS, useValue: options },
        { provide: OfflineReplicaPullService, useValue: { pull } },
        { provide: ErrorHandler, useValue: { handleError } },
        { provide: OFFLINE_COMMAND_HOOKS, useValue: { entityType: (command: OfflineCommand) => command.aggregateType } },
        {
          provide: OFFLINE_SYNC_CONTEXT,
          useValue: {
            getLocalSession: vi.fn(async () => session),
            getSession: vi.fn(async () => session),
          },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute,
            provesCommandNotCommitted,
          },
        },
        { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project: rematerializeTestAggregate } },
        { provide: OFFLINE_RETRY_RANDOM, useValue: () => 0.5 },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
    await service.refreshSession();
    expect(service.syncState()).toBe('attention');
    expect(service.pullAttentions()).toEqual([
      { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
      { userId: 1, scopeId: '20', reason: 'schema_upgrade_required' },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('schema fatal後の互換pullはattentionを消してpendingを送信する', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const schemaError = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw schemaError;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'pending-after-schema' },
        operation: 'documents.create',
        payload: { title: 'pending' },
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toBe(schemaError);
    expect(execute).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.state).toBe('pending');
    expect(service.syncState()).toBe('attention');

    pull.mockImplementation(async () => undefined);
    await service.flush();
    expect(execute).toHaveBeenCalledOnce();
    expectAwaitingPull(1);
    expect(service.pullAttentions()).toEqual([]);
    expect(pullAttentions).toEqual([]);
    expect(service.syncState()).toBe('pending');
  });

  it('pre-pull HTTP 403はfailing scopeだけにauthorization attentionを付ける', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const forbidden = { status: 403, message: 'Forbidden' };
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw forbidden;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b-403' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toBe(forbidden);
    expect(service.pullAttentions()).toEqual([{ userId: 1, scopeId: '10', reason: 'authorization_required', status: 403 }]);
    expect(execute).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.state).toBe('pending');
  });

  it('pre-pull HTTP 401はprincipal全scopeにauthorization attentionを付ける', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const unauthorized = { status: 401, message: 'Unauthorized' };
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw unauthorized;
    });
    connected.set(true);
    await expect(service.flush()).rejects.toBe(unauthorized);
    expect(service.pullAttentions()).toEqual([
      { userId: 1, scopeId: '10', reason: 'authorization_required', status: 401 },
      { userId: 1, scopeId: '20', reason: 'authorization_required', status: 401 },
    ]);
  });

  it('clearUserはdurable pull attentionを削除する', async () => {
    pullAttentions = [
      { userId: 1, scopeId: '10', reason: 'schema_upgrade_required' },
      { userId: 2, scopeId: '10', reason: 'authorization_required', status: 401 },
    ];
    const repository = TestBed.inject(OFFLINE_REPOSITORY);
    await repository.clearUser!(1);
    expect(pullAttentions).toEqual([{ userId: 2, scopeId: '10', reason: 'authorization_required', status: 401 }]);
  });

  it('遅延した旧世代のfatal pull attentionは新世代のattentionを上書きしない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    let releaseFatal!: (error: unknown) => void;
    let pullStarted!: () => void;
    const pullEntered = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    const blockedPull = new Promise<never>((_resolve, reject) => {
      releaseFatal = reject;
    });
    // Avoid unhandled rejection if the gate is abandoned mid-test.
    void blockedPull.catch(() => undefined);
    pull.mockImplementation(async (scope) => {
      if (scope.userId === 1 && scope.scopeId === '10') {
        pullStarted();
        await blockedPull;
      }
    });
    connected.set(true);
    const flushA = service.flush();
    const flushAResult = flushA.then(
      () => null,
      (error: unknown) => error,
    );
    await pullEntered;

    // Stay offline before revoke so the network effect cannot arm a background flush.
    connected.set(false);
    // Transition generation only after the old flush is blocked inside pull.
    service.revokeSession();
    pullAttentions = [{ userId: 2, scopeId: '30', reason: 'authorization_required', status: 403 }];
    session = {
      userId: 2,
      scopes: [
        { userId: 2, scopeId: '10' },
        { userId: 2, scopeId: '30' },
      ],
    };
    pull.mockImplementation(async () => undefined);
    await service.refreshSession();
    expect(service.pullAttentions()).toEqual([{ userId: 2, scopeId: '30', reason: 'authorization_required', status: 403 }]);

    const staleFatal = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    releaseFatal(staleFatal);
    expect(await flushAResult).toBe(staleFatal);
    expect(pullAttentions).toEqual([{ userId: 2, scopeId: '30', reason: 'authorization_required', status: 403 }]);
    expect(service.pullAttentions()).toEqual([{ userId: 2, scopeId: '30', reason: 'authorization_required', status: 403 }]);
  });

  it('pre-pull HTTP 409はschema mismatch fatalとして残りscopeを止め成功scopeも送らない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const schemaConflict = { status: 409, message: 'Conflict' };
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw schemaConflict;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b-http-409' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(schemaConflict);
    expect(execute).not.toHaveBeenCalled();
    expect(pull.mock.calls.map((call) => call[0]?.scopeId)).toEqual(['10']);
  });

  it.each([
    ['OfflineReplicaSchemaMismatchError', () => new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def')],
    ['HTTP 401', () => ({ status: 401, message: 'Unauthorized' })],
    ['HTTP 403', () => ({ status: 403, message: 'Forbidden' })],
    ['HTTP 409', () => ({ status: 409, message: 'Conflict' })],
  ] as const)('pre-pull fatal (%s) は1s自動retryせずpending post-pullもスキップする', async (_label, createError) => {
    vi.useFakeTimers();
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    let scope20Pulls = 0;
    const postPullError = new Error('scope 20 post-send pull failed before fatal');
    const fatalError = createError();
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '20') {
        scope20Pulls += 1;
        // First full flush: pre-pull ok, post-send pull fails and leaves pending marker.
        if (scope20Pulls === 2) throw postPullError;
      }
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: `fatal-skip-post-${_label.replace(/\s+/g, '-')}` },
        operation: 'documents.create',
        payload: { title: 'seed' },
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toBe(postPullError);
    expect(execute).toHaveBeenCalledOnce();
    expectAwaitingPull(1);
    // Drop the transient post-pull retry so this case only asserts fatal does not arm a new one.
    vi.clearAllTimers();

    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw fatalError;
    });
    const pullsBeforeFatal = pull.mock.calls.length;
    await expect(service.flush()).rejects.toBe(fatalError);
    expect(execute).toHaveBeenCalledOnce();
    expect(pull.mock.calls.slice(pullsBeforeFatal).map((call) => call[0]?.scopeId)).toEqual(['10']);

    const pullsAfterFatal = pull.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pull.mock.calls.length).toBe(pullsAfterFatal);
    expect(handleError).not.toHaveBeenCalled();
  });

  it.each([
    ['OfflineReplicaSchemaMismatchError', () => new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def')],
    ['HTTP 401', () => ({ status: 401, message: 'Unauthorized' })],
    ['HTTP 403', () => ({ status: 403, message: 'Forbidden' })],
    ['HTTP 409', () => ({ status: 409, message: 'Conflict' })],
  ] as const)('post-send pull fatal (%s) は残りpending post-pullを止めACK保持・1s自動retryなし', async (_label, createError) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const fatalError = createError();
    const pullsByScope = new Map<string, number>();
    pull.mockImplementation(async (scope) => {
      const count = (pullsByScope.get(scope.scopeId) ?? 0) + 1;
      pullsByScope.set(scope.scopeId, count);
      // Second pull for a scope is the post-send pull after ACK.
      if (count >= 2) throw fatalError;
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: `post-fatal-a-${_label.replace(/\s+/g, '-')}` },
        operation: 'documents.create',
        payload: { title: 'a' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: `post-fatal-b-${_label.replace(/\s+/g, '-')}` },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    setTimeoutSpy.mockClear();
    connected.set(true);
    await expect(service.flush()).rejects.toBe(fatalError);

    // Both commands transported; retained until pull acknowledges commandId.
    expect(execute).toHaveBeenCalledTimes(2);
    expectAwaitingPull(2);
    // Two pending post-pull scopes: first fatal stops the second immediately.
    expect(pullsByScope.get('10')).toBeGreaterThanOrEqual(1);
    expect(pullsByScope.get('20')).toBeGreaterThanOrEqual(1);
    const postPullScopes = [...pullsByScope.entries()].filter(([, count]) => count >= 2).map(([scopeId]) => scopeId);
    expect(postPullScopes).toHaveLength(1);
    expect([...pullsByScope.values()].reduce((sum, count) => sum + count, 0)).toBe(3);
    expect(new Set(commands.map((command) => command.scopeId))).toEqual(new Set(['10', '20']));
    // Fatal must not arm the 1s automatic post-pull flush retry.
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1_000)).toBe(false);

    const pullsAfterFatal = pull.mock.calls.length;
    // Drop unrelated scheduler/effect timers, then prove no 1s retry remained.
    vi.clearAllTimers();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pull.mock.calls.length).toBe(pullsAfterFatal);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('post-send pull transientの後のfatalはfatalを優先して投げ残りpendingを止める', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
        { userId: 1, scopeId: '30' },
      ],
    };
    const transient = new Error('post-send transient');
    const fatal = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    const pullsByScope = new Map<string, number>();
    let postPullAttempts = 0;
    pull.mockImplementation(async (scope) => {
      const count = (pullsByScope.get(scope.scopeId) ?? 0) + 1;
      pullsByScope.set(scope.scopeId, count);
      if (count < 2) return;
      postPullAttempts += 1;
      if (postPullAttempts === 1) throw transient;
      throw fatal;
    });
    for (const [scopeId, localId] of [
      ['10', 'post-prefer-a'],
      ['20', 'post-prefer-b'],
      ['30', 'post-prefer-c'],
    ] as const) {
      await service.enqueue(
        {
          scopeId,
          aggregateType: 'documents',
          identity: { kind: 'generated', localId },
          operation: 'documents.create',
          payload: { title: localId },
        },
        { flush: false },
      );
    }

    setTimeoutSpy.mockClear();
    connected.set(true);
    await expect(service.flush()).rejects.toBe(fatal);
    expect(execute).toHaveBeenCalledTimes(3);
    expectAwaitingPull(3);
    expect(postPullAttempts).toBe(2);
    expect([...pullsByScope.values()].filter((count) => count >= 2)).toHaveLength(2);
    expect([...pullsByScope.values()].filter((count) => count === 1)).toHaveLength(1);
    expect(new Set(commands.map((command) => command.scopeId))).toEqual(new Set(['10', '20', '30']));
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1_000)).toBe(false);

    const pullsAfterFatal = pull.mock.calls.length;
    vi.clearAllTimers();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pull.mock.calls.length).toBe(pullsAfterFatal);
  });

  it('遅延した旧世代のpost-pull fatalは新世代のretry_wait timerを消さない', async () => {
    vi.useFakeTimers();
    let releasePostPull!: (error: unknown) => void;
    let postPullStarted!: () => void;
    const postPullEntered = new Promise<void>((resolve) => {
      postPullStarted = resolve;
    });
    const postPullGate = new Promise<void>((_resolve, reject) => {
      releasePostPull = (error) => reject(error);
    });
    // Avoid unhandled rejection if the gate is abandoned mid-test.
    void postPullGate.catch(() => undefined);

    const pullsByScope = new Map<string, number>();
    pull.mockImplementation(async (scope) => {
      const count = (pullsByScope.get(`${scope.userId}:${scope.scopeId}`) ?? 0) + 1;
      pullsByScope.set(`${scope.userId}:${scope.scopeId}`, count);
      // Session A post-send pull stays pending until we release the fatal.
      if (scope.userId === 1 && scope.scopeId === '10' && count >= 2) {
        postPullStarted();
        await postPullGate;
      }
    });

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'stale-fatal-a' },
        operation: 'documents.create',
        payload: { title: 'a' },
      },
      { flush: false },
    );
    connected.set(true);
    const flushA = service.flush();
    await postPullEntered;

    // Transition generation without waiting for A's deferred post-pull to settle.
    service.revokeSession();
    commands = commands.filter((command) => command.userId !== 1);
    rows = rows.filter((row) => row.userId !== 1);
    session = { userId: 2, scopes: [{ userId: 2, scopeId: '20' }] };
    // Stay offline during session B activation so refreshSession does not start a
    // background flush that would swallow the subsequent explicit flush().
    connected.set(false);
    await service.refreshSession();

    execute.mockRejectedValueOnce({ status: 500 }).mockResolvedValue({ response: null });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'stale-fatal-b' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({
      state: 'retry_wait',
      retryAt: expect.any(Number),
      identity: { kind: 'generated', localId: 'stale-fatal-b' },
    });
    const executesBeforeRetry = execute.mock.calls.length;

    const fatal = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    releasePostPull(fatal);
    await expect(flushA).rejects.toBe(fatal);
    // Stale fatal must settle/reject without clearing B's armed retry timer.
    expect(service.pendingCommands()[0]).toMatchObject({
      state: 'retry_wait',
      identity: { kind: 'generated', localId: 'stale-fatal-b' },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(execute.mock.calls.length).toBeGreaterThan(executesBeforeRetry);
    expect(
      commands.some(
        (command) =>
          command.identity.kind === 'generated' && command.identity.localId === 'stale-fatal-b' && command.state !== 'awaiting_pull',
      ),
    ).toBe(false);
  });

  it('pre-pull transient失敗はscope隔離し1s自動retryをスケジュールする', async () => {
    vi.useFakeTimers();
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const transient = new Error('scope 10 transient pre-pull');
    let scope10Pulls = 0;
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10' && ++scope10Pulls === 1) throw transient;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'transient-isolated' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(transient);
    expect(execute).toHaveBeenCalledOnce();
    expect(pull.mock.calls.map((call) => call[0]?.scopeId)).toEqual(expect.arrayContaining(['10', '20']));

    const pullsBeforeRetry = pull.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(pull.mock.calls.length).toBeGreaterThan(pullsBeforeRetry);
  });

  it('pre-pull transientの後のfatalはfatalを優先して投げ残りscopeを止める', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
        { userId: 1, scopeId: '30' },
      ],
    };
    const transient = new Error('scope 10 transient');
    const fatal = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw transient;
      if (scope.scopeId === '20') throw fatal;
    });
    await service.enqueue(
      {
        scopeId: '30',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'prefer-fatal' },
        operation: 'documents.create',
        payload: { title: 'c' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(fatal);
    expect(execute).not.toHaveBeenCalled();
    expect(pull.mock.calls.map((call) => call[0]?.scopeId)).toEqual(['10', '20']);
  });

  it('英語messageだけのgeneric Errorはpre-pull fatalにしない', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const lookalike = new Error('Offline replica schema mismatch: client=1/abc, server=2/def.');
    pull.mockImplementation(async (scope) => {
      if (scope.scopeId === '10') throw lookalike;
    });
    await service.enqueue(
      {
        scopeId: '20',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'scope-b-lookalike' },
        operation: 'documents.create',
        payload: { title: 'b' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(lookalike);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ identity: { localId: 'scope-b-lookalike' } });
  });

  it('local_idを不変主キーにして送信直前に最新server_idへ解決する', async () => {
    execute.mockResolvedValueOnce({
      remoteId: 38142,
      serverRevision: 1,
      confirmedValues: { name: 'draft' },
      response: { id: 38142 },
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-aaaa' },
        operation: 'documents.create',
        payload: { name: 'draft' },
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({ identity: { kind: 'generated', localId: '019d-aaaa', remoteId: null }, syncState: 'pending' });
    expect(commands[0]).toMatchObject({ identity: { kind: 'generated', localId: '019d-aaaa' } });
    expect('remoteId' in commands[0]!).toBe(false);

    connected.set(true);
    await service.flush();
    expect(execute.mock.calls[0]?.[1]).toEqual({ kind: 'generated', localId: '019d-aaaa', remoteId: null });
    expect(rows[0]).toMatchObject({
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 38142 },
      serverRevision: 1,
      syncState: 'pending',
      confirmedValues: null,
    });
    expectAwaitingPull(1);
    expect(commands.every((command) => !('remoteId' in command))).toBe(true);

    execute.mockResolvedValueOnce({
      serverRevision: 2,
      confirmedValues: { name: 'edited' },
      response: { id: 38142, name: 'edited' },
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-aaaa' },
        operation: 'documents.update',
        payload: { name: 'edited', revision: 1 },
        baseRevision: 1,
      },
      { flush: false },
    );
    await service.flush();
    expect(execute.mock.calls[1]?.[1]).toEqual({ kind: 'generated', localId: '019d-aaaa', remoteId: 38142 });
    expect(rows[0]).toMatchObject({
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 38142 },
      serverRevision: 2,
      confirmedValues: null,
      syncState: 'pending',
    });
    expectAwaitingPull(2);
    expect(commands.every((command) => !('remoteId' in command))).toBe(true);
  });

  it('session scope発見後に前回起動のsending commandをpendingへ復旧する', async () => {
    session = null;
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: null },
      values: {},
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    });
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'interrupted',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-aaaa' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'sending',
      attempts: 1,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    await service.initialize();
    session = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    await service.refreshSession();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'pending', serverCommitUnknown: true });
  });

  it('scope数に比例せずuser単位で既知scopeのcommandsを復元する', async () => {
    session = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '20' },
      ],
    };
    const command: OfflineCommand = {
      userId: 1,
      scopeId: '10',
      commandId: 'known-10',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'known' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    };
    commands.push(
      command,
      { ...command, scopeId: '20', commandId: 'known-20' },
      { ...command, scopeId: '30', commandId: 'unknown-scope' },
      { ...command, userId: 2, commandId: 'other-user' },
    );
    const repository = TestBed.inject(OFFLINE_REPOSITORY);
    const getCommands = vi.mocked(repository.getCommands);
    const getCommandsForUser = vi.mocked(repository.getCommandsForUser!);
    getCommandsForUser.mockImplementation(async () => commands);

    await service.initialize({ flush: false });

    expect(getCommands).not.toHaveBeenCalled();
    expect(getCommandsForUser).toHaveBeenCalledTimes(3);
    expect(getCommandsForUser).toHaveBeenCalledWith(1);
    expect(service.pendingCommands().map((item) => item.commandId)).toEqual(['known-10', 'known-20']);
  });

  it('shares restart restoration with an enqueue that arrives while initialization is in flight', async () => {
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'interrupted',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'interrupted-local' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'sending',
      attempts: 1,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let blockFirstRead = true;
    beforeGetCommands = async () => {
      if (!blockFirstRead) return;
      blockFirstRead = false;
      markRestoreStarted?.();
      await restoreGate;
    };

    const initialization = service.initialize({ flush: false });
    await restoreStarted;
    const enqueue = service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'new-local' },
        operation: 'documents.create',
        payload: { title: 'new' },
      },
      { flush: false },
    );

    releaseRestore?.();
    const [, commandId] = await Promise.all([initialization, enqueue]);

    expect(repositoryInitialize).toHaveBeenCalledOnce();
    expect(putCommand).toHaveBeenCalledOnce();
    expect(commands).toHaveLength(2);
    expect(commands.find((command) => command.commandId === 'interrupted')).toMatchObject({
      state: 'pending',
      serverCommitUnknown: true,
    });
    expect(commands.find((command) => command.commandId === commandId)).toMatchObject({ state: 'pending' });
  });

  it('preserves a later caller flush request while sharing initialization', async () => {
    TestBed.flushEffects();
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'ready-to-send',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'ready-local' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let blockFirstRead = true;
    beforeGetCommands = async () => {
      if (!blockFirstRead) return;
      blockFirstRead = false;
      markRestoreStarted?.();
      await restoreGate;
    };
    networkConnected = () => true;

    const localRestore = service.initialize({ flush: false });
    await restoreStarted;
    const flushRequested = service.initialize();
    releaseRestore?.();
    await Promise.all([localRestore, flushRequested]);

    expect(repositoryInitialize).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
  });

  it('restores interrupted commands before a direct flush can start transport', async () => {
    TestBed.flushEffects();
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'interrupted-flush',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'interrupted-flush-local' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'sending',
      attempts: 1,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let blockFirstRead = true;
    beforeGetCommands = async () => {
      if (!blockFirstRead) return;
      blockFirstRead = false;
      markRestoreStarted?.();
      await restoreGate;
    };
    networkConnected = () => true;
    pull.mockImplementation(async () => {
      expect(commands[0]).toMatchObject({ state: 'pending', serverCommitUnknown: true });
      commands = [];
    });

    const flush = service.flush();
    await restoreStarted;
    expect(execute).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();

    releaseRestore?.();
    await flush;

    expect(repositoryInitialize).toHaveBeenCalledOnce();
    expect(putCommand).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledOnce();
  });

  it('does not let a refresh waiting for restore continue under a replacement session', async () => {
    TestBed.flushEffects();
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let blockFirstRead = true;
    beforeGetCommands = async () => {
      if (!blockFirstRead) return;
      blockFirstRead = false;
      markRestoreStarted?.();
      await restoreGate;
    };
    networkConnected = () => true;

    const refresh = service.refreshSession(['10']);
    await restoreStarted;
    service.revokeSession();
    session = { userId: 2, scopes: [{ userId: 2, scopeId: '20' }] };
    releaseRestore?.();
    await refresh;

    expect(pull).not.toHaveBeenCalled();
  });

  it('does not let a discard waiting for restore mutate commands after session revocation', async () => {
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'stale-discard',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'stale-discard-local' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    let releaseRestore: (() => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let blockFirstRead = true;
    beforeGetCommands = async () => {
      if (!blockFirstRead) return;
      blockFirstRead = false;
      markRestoreStarted?.();
      await restoreGate;
    };

    const discard = service.discardAllPending();
    await restoreStarted;
    service.revokeSession();
    session = { userId: 2, scopes: [{ userId: 2, scopeId: '20' }] };
    releaseRestore?.();
    await discard;

    expect(commands.map(({ commandId }) => commandId)).toEqual(['stale-discard']);
    expect(onCommandRemoved).not.toHaveBeenCalled();
  });

  it('does not start transport before a connected discard commits', async () => {
    TestBed.flushEffects();
    await service.initialize();
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'discard-local' },
        operation: 'documents.create',
        payload: { title: 'discard' },
      },
      { flush: false },
    );
    networkConnected = () => true;
    let releaseDiscard: (() => void) | undefined;
    let markDiscardStarted: (() => void) | undefined;
    const discardStarted = new Promise<void>((resolve) => {
      markDiscardStarted = resolve;
    });
    const discardGate = new Promise<void>((resolve) => {
      releaseDiscard = resolve;
    });
    beforeTransactReplica = async () => {
      markDiscardStarted?.();
      await discardGate;
    };

    const discard = service.discard(commandId);
    await discardStarted;

    expect(execute).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(commands.some((command) => command.commandId === commandId)).toBe(true);

    releaseDiscard?.();
    await discard;
    expect(commands.some((command) => command.commandId === commandId)).toBe(false);
  });

  it('restart正規化のpending+serverCommitUnknownはattentionでdiscard禁止かつretry UI対象', async () => {
    session = null;
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-restart-unknown', remoteId: null },
      values: {},
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    });
    commands.push({
      userId: 1,
      scopeId: '10',
      commandId: 'restart-unknown',
      aggregateType: 'documents',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-restart-unknown' },
      operation: 'documents.create',
      payload: {},
      baseRevision: null,
      state: 'sending',
      attempts: 1,
      retryAt: null,
      createdAt: 1,
      lastErrorCode: null,
    });
    await service.initialize();
    session = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    await service.refreshSession();

    expect(service.pendingCommands()[0]).toMatchObject({ state: 'pending', serverCommitUnknown: true });
    expect(service.syncState()).toBe('attention');
    await expect(service.discard('restart-unknown', { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    await expect(service.discardAllPending()).rejects.toBeInstanceOf(OfflineCommandInFlightError);

    execute.mockResolvedValueOnce({ response: null });
    connected.set(true);
    await service.retryNow('restart-unknown');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('未同期createを破棄するとoutboxと未確定replica rowを同時に除く', async () => {
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-new' },
        operation: 'documents.create',
        payload: { name: 'draft' },
      },
      { flush: false },
    );
    await service.discard(commandId, { flush: false });
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('既存replica rowの未同期updateを破棄するとserver確定値へ戻す', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-existing', remoteId: 38142 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-existing' },
        operation: 'documents.update',
        payload: { name: 'draft', revision: 4 },
        baseRevision: 4,
      },
      { flush: false },
    );
    expect(rows[0]?.values).toEqual({ id: 38142, name: 'draft', revision: 4 });
    await service.discard(commandId, { flush: false });
    expect(rows[0]).toMatchObject({
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      syncState: 'confirmed',
      identity: expect.objectContaining({ remoteId: 38142 }),
    });
  });

  it('resolved conflictはreplacement準備成功まで元commandとoptimistic rowを保持する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'replace-failure', remoteId: 12 },
      values: { id: 12, title: 'local conflict' },
      confirmedValues: { id: 12, title: 'server' },
      serverRevision: 3,
      fetchedAt: 1,
      syncState: 'conflict',
    });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-failure' },
        operation: 'documents.update',
        payload: { title: 'local conflict' },
        baseRevision: 3,
      },
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };

    await expect(
      service.replacePrepared(commandId, async () => {
        throw new Error('replacement preparation failed');
      }),
    ).rejects.toThrow('replacement preparation failed');

    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandId).toBe(commandId);
    expect(rows[0]?.values).toEqual({ id: 12, title: 'local conflict' });
  });

  it('resolved conflictをreplacement commandとoptimistic rowへ一transactionで置換する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'replace-success', remoteId: 13 },
      values: { id: 13, title: 'old local' },
      confirmedValues: { id: 13, title: 'server' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'conflict',
    });
    const oldCommandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-success' },
        operation: 'documents.update',
        payload: { title: 'old local' },
        baseRevision: 4,
      },
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };
    const originalCreatedAt = commands[0]!.createdAt;

    const newCommandId = await service.replacePrepared(
      oldCommandId,
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-success' },
          operation: 'documents.update',
          payload: { title: 'new local' },
          baseRevision: 4,
        },
      }),
      { flush: false },
    );

    expect(newCommandId).not.toBe(oldCommandId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ commandId: newCommandId, state: 'pending', createdAt: originalCreatedAt });
    expect(rows[0]).toMatchObject({ values: { id: 13, title: 'new local' }, syncState: 'pending' });
  });

  it('同じaggregateに後続commandがあるreplacementを元状態のまま拒否する', async () => {
    const oldCommandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-ordered' },
        operation: 'documents.update',
        payload: { title: 'first' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-ordered' },
        operation: 'documents.update',
        payload: { title: 'second' },
      },
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };
    const prepare = vi.fn(async () => ({
      request: {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated' as const, localId: 'replace-ordered' },
        operation: 'documents.update',
        payload: { title: 'replacement' },
      },
    }));

    await expect(service.replacePrepared(oldCommandId, prepare, { flush: false })).rejects.toThrow('only pending intent for its aggregate');

    expect(prepare).not.toHaveBeenCalled();
    expect(commands.map((command) => command.commandId)).toHaveLength(2);
    expect(rows.find((row) => row.identity.kind === 'generated' && row.identity.localId === 'replace-ordered')?.values).toEqual({
      id: 0,
      title: 'second',
    });
  });

  it('同じaggregateの競合commandと後続intentを一transactionで再materializeする', async () => {
    const firstId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-chain' },
        operation: 'documents.update',
        payload: { title: 'stocktake' },
        baseRevision: 1,
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-chain' },
        operation: 'documents.update',
        payload: { title: 'later delta' },
        baseRevision: 1,
      },
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };
    const originalIds = commands.map((command) => command.commandId);
    const originalCreatedAt = commands.map((command) => command.createdAt);

    const replacementIds = await service.replacePreparedAggregate(
      firstId,
      async (_repository, chain) =>
        chain.map((command, index) => ({
          request: {
            scopeId: command.scopeId,
            aggregateType: command.aggregateType,
            identity: command.identity,
            operation: command.operation,
            payload: { title: index === 0 ? 'new stocktake' : 'new stocktake plus delta' },
            baseRevision: 2,
          },
        })),
      { flush: false },
    );

    expect(replacementIds).toHaveLength(2);
    expect(replacementIds).not.toEqual(originalIds);
    expect(commands.map((command) => command.commandId)).toEqual(replacementIds);
    expect(commands.map((command) => command.state)).toEqual(['pending', 'pending']);
    expect(commands.map((command) => command.createdAt)).toEqual(originalCreatedAt);
    expect(rows.find((row) => row.identity.kind === 'generated' && row.identity.localId === 'replace-chain')?.values).toEqual({
      id: 0,
      title: 'new stocktake plus delta',
    });
  });

  it('aggregate chainの準備失敗では元commandとprojectionを一切変更しない', async () => {
    const firstId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-chain-failure' },
        operation: 'documents.update',
        payload: { title: 'first' },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'replace-chain-failure' },
        operation: 'documents.update',
        payload: { title: 'second' },
      },
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };
    const beforeCommands = structuredClone(commands);
    const beforeRows = structuredClone(rows);

    await expect(
      service.replacePreparedAggregate(firstId, async () => {
        throw new Error('chain preparation failed');
      }),
    ).rejects.toThrow('chain preparation failed');

    expect(commands).toEqual(beforeCommands);
    expect(rows).toEqual(beforeRows);
  });

  it('replacement must preserve the declared localOnly footprint', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'replace-companion-view' },
      values: { title: 'baseline' },
      confirmedValues: { title: 'baseline' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    rows.push(companion);
    const oldCommandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-companion' },
          operation: 'documents.update',
          payload: { title: 'old local' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };

    await expect(
      service.replacePrepared(
        oldCommandId,
        async () => ({
          request: {
            scopeId: '10',
            aggregateType: 'documents',
            identity: { kind: 'generated', localId: 'replace-companion' },
            operation: 'documents.update',
            payload: { title: 'new local' },
          },
        }),
        { flush: false },
      ),
    ).rejects.toThrow('preserve the localOnly footprint');

    expect(commands).toHaveLength(1);
    expect(commands[0]?.commandId).toBe(oldCommandId);
    expect(rows.find((row) => row.sourceKey === 'document_views')?.values).toEqual({ title: 'old local' });
  });

  it('replacement rematerializes remaining intents and discard restores confirmed localOnly values', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'replace-put-view' },
      values: { title: 'baseline' },
      confirmedValues: { title: 'baseline' },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    rows.push(companion);
    const oldCommandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-put' },
          operation: 'documents.update',
          payload: { title: 'old local' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };

    const newCommandId = await service.replacePrepared(
      oldCommandId,
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-put' },
          operation: 'documents.update',
          payload: { title: 'new local' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );

    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'new local' },
      confirmedValues: { title: 'baseline' },
    });
    await service.discard(newCommandId);
    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'baseline' },
      confirmedValues: { title: 'baseline' },
      syncState: 'confirmed',
    });
  });

  it('replacement keeps the latest confirmedValues after a conflict pull', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'replace-pulled-view' },
      values: { title: 'baseline' },
      confirmedValues: { title: 'baseline' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    };
    rows.push(companion);
    const oldCommandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-pulled' },
          operation: 'documents.update',
          payload: { title: 'old local' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );
    commands[0] = { ...commands[0]!, state: 'conflict' };
    const companionIndex = rows.findIndex((row) => row.sourceKey === 'document_views');
    rows[companionIndex] = {
      ...rows[companionIndex]!,
      values: { title: 'old local' },
      confirmedValues: { title: 'latest server' },
      serverRevision: 2,
      syncState: 'conflict',
    };

    const newCommandId = await service.replacePrepared(
      oldCommandId,
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'replace-pulled' },
          operation: 'documents.update',
          payload: { title: 'new local' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );

    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'new local' },
      confirmedValues: { title: 'latest server' },
      serverRevision: 2,
    });
    await service.discard(newCommandId);
    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'latest server' },
      confirmedValues: { title: 'latest server' },
      serverRevision: 2,
      syncState: 'confirmed',
    });
  });

  it('discards a create-only localOnly row when no remaining command owns it', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'new-companion-view' },
      values: { title: 'unused input' },
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
    };
    const firstCommandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'new-companion' },
          operation: 'documents.update',
          payload: { title: 'first' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );
    const secondCommandId = await service.enqueuePrepared(
      async () => ({
        request: {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'new-companion' },
          operation: 'documents.update',
          payload: { title: 'second' },
          localOnlyFootprint: [companion],
        },
      }),
      { flush: false },
    );

    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'second' },
      confirmedValues: null,
    });
    await service.discard(secondCommandId);
    expect(rows.find((row) => row.sourceKey === 'document_views')).toMatchObject({
      values: { title: 'first' },
      confirmedValues: null,
    });
    await service.discard(firstCommandId);
    expect(rows.find((row) => row.sourceKey === 'document_views')).toBeUndefined();
  });

  it('同一ミリ秒のDate.nowでもcreatedAtは単調増加で保存する', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '2' },
        operation: 'documents.upsert',
        payload: { seq: 2 },
      },
      { flush: false },
    );
    const createdAt = commands.map((command) => command.createdAt);
    expect(createdAt[0]).toBeLessThan(createdAt[1]!);
    expect(service.pendingCommands().map((command) => command.createdAt)).toEqual(createdAt);
    nowSpy.mockRestore();
  });

  it('replicaのserverRevisionが進んでもenqueue payloadは構造的に不変でbaseRevisionだけ更新する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-rebase-payload', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    const payload = { name: 'draft', expectedRevision: 1 };
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-rebase-payload' },
        operation: 'documents.update',
        payload,
        baseRevision: 1,
      },
      { flush: false },
    );
    expect(commands[0]).toMatchObject({ baseRevision: 4 });
    expect(JSON.stringify(commands[0]?.payload)).toBe(JSON.stringify(payload));
  });

  it('JSON payloadのkey順を変えずに保持する', async () => {
    const first = { あ: 3, z: 1, ä: 2 };
    const second = { ä: 2, あ: 3, z: 1 };
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: first,
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '2' },
        operation: 'documents.upsert',
        payload: second,
      },
      { flush: false },
    );
    expect(JSON.stringify(service.pendingCommands()[0]?.payload)).toBe(JSON.stringify(first));
    expect(JSON.stringify(service.pendingCommands()[1]?.payload)).toBe(JSON.stringify(second));
  });

  it('JSON外payloadをrejectする', async () => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '1' },
          operation: 'documents.upsert',
          payload: { value: undefined },
        },
        { flush: false },
      ),
    ).rejects.toBeInstanceOf(OfflinePayloadValidationError);
  });

  it.each([
    [401, 'blocked_auth', 'blocked_auth'],
    [409, 'conflict', 'conflict'],
    [422, 'rejected', 'rejected'],
    [500, 'retry_wait', 'pending'],
  ] as const)('HTTP %sを%sへ分類して操作を保持する', async (status, state, rowSyncState) => {
    execute.mockRejectedValueOnce({ status });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state, lastErrorCode: String(status) });
    expect(rows[0]?.syncState).toBe(rowSyncState);
  });

  it('retry_waitかつserverCommitUnknownのcommandはattentionとして見える', async () => {
    execute.mockRejectedValueOnce({ status: 500 });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'ambiguous-retry' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', serverCommitUnknown: true });
    expect(service.syncState()).toBe('attention');
  });

  it('pendingかつserverCommitUnknownのcommandもattentionとして見える', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'pending-unknown' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    const current = commands[0]!;
    commands[0] = { ...current, state: 'pending', serverCommitUnknown: true };
    await service.reloadPendingCommands();
    expect(service.syncState()).toBe('attention');
    await expect(service.discard(current.commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
  });

  it('serverCommitUnknownでないretry_waitはpendingのままattentionにしない', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'safe-retry' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    const current = commands[0]!;
    commands[0] = {
      ...current,
      state: 'retry_wait',
      retryAt: Date.now() + 60_000,
      serverCommitUnknown: false,
    };
    await service.reloadPendingCommands();
    expect(service.syncState()).toBe('pending');
  });

  it('retry delayはequal jitterで注入可能な乱数を使う', async () => {
    TestBed.resetTestingModule();
    const random = vi.fn(() => 0.25);
    // Rebuild the standard providers from beforeEach with an injectable random source.
    connected = signal(false);
    session = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    commands = [];
    rows = [];
    pull = vi.fn(async () => undefined);
    execute.mockReset();
    execute.mockRejectedValueOnce({ status: 500 });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async (scope: OfflineScope) =>
        commands.filter((item) => item.userId === scope.userId && item.scopeId === scope.scopeId),
      ),
      getCommandsForUser: vi.fn(async (userId: number) => commands.filter((item) => item.userId === userId)),
      putCommand: vi.fn(async (command: OfflineCommand) => {
        commands = commands.filter((item) => item.commandId !== command.commandId);
        commands.push(structuredClone(command));
      }),
      replaceCommand: vi.fn(async (command: OfflineCommand) => {
        commands = commands.filter((item) => item.commandId !== command.commandId);
        commands.push(structuredClone(command));
      }),
      removeCommand: vi.fn(async (commandId: string) => {
        commands = commands.filter((item) => item.commandId !== commandId);
      }),
      getReplicaRow: vi.fn(async (scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) => {
        return (
          rows.find((item) => {
            if (item.userId !== scope.userId || item.scopeId !== scope.scopeId || item.sourceKey !== sourceKey) return false;
            if (identity.kind === 'generated') {
              return item.identity.kind === 'generated' && item.identity.localId === identity.localId;
            }
            return false;
          }) ?? null
        );
      }),
      getReplicaRowIncludingPendingDelete: vi.fn(async (scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) => {
        return (
          rows.find((item) => {
            if (item.userId !== scope.userId || item.scopeId !== scope.scopeId || item.sourceKey !== sourceKey) return false;
            if (identity.kind === 'generated') {
              return item.identity.kind === 'generated' && item.identity.localId === identity.localId;
            }
            return false;
          }) ?? null
        );
      }),
      getReplicaRowByRemoteId: vi.fn(async () => null),
      getReplicaRowByRemoteIdentity: vi.fn(async () => null),
      getReplicaCursor: vi.fn(async () => null),
      getPullAttentions: vi.fn(async () => []),
      transactReplica: vi.fn(async (transaction) => {
        for (const command of transaction.putCommands ?? []) {
          commands = commands.filter((item) => item.commandId !== command.commandId);
          commands.push(structuredClone(command));
        }
        for (const row of transaction.putRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== row.userId ||
              item.scopeId !== row.scopeId ||
              item.sourceKey !== row.sourceKey ||
              canonicalOfflineReplicaIdentity(item.identity) !== canonicalOfflineReplicaIdentity(row.identity),
          );
          rows.push(structuredClone(row));
        }
        commands = commands.filter((command) => !(transaction.removeCommandIds ?? []).includes(command.commandId));
      }),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [
        OfflineSyncService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: { connected } },
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', databaseEncryption: false, replicaSchema } },
        { provide: OfflineReplicaPullService, useValue: { pull } },
        { provide: ErrorHandler, useValue: { handleError: vi.fn() } },
        { provide: OFFLINE_RETRY_RANDOM, useValue: random },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (command: OfflineCommand) => command.aggregateType },
        },
        {
          provide: OFFLINE_SYNC_CONTEXT,
          useValue: {
            getLocalSession: vi.fn(async () => session),
            getSession: vi.fn(async () => session),
          },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: {
            execute,
            provesCommandNotCommitted: () => false,
          },
        },
        { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project: rematerializeTestAggregate } },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'jitter' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(random).toHaveBeenCalled();
    const retryAt = service.pendingCommands()[0]?.retryAt;
    expect(retryAt).toEqual(expect.any(Number));
    expect(retryAt! - Date.now()).toBeLessThanOrEqual(offlineRetryDelayMs(1, () => 0.25));
  });

  it('offlineRetryDelayMsは[⌊cap/2⌋, cap)のequal jitterを返す', () => {
    expect(offlineRetryDelayMs(1, () => 0)).toBe(500);
    expect(offlineRetryDelayMs(1, () => 0.999)).toBe(999);
    expect(offlineRetryDelayMs(3, () => 0.5)).toBe(3000);
    expect(() => offlineRetryDelayMs(1, () => 1)).toThrow('must return a number in [0, 1)');
  });

  it('retryNowは未来のbackoffを解除して選択したcommandを直ちに再送する', async () => {
    execute.mockRejectedValueOnce({ status: 500 }).mockResolvedValueOnce({ response: null });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'manual-retry' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', retryAt: expect.any(Number) });

    await service.retryNow(commandId);

    expect(execute).toHaveBeenCalledTimes(2);
    expectAwaitingPull(1);
  });

  it('retryNowは再認証後のblocked_authを解除して選択したcommandを再送する', async () => {
    execute.mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce({ response: null });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'reauth-retry' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'blocked_auth', lastErrorCode: '401' });

    await service.retryNow(commandId);

    expect(execute).toHaveBeenCalledTimes(2);
    expectAwaitingPull(1);
  });

  it('retryNow待機中にACK削除されたcommandを古いsnapshotから復活させない', async () => {
    execute.mockRejectedValueOnce({ status: 500 });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'retry-ack-race' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    connected.set(false);
    expect(commands[0]).toMatchObject({ commandId, state: 'retry_wait' });

    let readsAfterRetryStarted = 0;
    beforeGetCommands = async () => {
      readsAfterRetryStarted += 1;
      if (readsAfterRetryStarted === 2) commands = commands.filter((command) => command.commandId !== commandId);
    };

    await service.retryNow(commandId);

    expect(commands.some((command) => command.commandId === commandId)).toBe(false);
    expect(service.pendingCommands()).toEqual([]);
  });

  it.each([
    [0, 'retry_wait'],
    [401, 'blocked_auth'],
    [409, 'conflict'],
    [422, 'rejected'],
  ] as const)('hidden deleteはHTTP %s後もvisibilityを維持する', async (status, state) => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: `delete-${status}`, remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    execute.mockRejectedValueOnce({ status });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: generatedCommandIdentity(`delete-${status}`),
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({ visibility: 'pending_delete' });
    expect(commands[0]).toMatchObject({ replicaMutation: 'delete', state });
  });

  it('executor送信中のdiscardAllPendingを拒否してserver結果の確定を待つ', async () => {
    let resolveExecute!: (value: { response: null; serverRevision?: number }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 2 },
      },
      { flush: false },
    );
    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(service.discardAllPending()).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    expect(commands[0]?.state).toBe('sending');
    resolveExecute({ response: null, serverRevision: 2 });
    await flush;
    expect(execute).toHaveBeenCalledTimes(2);
    expectAwaitingPull(2);
  });

  it('executor送信中のsingle discardを拒否してoptimistic rowとcommandを保持する', async () => {
    let resolveExecute!: (value: { response: null }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'discard-in-flight' },
        operation: 'documents.upsert',
        payload: { title: 'pending' },
      },
      { flush: false },
    );
    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await expect(service.discard(commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    expect(commands).toEqual([expect.objectContaining({ commandId, state: 'sending' })]);
    expect(rows).toEqual([expect.objectContaining({ values: { id: 0, title: 'pending' } })]);

    resolveExecute({ response: null });
    await flush;
  });

  it('response-lossでretry_waitのcommandはserver commit不明のためdiscardを拒否する', async () => {
    execute.mockRejectedValueOnce({ status: 0 });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'discard-response-loss' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(commands[0]?.state).toBe('retry_wait');

    await expect(service.discard(commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    await expect(service.discardAllPending()).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    expect(commands).toEqual([expect.objectContaining({ commandId, state: 'retry_wait' })]);

    connected.set(false);
    await service.retryNow(commandId);
    expect(commands).toEqual([expect.objectContaining({ commandId, state: 'pending', serverCommitUnknown: true })]);
    await expect(service.discard(commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
    await expect(service.discardAllPending()).rejects.toBeInstanceOf(OfflineCommandInFlightError);

    execute.mockRejectedValueOnce({ status: 401 });
    connected.set(true);
    await vi.waitFor(() => expect(service.pendingCommands()[0]?.state).toBe('blocked_auth'));
    expect(service.pendingCommands()[0]).toMatchObject({ serverCommitUnknown: true });
    await expect(service.discard(commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);
  });

  it.each([409, 422])('response-loss後にHTTP %sへ分類されても同じkeyで再確認してACKへ収束する', async (status) => {
    execute.mockRejectedValueOnce({ status: 0 }).mockRejectedValueOnce({ status }).mockResolvedValueOnce({ response: null });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: `ambiguous-${status}` },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    await service.retryNow(commandId);

    expect(service.pendingCommands()[0]).toMatchObject({
      commandId,
      state: status === 409 ? 'conflict' : 'rejected',
      serverCommitUnknown: true,
    });
    await expect(service.discard(commandId, { flush: false })).rejects.toBeInstanceOf(OfflineCommandInFlightError);

    await service.retryNow(commandId);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([command]) => command.commandId)).toEqual([commandId, commandId, commandId]);
    expectAwaitingPull(1);
  });

  it('executorが同じkeyの未commitを証明した競合はambiguityを解除して通常解決へ渡す', async () => {
    execute.mockRejectedValueOnce({ status: 0 }).mockRejectedValueOnce({ status: 412 });
    provesCommandNotCommitted.mockImplementation((error) => (error as { status?: number }).status === 412);
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'authoritative-no-commit' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    await service.retryNow(commandId);

    expect(service.pendingCommands()[0]).toMatchObject({
      commandId,
      state: 'conflict',
      serverCommitUnknown: false,
    });
    await expect(service.discard(commandId, { flush: false })).resolves.toBeUndefined();
  });

  it('flush中のsession切替後に旧user commandを新sessionへ復活させない', async () => {
    let resolveExecute!: (value: { response: null; serverRevision?: number }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 2 },
      },
      { flush: false },
    );
    connected.set(true);
    const oldFlush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const reset = service.resetSession();
    resolveExecute({ response: null, serverRevision: 2 });
    await reset;
    commands = commands.filter((command) => command.userId !== 1);
    connected.set(false);
    session = { userId: 2, scopes: [{ userId: 2, scopeId: '20' }] };
    await service.refreshSession();
    await oldFlush;
    expect(execute).toHaveBeenCalledOnce();
    expect(commands.some((command) => command.userId === 1)).toBe(false);
  });

  it('flush中に同一sessionを再activateしてもsending commandをpendingへ戻す', async () => {
    let resolveFirst!: (value: { response: null }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    connected.set(true);
    const oldFlush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    connected.set(false);
    const reset = service.resetSession();
    resolveFirst({ response: null });
    await reset;
    await service.refreshSession();
    expect(service.pendingCommands()[0]?.state).toBe('pending');
    await oldFlush;
    connected.set(true);
    await service.flush();
    expect(execute).toHaveBeenCalledTimes(2);
    expectAwaitingPull(1);
  });

  it('background flush failureはErrorHandlerへ渡し、await flushはrejectする', async () => {
    const pullError = new Error('pull failed');
    pull.mockRejectedValue(pullError);
    connected.set(true);
    await service.initialize();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(pullError));
    await expect(service.flush()).rejects.toThrow('pull failed');
  });

  it('lifecycle遷移のない通常408はErrorHandlerへ渡してflushもrejectする', async () => {
    const timeout = { status: 408, statusText: 'Request Timeout' };
    pull.mockRejectedValue(timeout);
    connected.set(true);
    await service.initialize();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(timeout));
    await expect(service.flush()).rejects.toBe(timeout);
  });

  it('pull開始前に完了したbackground往復では後続の通常408を隠さない', async () => {
    await service.initialize({ flush: false });
    let releaseDiscovery!: () => void;
    let notifyDiscovery!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => (notifyDiscovery = resolve));
    const discoveryGate = new Promise<void>((resolve) => (releaseDiscovery = resolve));
    beforeGetCommands = async () => {
      notifyDiscovery();
      await discoveryGate;
    };
    const timeout = { status: 408, statusText: 'Request Timeout' };
    pull.mockRejectedValueOnce(timeout).mockResolvedValue(undefined);

    connected.set(true);
    await discoveryStarted;
    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(false);
    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(true);
    releaseDiscovery();

    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(timeout));
  });

  it.each([0, 408])('background遷移をまたいだpullのstatus %sは報告せずforeground復帰後に再同期する', async (status) => {
    let rejectSuspendedPull!: (error: unknown) => void;
    pull.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectSuspendedPull = reject)),
    );
    connected.set(true);
    await service.initialize();
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());

    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(false);
    rejectSuspendedPull({ status, statusText: status === 408 ? 'Request Timeout' : 'Unknown Error' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(handleError).not.toHaveBeenCalled();

    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(true);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    expect(handleError).not.toHaveBeenCalled();
  });

  it('initial inactiveとbackground中はpullせずforegroundで開始する', async () => {
    appActive.set(false);
    connected.set(true);
    await service.initialize();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(pull).not.toHaveBeenCalled();

    lifecycleRevision.update((revision) => revision + 1);
    appActive.set(true);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
  });

  it('background error reporting preserves the microtask boundary and absorbs reporter rejection', async () => {
    const events: string[] = [];
    const pullError = new Error('background pull failed');
    handleError.mockImplementation((error) => {
      events.push(`reported:${(error as Error).message}`);
      return Promise.reject(new Error('reporter failed')) as never;
    });
    pull.mockRejectedValue(pullError);

    connected.set(true);
    const initialization = service.initialize();
    events.push('initialize-returned');
    expect(handleError).not.toHaveBeenCalled();

    await initialization;
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(pullError));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events[0]).toBe('initialize-returned');
    expect(events.slice(1)).not.toHaveLength(0);
    expect(events.slice(1).every((event) => event === 'reported:background pull failed')).toBe(true);
  });

  it('sending書き込み中の同一session resetでも完了後にpendingへ復旧する', async () => {
    let notifySendingStarted!: () => void;
    const sendingStarted = new Promise<void>((resolve) => (notifySendingStarted = resolve));
    let releaseSendingWrite!: () => void;
    const sendingWrite = new Promise<void>((resolve) => (releaseSendingWrite = resolve));
    beforePutCommand = async (command) => {
      if (command.state !== 'sending') return;
      notifySendingStarted();
      await sendingWrite;
    };
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
      },
      { flush: false },
    );
    connected.set(true);
    const oldFlush = service.flush();
    await sendingStarted;
    connected.set(false);
    const reset = service.resetSession();
    releaseSendingWrite();
    await reset;
    beforePutCommand = null;
    await service.refreshSession();
    expect(service.pendingCommands()[0]?.state).toBe('pending');
    await oldFlush;
    expect(execute).not.toHaveBeenCalled();
    connected.set(true);
    await service.flush();
    expect(execute).toHaveBeenCalledOnce();
    expectAwaitingPull(1);
  });

  it('local replica row lookup rejectionでもsendingに残さずretry_waitへ戻す', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    const lookupError = new Error('replica lookup failed');
    vi.mocked(repository.getReplicaRow).mockRejectedValue(lookupError);
    vi.mocked(repository.getReplicaRowIncludingPendingDelete!).mockRejectedValue(lookupError);
    connected.set(true);
    await service.refreshSession();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(lookupError));

    await service.refreshSession();
    await expect(service.flush()).resolves.toBeUndefined();
    expect(service.pendingCommands()[0]).toMatchObject({
      state: 'retry_wait',
      lastErrorCode: 'network',
      serverCommitUnknown: false,
    });
    expect(execute).not.toHaveBeenCalled();

    vi.mocked(repository.getReplicaRow).mockResolvedValue(rows[0] ?? null);
    vi.mocked(repository.getReplicaRowIncludingPendingDelete!).mockResolvedValue(rows[0] ?? null);
    await service.discard(service.pendingCommands()[0]!.commandId, { flush: false });
    expect(service.pendingCount()).toBe(0);
    expect(commands).toEqual([]);
  });

  it('pre-transport retry_waitはdiscardAllPendingで回復できる', async () => {
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'pretransport-discard-all' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    commands = commands.map((command) =>
      command.commandId === commandId
        ? { ...command, state: 'retry_wait', retryAt: Date.now() + 1_000, serverCommitUnknown: false }
        : command,
    );
    await service.reloadPendingCommands();

    await service.discardAllPending();
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
    expect(service.pendingCount()).toBe(0);
  });

  it('single discardのpostcommit hook失敗は報告のみでrepositoryとsignalを空へ収束させる', async () => {
    const hookError = new Error('media cleanup failed');
    onCommandRemoved.mockRejectedValueOnce(hookError);
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'discard-hook-failure' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );

    await expect(service.discard(commandId, { flush: false })).resolves.toBeUndefined();
    expect(commands).toEqual([]);
    expect(service.pendingCount()).toBe(0);
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(hookError));
  });

  it('discardAllPendingのpostcommit hook失敗も報告のみでrepositoryとsignalを空へ収束させる', async () => {
    const hookError = new Error('bulk media cleanup failed');
    onCommandRemoved.mockRejectedValueOnce(hookError);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'discard-all-hook-failure' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );

    await expect(service.discardAllPending()).resolves.toBeUndefined();
    expect(commands).toEqual([]);
    expect(service.pendingCount()).toBe(0);
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(hookError));
  });

  it('sending claimとcommand取消を同じmutation laneで直列化する', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'claim-race' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    let sendingStarted!: () => void;
    const started = new Promise<void>((resolve) => (sendingStarted = resolve));
    let releaseSending!: () => void;
    const sendingBarrier = new Promise<void>((resolve) => (releaseSending = resolve));
    beforePutCommand = async (command) => {
      if (command.state !== 'sending') return;
      sendingStarted();
      await sendingBarrier;
    };

    connected.set(true);
    const flush = service.flush();
    await started;
    let cancellationEntered = false;
    const cancellation = service.runSerializedReplicaMutation(async (repository) => {
      cancellationEntered = true;
      const current = (await repository.getCommands({ userId: 1, scopeId: '10' })).find(
        (command) => command.commandId === commands[0]?.commandId,
      );
      expect(current?.state).toBe('sending');
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cancellationEntered).toBe(false);

    releaseSending();
    await cancellation;
    await flush;
    expect(execute).toHaveBeenCalledOnce();
  });

  it('取消が先にmutation laneを確保した場合はtransport claimがcommandを復活させない', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'cancel-before-claim' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    let cancellationStarted!: () => void;
    const started = new Promise<void>((resolve) => (cancellationStarted = resolve));
    let releaseCancellation!: () => void;
    const cancellationBarrier = new Promise<void>((resolve) => (releaseCancellation = resolve));
    const cancellation = service.runSerializedReplicaMutation(async (repository) => {
      cancellationStarted();
      await cancellationBarrier;
      await repository.transactReplica({ removeCommandIds: [commands[0]!.commandId] });
    });
    await started;
    connected.set(true);
    const flush = service.flush();
    releaseCancellation();
    await cancellation;
    await flush;

    expect(commands).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('transactReplica failureはrejectしbackground flushはErrorHandlerへ渡す', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    const originalTransact = vi.mocked(repository.transactReplica).getMockImplementation()!;
    vi.mocked(repository.transactReplica).mockImplementation(async (transaction) => {
      if (transaction.putCommands?.some((command) => command.state === 'awaiting_pull')) {
        throw new Error('transaction failed');
      }
      return originalTransact(transaction);
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.refreshSession();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'transaction failed' })));

    await service.refreshSession();
    await expect(service.flush()).resolves.toBeUndefined();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', lastErrorCode: 'network' });
  });

  it('executor error without integer statusもsendingに残さずretry_waitへ戻す', async () => {
    execute.mockRejectedValueOnce(new Error('programming failure'));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('programming failure');
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', lastErrorCode: 'network' });
  });

  it('executor error with negative statusもsendingに残さずretry_waitへ戻す', async () => {
    execute.mockRejectedValueOnce({ status: -1 });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', lastErrorCode: 'network' });
  });

  it('invalid remoteIdはhard failする', async () => {
    execute.mockResolvedValueOnce({ remoteId: 0, serverRevision: 1, confirmedValues: {}, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-invalid-id' },
        operation: 'documents.create',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline replica generated remote id must be a positive integer.');
  });

  it('naturalKey entityへのremoteId応答はcompleteCommand境界でhard failする', async () => {
    options.replicaSchema = naturalReplicaSchema;
    execute.mockResolvedValueOnce({
      remoteId: 99,
      serverRevision: 1,
      confirmedValues: { favFrom: 7, favTo: '42', title: 'confirmed' },
      response: null,
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'natural_documents',
        identity: { kind: 'natural', naturalKey: { favFrom: 7, favTo: '42' } },
        operation: 'natural_documents.create',
        payload: { favTo: '42', title: 'local' },
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow(
      'Offline command returned generated remote id for naturalKey source "natural_documents".',
    );
  });

  it('naturalKey entityへgenerated identityを指定するとenqueue境界でhard failする', async () => {
    options.replicaSchema = naturalReplicaSchema;
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'natural_documents',
          identity: { kind: 'generated', localId: 'immutable-uuid', remoteIdHint: 99 },
          operation: 'natural_documents.create',
          payload: { favTo: '42', title: 'local' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline replica source "natural_documents" requires natural identity.');
  });

  it('empty generated localIdを永続化前に拒否する', async () => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '' },
          operation: 'documents.create',
          payload: { title: 'local' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline localId must be a non-empty normalized string');
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('reassigned remoteIdはhard failする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-existing', remoteId: 38142 },
      values: {},
      confirmedValues: {},
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    execute.mockResolvedValueOnce({ remoteId: 99999, serverRevision: 2, confirmedValues: {}, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-existing' },
        operation: 'documents.update',
        payload: {},
        baseRevision: 1,
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline replica remote id is immutable');
  });

  it('enqueue時のremoteId採用は初回pull前にreplica rowへ永続化する', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-adopted', remoteId: 38142 },
        operation: 'documents.update',
        payload: { name: 'adopted' },
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({
      identity: { kind: 'generated', localId: '019d-adopted', remoteId: 38142 },
      confirmedValues: null,
      syncState: 'pending',
    });
  });

  it('採用済みremoteIdはflush時にdelete操作のexecutor targetへ渡す', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-adopted', remoteId: 38142 },
        operation: 'documents.delete',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    execute.mockResolvedValueOnce({ removeReplica: true, response: null });
    await service.flush();
    expect(execute.mock.calls[0]?.[1]).toEqual({ kind: 'generated', localId: '019d-adopted', remoteId: 38142 });
  });

  it('confirmed rowのdeleteはOutbox markerとhidden baselineを原子的に残し、ACKでphysical removeする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-delete', remoteId: 38142 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-delete' },
        operation: 'documents.delete',
        payload: { id: 38142 },
        baseRevision: 4,
        replicaMutation: 'delete',
      },
      { flush: false },
    );

    expect(rows[0]).toMatchObject({ visibility: 'pending_delete', confirmedValues: { name: 'confirmed' }, serverRevision: 4 });
    expect(commands[0]).toMatchObject({
      replicaMutation: 'delete',
      identity: { kind: 'generated', localId: '019d-delete' },
      baseRevision: 4,
    });

    execute.mockResolvedValueOnce({ removeReplica: true, response: null });
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({ visibility: 'pending_delete', confirmedValues: { name: 'confirmed' } });
    expectAwaitingPull(1);
  });

  it('delete intentはexecutorがremoveReplicaを省略しても成功ACKでphysical removeする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-delete-without-projection', remoteId: 38142 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-delete-without-projection' },
        operation: 'documents.delete',
        payload: { id: 38142 },
        baseRevision: 4,
        replicaMutation: 'delete',
      },
      { flush: false },
    );

    execute.mockResolvedValueOnce({ response: null });
    connected.set(true);
    await service.flush();

    expect(rows[0]).toMatchObject({ visibility: 'pending_delete' });
    expectAwaitingPull(1);
  });

  it('delete後のqueued recreateはlocalIdを維持してremoteIdを再割当できる', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'stable-local-id', remoteId: 42 },
      values: { name: 'confirmed', presentation: 'pending' },
      confirmedValues: { name: 'confirmed', presentation: 'pending' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'stable-local-id' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'stable-local-id' },
        operation: 'documents.create',
        payload: { name: 'recreated', presentation: null },
      },
      { flush: false },
    );

    execute.mockResolvedValueOnce({ removeReplica: true, clearRemoteId: true, response: null }).mockImplementationOnce(async () => {
      expect(rows[0]).toMatchObject({
        identity: { kind: 'generated', localId: 'stable-local-id', remoteId: null },
        values: { name: 'recreated', presentation: null },
      });
      return {
        remoteId: 43,
        response: null,
      };
    });
    connected.set(true);

    const recreatePayload = { name: 'recreated', presentation: null };
    await service.flush();

    expect(JSON.stringify((execute.mock.calls[1]?.[0] as OfflineCommand).payload)).toBe(JSON.stringify(recreatePayload));
    expect((execute.mock.calls[1]?.[0] as OfflineCommand).baseRevision).toBeNull();
    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'generated', localId: 'stable-local-id', remoteId: 42 },
      { kind: 'generated', localId: 'stable-local-id', remoteId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: 'stable-local-id', remoteId: 43 },
        values: expect.objectContaining({ name: 'recreated', presentation: null }),
        syncState: 'pending',
      }),
    ]);
    expectAwaitingPull(2);
  });

  it('delete送信中にenqueueされたrecreateをACK完了時に保持する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'race-local-id', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    let resolveDelete!: (result: OfflineCommandResult) => void;
    execute
      .mockImplementationOnce(() => new Promise<OfflineCommandResult>((resolve) => (resolveDelete = resolve)))
      .mockResolvedValueOnce({ remoteId: 43, confirmedValues: { name: 'recreated' }, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'race-local-id' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'race-local-id' },
        operation: 'documents.create',
        payload: {},
      },
      { flush: false },
    );
    resolveDelete({ removeReplica: true, clearRemoteId: true, response: null });
    await flush;

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'generated', localId: 'race-local-id', remoteId: 42 },
      { kind: 'generated', localId: 'race-local-id', remoteId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: 'race-local-id', remoteId: 43 },
        values: expect.objectContaining({ name: 'confirmed' }),
        syncState: 'pending',
      }),
    ]);
    expectAwaitingPull(2);
  });

  it('serialized cache projectionはACK current read中に割り込まず解放後のrowを読む', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'serialized-cache-local-id', remoteId: 42 },
      values: { name: 'confirmed', presentation: 'pending' },
      confirmedValues: { name: 'confirmed', presentation: 'pending' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    let resolveDelete!: (result: OfflineCommandResult) => void;
    let releaseAckRead!: () => void;
    const ackReadGate = new Promise<void>((resolve) => (releaseAckRead = resolve));
    const ackReadStarted = vi.fn();
    execute
      .mockImplementationOnce(() => new Promise<OfflineCommandResult>((resolve) => (resolveDelete = resolve)))
      .mockResolvedValueOnce({ remoteId: 43, confirmedValues: { name: 'recreated', presentation: null }, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'serialized-cache-local-id' },
        operation: 'documents.delete',
        payload: { presentation: 'pending' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'serialized-cache-local-id' },
        operation: 'documents.create',
        payload: { presentation: 'pending' },
      },
      { flush: false },
    );
    beforeGetReplicaRow = async () => {
      ackReadStarted();
      await ackReadGate;
    };
    resolveDelete({ removeReplica: true, clearRemoteId: true, response: null });
    await vi.waitFor(() => expect(ackReadStarted).toHaveBeenCalledOnce());

    const cacheProjection = service.runSerializedReplicaMutation(async (repository) => {
      const current = await repository.getReplicaRowIncludingPendingDelete!({ userId: 1, scopeId: '10' }, 'documents', {
        kind: 'generated',
        localId: 'serialized-cache-local-id',
      });
      expect(current).toMatchObject({
        identity: { kind: 'generated', remoteId: null },
        values: { name: 'confirmed', presentation: 'pending' },
      });
      await repository.transactReplica({
        putRows: [{ ...current!, values: { name: 'recreated', presentation: null } }],
      });
    });
    releaseAckRead();
    await Promise.all([flush, cacheProjection]);

    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: 'serialized-cache-local-id', remoteId: 43 },
        values: expect.objectContaining({ name: 'confirmed', presentation: 'pending' }),
        syncState: 'pending',
      }),
    ]);
    expectAwaitingPull(2);
  });

  it('delete ACK後のstale remoteIdHintは採用せずrecreateをremoteId nullから開始する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'complete-first-local-id', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    execute
      .mockResolvedValueOnce({ removeReplica: true, clearRemoteId: true, response: null })
      .mockResolvedValueOnce({ remoteId: 43, confirmedValues: { name: 'recreated' }, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'complete-first-local-id' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({
      identity: { kind: 'generated', localId: 'complete-first-local-id', remoteId: null },
      visibility: 'pending_delete',
    });
    expectAwaitingPull(1);

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'complete-first-local-id', remoteIdHint: 42 },
        operation: 'documents.create',
        payload: {},
      },
      { flush: false },
    );
    await service.flush();

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'generated', localId: 'complete-first-local-id', remoteId: 42 },
      { kind: 'generated', localId: 'complete-first-local-id', remoteId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: 'complete-first-local-id', remoteId: 43 },
        values: expect.objectContaining({ name: 'confirmed' }),
        syncState: 'pending',
      }),
    ]);
    expectAwaitingPull(2);
  });

  it('TEXT remoteIdのdelete ACK後recreateを同じlocalId・remoteId nullで送り新UUIDへ収束する', async () => {
    options.replicaSchema = textReplicaSchema;
    const localId = 'text-recreate-local';
    const oldRemoteId = '018f6f6e-74ad-7cc4-b94f-4af0b13c4401';
    const newRemoteId = '018f6f6e-74ad-7cc4-b94f-4af0b13c4402';
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'text_documents',
      identity: { kind: 'generated', localId, remoteId: oldRemoteId },
      values: { id: oldRemoteId, title: 'old' },
      confirmedValues: { id: oldRemoteId, title: 'old' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'text_documents',
        identity: { kind: 'generated', localId },
        operation: 'text_documents.delete',
        payload: { title: 'old' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'text_documents',
        identity: { kind: 'generated', localId },
        operation: 'text_documents.create',
        payload: { title: 'new' },
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, clearRemoteId: true, response: null }).mockResolvedValueOnce({
      remoteId: newRemoteId,
      confirmedValues: { id: newRemoteId, title: 'new' },
      response: null,
    });
    connected.set(true);

    await service.flush();

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'generated', localId, remoteId: oldRemoteId },
      { kind: 'generated', localId, remoteId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId, remoteId: newRemoteId },
        values: { id: newRemoteId, title: 'new' },
        syncState: 'pending',
      }),
    ]);
    expectAwaitingPull(2);
  });

  it('clearRemoteIdはconfirmed delete以外では拒否する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'invalid-clear', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'invalid-clear' },
        operation: 'documents.update',
        payload: {},
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ clearRemoteId: true, response: null });
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline command can clear remoteId only for a confirmed replica removal.');
  });

  it('clearRemoteIdとserverRevisionの同時返却は後続commandをrebaseせず拒否する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'invalid-clear-revision', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'invalid-clear-revision' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'invalid-clear-revision' },
        operation: 'documents.create',
        payload: {},
      },
      { flush: false },
    );
    const followingPayload = JSON.stringify(commands[1]?.payload);
    execute.mockResolvedValueOnce({
      removeReplica: true,
      clearRemoteId: true,
      serverRevision: 5,
      response: null,
    });
    connected.set(true);

    await expect(service.flush()).rejects.toThrow('Offline command cannot return serverRevision and clearRemoteId together.');
    expect(commands[1]).toMatchObject({ baseRevision: 4 });
    expect(JSON.stringify(commands[1]?.payload)).toBe(followingPayload);
  });

  it('pending deleteのdiscardはconfirmed baselineとpresent visibilityを復元する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-delete-discard', remoteId: 38142 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed baseline' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-delete-discard' },
        operation: 'documents.delete',
        payload: { id: 38142 },
        baseRevision: 4,
        replicaMutation: 'delete',
      },
      { flush: false },
    );

    await service.discard(commandId, { flush: false });
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: '019d-delete-discard', remoteId: 38142 },
        values: { name: 'confirmed baseline' },
        confirmedValues: { name: 'confirmed baseline' },
        visibility: 'present',
        syncState: 'confirmed',
      }),
    ]);
    expect(commands).toEqual([]);
  });

  it('delete ACKはremoteId/naturalKeyのidentity変更をhard failする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'delete-server-id', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'delete-server-id' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, remoteId: 43, response: null });
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline replica remote id is immutable: current=42, incoming=43.');

    commands = [];
    rows = [
      {
        userId: 1,
        scopeId: '10',
        sourceKey: 'natural_documents',
        identity: { kind: 'natural', naturalKey: { favFrom: 7, favTo: '42' } },
        values: { favFrom: 7, favTo: '42', title: 'confirmed' },
        confirmedValues: { favFrom: 7, favTo: '42', title: 'confirmed' },
        serverRevision: 4,
        fetchedAt: 1,
        syncState: 'confirmed',
        visibility: 'present',
      },
    ];
    options.replicaSchema = naturalReplicaSchema;
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'natural_documents',
        identity: { kind: 'natural', naturalKey: { favFrom: 7, favTo: '42' } },
        operation: 'natural_documents.delete',
        payload: { favTo: '42', title: 'confirmed' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, confirmedValues: { favFrom: 7, favTo: '43', title: 'wrong' }, response: null });
    await expect(service.flush()).rejects.toThrow('Offline replica naturalKey is immutable for "natural_documents".');
  });

  it('superseded delete ACKの後に後続commandをdiscardしても旧confirmed baselineを復活させない', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: 'delete-then-upsert', remoteId: 42 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'old confirmed baseline' },
      serverRevision: 4,
      fetchedAt: 1,
      syncState: 'confirmed',
      visibility: 'present',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'delete-then-upsert' },
        operation: 'documents.delete',
        payload: {},
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    const followingId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'delete-then-upsert' },
        operation: 'documents.update',
        payload: {},
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, response: null });
    execute.mockRejectedValueOnce({ status: 422 });
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({
      confirmedValues: { name: 'old confirmed baseline' },
      visibility: 'present',
    });

    await service.discard(followingId, { flush: false });
    expect(rows[0]).toMatchObject({
      confirmedValues: { name: 'old confirmed baseline' },
      visibility: 'pending_delete',
    });
    expect(commands).toEqual([expect.objectContaining({ replicaMutation: 'delete', state: 'awaiting_pull' })]);
  });

  it('tombstone read APIを持たないcustom repositoryではdelete enqueueを明示rejectする', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository & { getReplicaRowIncludingPendingDelete?: unknown };
    const getReplicaRowIncludingPendingDelete = repository.getReplicaRowIncludingPendingDelete;
    delete repository.getReplicaRowIncludingPendingDelete;
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'missing-tombstone-api' },
          operation: 'documents.delete',
          payload: {},
          replicaMutation: 'delete',
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline repository does not support durable replica delete tombstones.');
    repository.getReplicaRowIncludingPendingDelete = getReplicaRowIncludingPendingDelete;
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it.each([0, -1, 1.5])('enqueue時の不正remoteId %sは永続化前にrejectする', async (remoteId) => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '019d-invalid', remoteId },
          operation: 'documents.update',
          payload: {},
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline replica generated remote id must be a positive integer.');
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('別localIdへ既存remoteIdを割り当てようとするとrejectする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-existing', remoteId: 38142 },
      values: {},
      confirmedValues: {},
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '019d-new', remoteId: 38142 },
          operation: 'documents.update',
          payload: {},
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline replica remote id 38142 is already mapped to another row.');
    expect(commands).toEqual([]);
  });

  it('同一localIdへのremoteId再指定は許容する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      identity: { kind: 'generated', localId: '019d-same', remoteId: 38142 },
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-same', remoteId: 38142 },
        operation: 'documents.update',
        payload: { name: 'draft' },
        baseRevision: 1,
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({ identity: { kind: 'generated', localId: '019d-same', remoteId: 38142 }, syncState: 'pending' });
    expect(commands).toHaveLength(1);
  });

  it('採用済み未確定rowはdiscardでoutboxとreplica rowを同時に除く', async () => {
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-adopted', remoteId: 38142 },
        operation: 'documents.update',
        payload: { name: 'adopted' },
      },
      { flush: false },
    );
    await service.discard(commandId, { flush: false });
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('採用済み未確定rowはdiscardAllでoutboxとreplica rowを同時に除く', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-adopted', remoteId: 38142 },
        operation: 'documents.update',
        payload: { name: 'adopted' },
      },
      { flush: false },
    );
    await service.discardAllPending();
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('invalid serverRevisionはhard failする', async () => {
    execute.mockResolvedValueOnce({ serverRevision: Number.NaN, confirmedValues: {}, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline command returned invalid serverRevision NaN.');
  });

  describe('user-scoped cross-partition aggregate fixes', () => {
    const userReplicaSchema = defineOfflineReplicaSchema({
      version: 1,
      entities: [
        defineReplicaEntity<{ id: number; title: string }>()({
          table: 'test_items',
          sourceKey: 'test_items',
          scope: 'user',
          fields: {
            id: generatedId('integer'),
            title: text(),
          },
        }),
        defineReplicaEntity<{ id: number; name: string }>()({
          table: 'test_group_items',
          sourceKey: 'test_group_items',
          scope: 'partition',
          fields: {
            id: generatedId('integer'),
            name: text(),
          },
        }),
        defineReplicaEntity<{ title: string }>()({
          table: 'test_views',
          sourceKey: 'test_views',
          scope: 'user',
          identity: localOnly(),
          fields: { title: text() },
        }),
      ],
      migrations: [],
    });
    const multiScopeSession = {
      userId: 1,
      scopes: [
        { userId: 1, scopeId: '10' },
        { userId: 1, scopeId: '11' },
      ] as OfflineScope[],
    };
    const userScopedSourceKeys = new Set(['test_items', 'test_views']);

    function compareCommands(left: OfflineCommand, right: OfflineCommand): number {
      return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
    }

    function findReplicaRow(scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress): OfflineReplicaRow | undefined {
      return rows.find((item) => {
        if (item.userId !== scope.userId || item.sourceKey !== sourceKey) return false;
        if (identity.kind === 'natural' || item.identity.kind === 'natural' || item.identity.localId !== identity.localId) {
          return false;
        }
        return userScopedSourceKeys.has(sourceKey) ? true : item.scopeId === scope.scopeId;
      });
    }

    function projectReplicaRow(row: OfflineReplicaRow, scope: OfflineScope): OfflineReplicaRow {
      return userScopedSourceKeys.has(row.sourceKey) ? { ...row, scopeId: scope.scopeId } : row;
    }

    beforeEach(() => {
      TestBed.resetTestingModule();
      commands = [];
      rows = [];
      pullAttentions = [];
      connected = signal(false);
      session = multiScopeSession;
      beforePutCommand = null;
      pull = vi.fn(async () => undefined);
      handleError = vi.fn();
      execute.mockReset();
      execute.mockResolvedValue({ response: null });
      const repository = {
        initialize: vi.fn(async () => undefined),
        getCommands: vi.fn(async (scope: OfflineScope) =>
          commands.filter((item) => item.userId === scope.userId && item.scopeId === scope.scopeId).sort(compareCommands),
        ),
        getCommandsForUser: vi.fn(async (userId: number) => commands.filter((item) => item.userId === userId).sort(compareCommands)),
        putCommand: vi.fn(async (command: OfflineCommand) => {
          await beforePutCommand?.(command);
          commands = commands.filter((item) => item.commandId !== command.commandId);
          commands.push(structuredClone(command));
          commands.sort(compareCommands);
        }),
        replaceCommand: vi.fn(async (command: OfflineCommand) => {
          commands = commands.filter((item) => item.commandId !== command.commandId);
          commands.push(structuredClone(command));
          commands.sort(compareCommands);
        }),
        removeCommand: vi.fn(async (commandId: string) => {
          commands = commands.filter((item) => item.commandId !== commandId);
        }),
        getReplicaRow: vi.fn(async (scope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) => {
          const row = findReplicaRow(scope, sourceKey, identity);
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaRowByRemoteId: vi.fn(async (scope: OfflineScope, sourceKey: string, remoteId: number) => {
          const row = rows.find((item) => {
            if (
              item.userId !== scope.userId ||
              item.sourceKey !== sourceKey ||
              item.identity.kind !== 'generated' ||
              item.identity.remoteId !== remoteId
            )
              return false;
            return userScopedSourceKeys.has(sourceKey) ? true : item.scopeId === scope.scopeId;
          });
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaRowByRemoteIdentity: vi.fn(async (scope: OfflineScope, sourceKey: string, identity) => {
          if (identity.remoteId === undefined) throw new Error(`Natural identity is unsupported by this test repository.`);
          const row = rows.find((item) => {
            if (
              item.userId !== scope.userId ||
              item.sourceKey !== sourceKey ||
              item.identity.kind !== 'generated' ||
              item.identity.remoteId !== identity.remoteId
            )
              return false;
            return userScopedSourceKeys.has(sourceKey) ? true : item.scopeId === scope.scopeId;
          });
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaCursor: vi.fn(async () => null),
        getPullAttentions: vi.fn(async (userId: number) =>
          pullAttentions.filter((attention) => attention.userId === userId).map((attention) => structuredClone(attention)),
        ),
        transactReplica: vi.fn(async (transaction) => {
          for (const row of transaction.putRows ?? []) {
            const existing = findReplicaRow(row, row.sourceKey, row.identity);
            rows = rows.filter(
              (item) =>
                item.userId !== row.userId ||
                item.sourceKey !== row.sourceKey ||
                canonicalOfflineReplicaIdentity(item.identity) !== canonicalOfflineReplicaIdentity(row.identity) ||
                (!userScopedSourceKeys.has(row.sourceKey) && item.scopeId !== row.scopeId),
            );
            rows.push(structuredClone(existing ? { ...existing, ...row } : row));
          }
          for (const key of transaction.removeRows ?? []) {
            rows = rows.filter(
              (item) =>
                item.userId !== key.userId ||
                item.sourceKey !== key.sourceKey ||
                canonicalOfflineReplicaIdentity(item.identity) !== canonicalOfflineReplicaIdentity(key.identity) ||
                (!userScopedSourceKeys.has(key.sourceKey) && item.scopeId !== key.scopeId),
            );
          }
          for (const command of transaction.putCommands ?? []) {
            commands = commands.filter((item) => item.commandId !== command.commandId);
            commands.push(structuredClone(command));
          }
          commands = commands.filter((command) => !(transaction.removeCommandIds ?? []).includes(command.commandId));
          for (const attention of transaction.putPullAttentions ?? []) {
            pullAttentions = pullAttentions.filter(
              (candidate) => candidate.userId !== attention.userId || candidate.scopeId !== attention.scopeId,
            );
            pullAttentions.push(structuredClone(attention));
          }
          for (const scope of transaction.removePullAttentions ?? []) {
            pullAttentions = pullAttentions.filter((candidate) => candidate.userId !== scope.userId || candidate.scopeId !== scope.scopeId);
          }
          commands.sort(compareCommands);
        }),
      } as unknown as OfflineRepository;
      TestBed.configureTestingModule({
        providers: [
          OfflineSyncService,
          { provide: OFFLINE_REPOSITORY, useValue: repository },
          { provide: OfflineNetworkService, useValue: { connected } },
          {
            provide: OFFLINE_KIT_OPTIONS,
            useValue: { databaseName: 'test-offline', databaseEncryption: false, replicaSchema: userReplicaSchema },
          },
          { provide: OfflineReplicaPullService, useValue: { pull } },
          { provide: ErrorHandler, useValue: { handleError } },
          {
            provide: OFFLINE_SYNC_CONTEXT,
            useValue: { getSession: vi.fn(async () => session) },
          },
          {
            provide: OFFLINE_COMMAND_EXECUTOR,
            useValue: {
              execute,
            },
          },
          { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project: rematerializeTestAggregate } },
          { provide: OFFLINE_RETRY_RANDOM, useValue: () => 0.5 },
        ],
      });
      service = TestBed.inject(OfflineSyncService);
      rows.push({
        userId: 1,
        scopeId: '10',
        sourceKey: 'test_items',
        identity: { kind: 'generated', localId: '019d-user-item', remoteId: 42 },
        values: { id: 42, title: 'Baseline' },
        confirmedValues: { id: 42, title: 'Baseline' },
        serverRevision: 1,
        fetchedAt: 1,
        syncState: 'confirmed',
      });
    });

    it('同一user rowの別partition commandは1 aggregateに直列化し、先頭完了後に後続をrebaseする', async () => {
      let resolveFirst!: (value: OfflineCommandResult) => void;
      let resolveSecond!: (value: OfflineCommandResult) => void;
      execute
        .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
        .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'G10 edit' },
          baseRevision: 1,
        },
        { flush: false },
      );
      const secondId = await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'G11 edit' },
          baseRevision: 1,
        },
        { flush: false },
      );
      connected.set(true);
      const flush = service.flush();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      resolveFirst({ serverRevision: 2, confirmedValues: { id: 42, title: 'G10 edit' }, response: null });
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      expect(execute.mock.calls[1]?.[0]).toMatchObject({
        commandId: secondId,
        baseRevision: 2,
      });
      expect(JSON.stringify((execute.mock.calls[1]?.[0] as OfflineCommand).payload)).toBe(JSON.stringify({ title: 'G11 edit' }));
      expect(
        findReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', {
          kind: 'generated',
          localId: '019d-user-item',
        }),
      ).toMatchObject({
        values: { title: 'G11 edit' },
        confirmedValues: { title: 'Baseline' },
        serverRevision: 2,
        syncState: 'pending',
      });
      resolveSecond({ serverRevision: 3, confirmedValues: { id: 42, title: 'G11 edit' }, response: null });
      await flush;
      expect(execute.mock.calls.map(([command]) => (command as OfflineCommand<{ title: string }>).payload)).toEqual([
        { title: 'G10 edit' },
        { title: 'G11 edit' },
      ]);
      expectAwaitingPull(2);
    });

    it('pre-pull: head scope成功/後続scope失敗の同一user-scoped aggregateは成功prefixだけ送る', async () => {
      const scope11Error = new Error('scope 11 pre-pull failed');
      pull.mockImplementation(async (scope) => {
        if (scope.scopeId === '11') throw scope11Error;
      });
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'A' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'B' },
          baseRevision: 1,
        },
        { flush: false },
      );

      connected.set(true);
      await expect(service.flush()).rejects.toBe(scope11Error);

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ scopeId: '10', payload: { title: 'A' } });
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({ scopeId: '10', state: 'awaiting_pull' });
      expect(commands[1]).toMatchObject({ scopeId: '11', state: 'pending' });
      expect(rows.find((row) => row.sourceKey === 'test_items')?.values).toEqual(expect.objectContaining({ title: 'B' }));
    });

    it('pre-pull: head scope失敗/後続scope成功の同一user-scoped aggregateは一切送らない', async () => {
      const scope10Error = new Error('scope 10 pre-pull failed');
      pull.mockImplementation(async (scope) => {
        if (scope.scopeId === '10') throw scope10Error;
      });
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'A' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'B' },
          baseRevision: 1,
        },
        { flush: false },
      );

      connected.set(true);
      await expect(service.flush()).rejects.toBe(scope10Error);

      expect(execute).not.toHaveBeenCalled();
      expect(commands.map((command) => command.scopeId)).toEqual(['10', '11']);
    });

    it('pre-pull: 成功prefix送信後、両scope成功の次flushは残りのBだけ送る', async () => {
      const scope11Error = new Error('scope 11 pre-pull failed once');
      pull.mockImplementation(async (scope) => {
        if (scope.scopeId === '11') throw scope11Error;
      });
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'A' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'B' },
          baseRevision: 1,
        },
        { flush: false },
      );

      connected.set(true);
      await expect(service.flush()).rejects.toBe(scope11Error);
      expect(execute).toHaveBeenCalledOnce();
      expect(commands).toHaveLength(2);
      expect(commands.find((command) => command.scopeId === '10')).toMatchObject({ state: 'awaiting_pull' });
      expect(commands.find((command) => command.scopeId === '11')).toMatchObject({ state: 'pending', payload: { title: 'B' } });

      pull.mockResolvedValue(undefined);
      execute.mockClear();
      await service.flush();

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toMatchObject({ scopeId: '11', payload: { title: 'B' } });
      expectAwaitingPull(2);
    });

    it('pre-pull: user-scoped aggregateでもfatalは成功scopeを送らず残りscopeを止める', async () => {
      const fatal = new OfflineReplicaSchemaMismatchError(1, 'abc', 2, 'def');
      pull.mockImplementation(async (scope) => {
        if (scope.scopeId === '10') throw fatal;
      });
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'B' },
          baseRevision: 1,
        },
        { flush: false },
      );

      connected.set(true);
      await expect(service.flush()).rejects.toBe(fatal);
      expect(execute).not.toHaveBeenCalled();
      expect(pull.mock.calls.map((call) => call[0]?.scopeId)).toEqual(['10']);
    });

    it('cross-partition commandの一方discardでも他方のoptimistic valueを保持する', async () => {
      const firstId = await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'G10 edit' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'G11 edit' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.discard(firstId, { flush: false });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ scopeId: '11' });
      expect(
        findReplicaRow({ userId: 1, scopeId: '11' }, 'test_items', {
          kind: 'generated',
          localId: '019d-user-item',
        }),
      ).toMatchObject({
        values: { title: 'G11 edit' },
        confirmedValues: { title: 'Baseline' },
        syncState: 'pending',
      });
    });

    it('multi-scope batchは同じuser-scoped companionのscope alias重複をcommit前に拒否する', async () => {
      const repository = TestBed.inject(OFFLINE_REPOSITORY);
      const transactReplica = vi.mocked(repository.transactReplica);
      const companion = (scopeId: string, title: string): OfflineReplicaRow => ({
        userId: 1,
        scopeId,
        sourceKey: 'test_views',
        identity: { kind: 'local', localId: 'shared-view' },
        values: { title },
        confirmedValues: { title: 'Baseline' },
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      });

      await expect(
        service.enqueuePreparedBatch(
          async () => [
            {
              request: {
                scopeId: '10',
                aggregateType: 'test_items',
                identity: { kind: 'generated', localId: 'batch-scope-10' },
                operation: 'test_items.create',
                payload: { title: 'A' },
                localOnlyFootprint: [companion('10', 'A')],
              },
            },
            {
              request: {
                scopeId: '11',
                aggregateType: 'test_items',
                identity: { kind: 'generated', localId: 'batch-scope-11' },
                operation: 'test_items.create',
                payload: { title: 'B' },
                localOnlyFootprint: [companion('11', 'B')],
              },
            },
          ],
          { flush: false },
        ),
      ).rejects.toThrow('overlapping replica footprints');

      expect(transactReplica).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      expect(rows).toHaveLength(1);
    });

    it('別aggregateの後続enqueueもuser-scoped companionのscope alias共有を拒否する', async () => {
      const companion = (scopeId: string, title: string): OfflineReplicaRow => ({
        userId: 1,
        scopeId,
        sourceKey: 'test_views',
        identity: { kind: 'local', localId: 'shared-view' },
        values: { title },
        confirmedValues: { title: 'Baseline' },
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      });
      const firstId = await service.enqueuePrepared(
        async () => ({
          request: {
            scopeId: '10',
            aggregateType: 'test_items',
            identity: { kind: 'generated', localId: 'scope-10-item' },
            operation: 'test_items.create',
            payload: { title: 'A' },
            localOnlyFootprint: [companion('10', 'A')],
          },
        }),
        { flush: false },
      );

      await expect(
        service.enqueuePrepared(
          async () => ({
            request: {
              scopeId: '11',
              aggregateType: 'test_items',
              identity: { kind: 'generated', localId: 'scope-11-item' },
              operation: 'test_items.create',
              payload: { title: 'B' },
              localOnlyFootprint: [companion('11', 'B')],
            },
          }),
          { flush: false },
        ),
      ).rejects.toThrow('different aggregates cannot share a replica footprint');

      expect(commands).toHaveLength(1);
      await service.discard(firstId, { flush: false });
      expect(commands).toEqual([]);
      expect(findReplicaRow({ userId: 1, scopeId: '11' }, 'test_views', { kind: 'local', localId: 'shared-view' })).toBeUndefined();
    });

    it('partition-scopedの同一localIdはpartitionごとに独立aggregateのまま並列送信する', async () => {
      let resolveFirst!: (value: OfflineCommandResult) => void;
      execute.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
      execute.mockResolvedValueOnce({ serverRevision: 2, confirmedValues: { id: 55, name: 'G11 name' }, response: null });
      rows.push({
        userId: 1,
        scopeId: '11',
        sourceKey: 'test_group_items',
        identity: { kind: 'generated', localId: '019d-group-same', remoteId: 55 },
        values: { id: 55, name: 'G11 baseline' },
        confirmedValues: { id: 55, name: 'G11 baseline' },
        serverRevision: 1,
        fetchedAt: 1,
        syncState: 'confirmed',
      });
      rows.push({
        userId: 1,
        scopeId: '10',
        sourceKey: 'test_group_items',
        identity: { kind: 'generated', localId: '019d-group-same', remoteId: 56 },
        values: { id: 56, name: 'G10 baseline' },
        confirmedValues: { id: 56, name: 'G10 baseline' },
        serverRevision: 1,
        fetchedAt: 1,
        syncState: 'confirmed',
      });
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_group_items',
          identity: { kind: 'generated', localId: '019d-group-same' },
          operation: 'test_group_items.update',
          payload: { name: 'G10 name' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.enqueue(
        {
          scopeId: '11',
          aggregateType: 'test_group_items',
          identity: { kind: 'generated', localId: '019d-group-same' },
          operation: 'test_group_items.update',
          payload: { name: 'G11 name' },
          baseRevision: 1,
        },
        { flush: false },
      );
      connected.set(true);
      const flush = service.flush();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
      resolveFirst({ serverRevision: 2, confirmedValues: { id: 56, name: 'G10 name' }, response: null });
      await flush;
      expect(execute.mock.calls.map(([command]) => command.scopeId).sort()).toEqual(['10', '11']);
      expectAwaitingPull(2);
    });
  });

  describe('lazy foreground pull', () => {
    beforeEach(() => {
      session = {
        userId: 1,
        scopes: [
          { userId: 1, scopeId: '10' },
          { userId: 1, scopeId: '20' },
          { userId: 1, scopeId: '30' },
        ],
      };
      connected.set(true);
    });

    it('pulls foreground scopes immediately while clean non-foreground scopes wait', async () => {
      await service.refreshSession(['10']);

      await vi.waitFor(() => expect(pull).toHaveBeenCalled());
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('pulls non-foreground scopes immediately when they contain durable Outbox commands', async () => {
      await service.enqueue(
        {
          scopeId: '30',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'outbox-scope' },
          operation: 'documents.create',
          payload: { title: 'queued' },
        },
        { flush: false },
      );
      pull.mockClear();

      await service.refreshSession(['10']);

      await vi.waitFor(() => expect(pull.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
    });

    it('pulls every durable attention scope during partial recovery and clears recovered attentions', async () => {
      pullAttentions = [
        { userId: 1, scopeId: '10', reason: 'authorization_required', status: 401 },
        { userId: 1, scopeId: '20', reason: 'authorization_required', status: 401 },
      ];

      await service.refreshSession(['10']);

      await vi.waitFor(() => expect(pull.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
      await vi.waitFor(() => expect(service.pullAttentions()).toEqual([]));
    });

    it('prunes durable attentions for scopes removed from the active session', async () => {
      pullAttentions = [
        { userId: 1, scopeId: '10', reason: 'authorization_required', status: 403 },
        { userId: 1, scopeId: '99', reason: 'authorization_required', status: 403 },
      ];

      await service.refreshSession(['10']);

      await vi.waitFor(() =>
        expect(service.pullAttentions()).toEqual([{ userId: 1, scopeId: '10', reason: 'authorization_required', status: 403 }]),
      );
      expect(pullAttentions.some((attention) => attention.scopeId === '99')).toBe(false);
    });

    it('reconnect automatic flush respects foreground policy', async () => {
      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('explicit flush later pulls all remaining scopes sequentially', async () => {
      const pullOrder: string[] = [];
      pull.mockImplementation(async (scope: OfflineScope) => {
        pullOrder.push(scope.scopeId);
      });

      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull.mock.calls.length).toBeGreaterThan(0));
      expect(pullOrder.every((scopeId) => scopeId === '10')).toBe(true);
      pullOrder.length = 0;

      await service.flush();

      expect(pullOrder).toEqual(['10', '20', '30']);
    });

    it('chains explicit flush after an in-flight partial flush', async () => {
      let releaseForegroundPull: (() => void) | undefined;
      const foregroundPullGate = new Promise<void>((resolve) => {
        releaseForegroundPull = resolve;
      });
      pull.mockImplementation(async (scope: OfflineScope) => {
        if (scope.scopeId === '10') await foregroundPullGate;
      });

      void service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));

      const fullFlush = service.flush();
      releaseForegroundPull?.();
      await fullFlush;

      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('reset prevents stale chained full flush from full-pulling replacement session scopes', async () => {
      let releaseForegroundPull: (() => void) | undefined;
      const foregroundPullGate = new Promise<void>((resolve) => {
        releaseForegroundPull = resolve;
      });
      const pulledScopeIds: string[] = [];
      pull.mockImplementation(async (scope: OfflineScope) => {
        pulledScopeIds.push(`${scope.userId}:${scope.scopeId}`);
        if (scope.scopeId === '10') await foregroundPullGate;
      });

      void service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));

      const staleFullFlush = service.flush();
      const reset = service.resetSession();
      session = {
        userId: 2,
        scopes: [
          { userId: 2, scopeId: '10' },
          { userId: 2, scopeId: '20' },
          { userId: 2, scopeId: '30' },
        ],
      };
      void service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 2, scopeId: '10' }));
      pulledScopeIds.length = 0;
      pull.mockClear();

      releaseForegroundPull?.();
      await staleFullFlush;
      await reset;

      expect(pulledScopeIds).toEqual([]);
      expect(pull).not.toHaveBeenCalledWith({ userId: 2, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 2, scopeId: '30' });
    });

    it('retryNow preserves foreground policy so reconnect automatic flush stays partial', async () => {
      execute.mockRejectedValueOnce({ status: 500 }).mockResolvedValueOnce({ response: null });
      const commandId = await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'retry-foreground-policy' },
          operation: 'documents.create',
          payload: { title: 'queued' },
        },
        { flush: false },
      );

      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      await vi.waitFor(() => expect(service.pendingCommands()[0]?.state).toBe('retry_wait'));
      pull.mockClear();

      await service.retryNow(commandId);
      expect(execute).toHaveBeenCalledTimes(2);
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('discard preserves foreground policy so reconnect automatic flush stays partial', async () => {
      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

      const commandId = await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'discard-foreground-policy' },
          operation: 'documents.create',
          payload: { title: 'queued' },
        },
        { flush: false },
      );
      await service.discard(commandId, { flush: false });
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('discardAllPending preserves foreground policy so reconnect automatic flush stays partial', async () => {
      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'discard-all-foreground-policy' },
          operation: 'documents.create',
          payload: { title: 'queued' },
        },
        { flush: false },
      );
      await service.discardAllPending();
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('revokeSession clears foreground policy so reconnect automatic flush pulls all scopes', async () => {
      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

      service.revokeSession();
      await service.refreshSession();
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull.mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('queued explicit flush retries full pull after partial failure and remains chainable', async () => {
      const partialError = new Error('partial foreground pull failed');
      let releaseForegroundPull!: () => void;
      const foregroundPullGate = new Promise<void>((resolve) => {
        releaseForegroundPull = resolve;
      });
      let scope10PullCount = 0;
      pull.mockImplementation(async (scope: OfflineScope) => {
        if (scope.scopeId === '10') {
          scope10PullCount += 1;
          if (scope10PullCount === 1) {
            await foregroundPullGate;
            throw partialError;
          }
        }
      });

      void service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));

      const fullFlush = service.flush();
      releaseForegroundPull();

      await expect(fullFlush).resolves.toBeUndefined();
      await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(partialError));
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '30' });

      pull.mockClear();
      scope10PullCount = 0;
      handleError.mockClear();
      let releaseSecondPartialPull!: () => void;
      const secondPartialGate = new Promise<void>((resolve) => {
        releaseSecondPartialPull = resolve;
      });
      pull.mockImplementation(async (scope: OfflineScope) => {
        if (scope.scopeId === '10') {
          scope10PullCount += 1;
          if (scope10PullCount === 1) {
            await secondPartialGate;
            throw partialError;
          }
        }
      });

      connected.set(false);
      connected.set(true);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));

      const secondFullFlush = service.flush();
      releaseSecondPartialPull();

      await expect(secondFullFlush).resolves.toBeUndefined();
      await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(partialError));
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });
  });
});
