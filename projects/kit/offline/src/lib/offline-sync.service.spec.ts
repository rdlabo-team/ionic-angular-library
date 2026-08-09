import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_COMMAND_EXECUTOR,
  OFFLINE_SYNC_CONTEXT,
  type OfflineCommandResult,
  type OfflineCommandTarget,
} from './offline-command-executor';
import { OFFLINE_KIT_OPTIONS, type OfflineKitOptions } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineReplicaPullService } from './offline-replica-pull.service';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import { defineOfflineReplicaSchema, defineReplicaEntity, integer, naturalKey, generatedId, text } from './offline-replica-schema';
import {
  canonicalOfflineReplicaIdentity,
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineCommandIdentity,
  type OfflineReplicaAddress,
  type OfflineReplicaRow,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { generatedCommandIdentity } from './offline-test-helpers';
import { OfflinePayloadValidationError, OfflineSyncService } from './offline-sync.service';

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

describe('OfflineSyncService', () => {
  let service: OfflineSyncService;
  let commands: OfflineCommand[];
  let rows: OfflineReplicaRow[];
  let connected: ReturnType<typeof signal<boolean>>;
  let session: { userId: number; scopes: OfflineScope[] } | null;
  let localSession: { userId: number; scopes: OfflineScope[] } | null | undefined;
  let beforePutCommand: ((command: OfflineCommand) => Promise<void>) | null;
  let beforeGetCommands: (() => Promise<void>) | null;
  let beforeGetReplicaRow: (() => Promise<void>) | null;
  let pull: ReturnType<typeof vi.fn<(scope: OfflineScope) => Promise<void>>>;
  let handleError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  let options: OfflineKitOptions;
  const execute = vi.fn(
    async (_command: OfflineCommand, _target: OfflineCommandTarget): Promise<OfflineCommandResult> => ({ response: null }),
  );

  beforeEach(() => {
    commands = [];
    rows = [];
    connected = signal(false);
    session = { userId: 1, scopes: [{ userId: 1, scopeId: '10' }] };
    localSession = undefined;
    beforePutCommand = null;
    beforeGetCommands = null;
    beforeGetReplicaRow = null;
    pull = vi.fn(async () => undefined);
    handleError = vi.fn();
    options = { databaseName: 'test-offline', replicaSchema };
    execute.mockReset();
    execute.mockResolvedValue({ response: null });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async (scope: OfflineScope) => {
        await beforeGetCommands?.();
        return commands.filter((item) => item.userId === scope.userId && item.scopeId === scope.scopeId);
      }),
      getCommandsForUser: vi.fn(async (userId: number) => commands.filter((item) => item.userId === userId)),
      putCommand: vi.fn(async (command: OfflineCommand) => {
        await beforePutCommand?.(command);
        commands = commands.filter((item) => item.commandId !== command.commandId);
        commands.push(structuredClone(command));
        commands.sort((left, right) => left.createdAt - right.createdAt);
      }),
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
      transactReplica: vi.fn(async (transaction) => {
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
        commands.sort((left, right) => left.createdAt - right.createdAt);
      }),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [
        OfflineSyncService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: { connected } },
        { provide: OFFLINE_KIT_OPTIONS, useValue: options },
        { provide: OfflineReplicaPullService, useValue: { pull } },
        { provide: ErrorHandler, useValue: { handleError } },
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
            withServerRevision: (command: OfflineCommand) => command,
            withoutServerRevision: (command: OfflineCommand) => ({ ...command, baseRevision: null }),
          },
        },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
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
          optimisticValue: { id: 0, title: 'write' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('read-only cache');
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('prepared enqueue persists the base row, companion row, and Outbox command together', async () => {
    const companion: OfflineReplicaRow = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local', localId: 'view-1' },
      values: { title: 'Optimistic view' },
      confirmedValues: { title: 'Baseline view' },
      serverRevision: null,
      fetchedAt: 2,
      syncState: 'confirmed',
    };
    rows.push({ ...structuredClone(companion), values: { title: 'Baseline view' } });

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
            optimisticValue: { id: 0, title: 'Optimistic' },
          },
          replicaTransaction: { putRows: [companion] },
        };
      },
      { flush: false },
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: 'documents', values: { id: 0, title: 'Optimistic' } }),
        expect.objectContaining({ sourceKey: 'document_views', values: { title: 'Optimistic view' } }),
      ]),
    );
    expect(commands[0]?.optimisticCompanions).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ values: { title: 'Baseline view' } }),
        after: expect.objectContaining({ values: { title: 'Optimistic view' } }),
      }),
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

  it('prepared enqueue rejects duplicate or cross-scope companion rows before persistence', async () => {
    const base = {
      userId: 1,
      scopeId: '10',
      sourceKey: 'document_views',
      identity: { kind: 'local' as const, localId: 'duplicate' },
      values: {},
      confirmedValues: null,
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'confirmed' as const,
    };
    const request = {
      scopeId: '10',
      aggregateType: 'documents',
      identity: { kind: 'generated' as const, localId: 'prepared-invalid' },
      operation: 'documents.create',
      payload: {},
      optimisticValue: { id: 0, title: 'x' },
    };
    await expect(
      service.enqueuePrepared(async () => ({
        request,
        replicaTransaction: { putRows: [base, structuredClone(base)] },
      })),
    ).rejects.toThrow('duplicate replica row');
    await expect(
      service.enqueuePrepared(async () => ({
        request,
        replicaTransaction: { putRows: [{ ...base, scopeId: '11' }] },
      })),
    ).rejects.toThrow('must use the command scope');
    await expect(
      service.enqueuePrepared(async () => ({
        request,
        replicaTransaction: { putCommands: [] } as never,
      })),
    ).rejects.toThrow('cannot mutate putCommands');
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('discard restores a prepared companion before-image', async () => {
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
          payload: {},
          optimisticValue: { id: 0, title: 'Optimistic' },
        },
        replicaTransaction: { putRows: [{ ...before, values: { title: 'Optimistic' } }] },
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
            optimisticValue: { id: 1, title },
          },
          replicaTransaction: {
            putRows: [{ ...before, values: { title }, fetchedAt: index + 2 }],
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
    await Promise.resolve();
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
        optimisticValue: { id: 0, title: 'first' },
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
          optimisticValue: { id: 0, title: 'second' },
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
          optimisticValue: { id: 0, title: 'too large' },
        },
        { flush: false },
      ),
    ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'serialized_bytes' });
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
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
        optimisticValue: { id: 0, title: 'offline' },
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
        optimisticValue: { id: 0, title: 'queued offline' },
      },
      { flush: false },
    );
    expect(execute).not.toHaveBeenCalled();

    connected.set(true);

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(service.pendingCount()).toBe(0));
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
        optimisticValue: { id: 0, title: 'stale' },
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
        optimisticValue: { seq: 1 },
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
        optimisticValue: { seq: 2 },
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(execute.mock.calls.map(([command]) => (command as OfflineCommand<{ seq: number }>).payload.seq)).toEqual([1, 2]);
    expect(service.pendingCount()).toBe(0);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('送信成功後は同一scopeの複数aggregateを一度だけ再pullする', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'post-pull-1' },
        operation: 'documents.create',
        payload: { title: 'one' },
        optimisticValue: { id: 0, title: 'one' },
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
        optimisticValue: { id: 0, title: 'two' },
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
    expect(commands).toEqual([]);
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
        optimisticValue: { id: 0, title: 'optimistic projection' },
      },
      { flush: false },
    );

    connected.set(true);
    await service.flush();

    expect(commandCountsAtPull).toEqual([1, 0]);
    expect(rows).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ localId: 'snap-back', remoteId: 55 }),
        values: { id: 55, title: 'authoritative projection' },
        confirmedValues: { id: 55, title: 'authoritative projection' },
        serverRevision: 3,
        syncState: 'confirmed',
      }),
    );
    expect(service.pendingCount()).toBe(0);
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
        optimisticValue: { id: 0, title: 'one' },
      },
      { flush: false },
    );

    connected.set(true);
    await expect(service.flush()).rejects.toBe(postPullError);
    expect(commands).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();

    await service.flush();
    expect(execute).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledTimes(3);
    expect(service.pendingCount()).toBe(0);
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
        optimisticValue: { name: 'draft' },
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
      syncState: 'confirmed',
      confirmedValues: { name: 'draft' },
    });
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
        optimisticValue: { name: 'edited' },
        baseRevision: 1,
      },
      { flush: false },
    );
    await service.flush();
    expect(execute.mock.calls[1]?.[1]).toEqual({ kind: 'generated', localId: '019d-aaaa', remoteId: 38142 });
    expect(rows[0]).toMatchObject({
      identity: { kind: 'generated', localId: '019d-aaaa', remoteId: 38142 },
      serverRevision: 2,
      confirmedValues: { name: 'edited' },
    });
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
      optimisticValue: {},
      payloadHash: 'hash',
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
    expect(service.pendingCommands()[0]?.state).toBe('pending');
  });

  it('未同期createを破棄するとoutboxと未確定replica rowを同時に除く', async () => {
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '019d-new' },
        operation: 'documents.create',
        payload: { name: 'draft' },
        optimisticValue: { name: 'draft' },
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
        optimisticValue: { name: 'draft' },
        baseRevision: 4,
      },
      { flush: false },
    );
    expect(rows[0]?.values).toEqual({ name: 'draft' });
    await service.discard(commandId, { flush: false });
    expect(rows[0]).toMatchObject({
      values: { name: 'confirmed' },
      confirmedValues: { name: 'confirmed' },
      syncState: 'confirmed',
      identity: expect.objectContaining({ remoteId: 38142 }),
    });
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
        optimisticValue: { seq: 1 },
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
        optimisticValue: { seq: 2 },
      },
      { flush: false },
    );
    const createdAt = commands.map((command) => command.createdAt);
    expect(createdAt[0]).toBeLessThan(createdAt[1]!);
    expect(service.pendingCommands().map((command) => command.createdAt)).toEqual(createdAt);
    nowSpy.mockRestore();
  });

  it('locale非依存のkey順で同じJSON payloadを同一hashにする', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { あ: 3, z: 1, ä: 2 },
        optimisticValue: {},
      },
      { flush: false },
    );
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '2' },
        operation: 'documents.upsert',
        payload: { ä: 2, あ: 3, z: 1 },
        optimisticValue: {},
      },
      { flush: false },
    );
    expect(service.pendingCommands()[0]?.payloadHash).toBe(service.pendingCommands()[1]?.payloadHash);
  });

  it('JSON外payloadを衝突するhashへ変換せずrejectする', async () => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '1' },
          operation: 'documents.upsert',
          payload: { value: undefined },
          optimisticValue: {},
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
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state, lastErrorCode: String(status) });
    expect(rows[0]?.syncState).toBe(rowSyncState);
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
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'retry_wait', retryAt: expect.any(Number) });

    await service.retryNow(commandId);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.pendingCommands()).toEqual([]);
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
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state: 'blocked_auth', lastErrorCode: '401' });

    await service.retryNow(commandId);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(service.pendingCommands()).toEqual([]);
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
        optimisticValue: {},
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
        optimisticValue: { name: 'confirmed' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({ visibility: 'pending_delete' });
    expect(commands[0]).toMatchObject({ replicaMutation: 'delete', state });
  });

  it('flush中の一括discard後に旧commandを送信・復活させない', async () => {
    let resolveExecute!: (value: { response: null; serverRevision?: number }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: { seq: 1 },
        optimisticValue: { seq: 1 },
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
        optimisticValue: { seq: 2 },
      },
      { flush: false },
    );
    connected.set(true);
    const flush = service.flush();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await service.discardAllPending();
    resolveExecute({ response: null, serverRevision: 2 });
    await flush;
    expect(execute).toHaveBeenCalledOnce();
    expect(commands).toEqual([]);
    expect(service.pendingCount()).toBe(0);
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
        optimisticValue: { seq: 1 },
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
        optimisticValue: { seq: 2 },
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
        optimisticValue: { seq: 1 },
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
    expect(service.pendingCount()).toBe(0);
  });

  it('background flush failureはErrorHandlerへ渡し、await flushはrejectする', async () => {
    const pullError = new Error('pull failed');
    pull.mockRejectedValue(pullError);
    connected.set(true);
    await service.initialize();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(pullError));
    await expect(service.flush()).rejects.toThrow('pull failed');
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
        optimisticValue: { seq: 1 },
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
    expect(service.pendingCount()).toBe(0);
  });

  it('local replica row lookup failureはrejectしbackground flushはErrorHandlerへ渡す', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
        optimisticValue: {},
      },
      { flush: false },
    );
    vi.mocked(repository.getReplicaRow).mockResolvedValue(null);
    vi.mocked(repository.getReplicaRowIncludingPendingDelete!).mockResolvedValue(null);
    connected.set(true);
    await service.refreshSession();
    await vi.waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Offline replica row not found: documents/generated:1' }),
      ),
    );

    await service.refreshSession();
    await expect(service.flush()).rejects.toThrow('Offline replica row not found');
    expect(execute).not.toHaveBeenCalled();
  });

  it('transactReplica failureはrejectしbackground flushはErrorHandlerへ渡す', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository;
    const originalTransact = vi.mocked(repository.transactReplica).getMockImplementation()!;
    vi.mocked(repository.transactReplica).mockImplementation(async (transaction) => {
      if ((transaction.removeCommandIds?.length ?? 0) > 0) {
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
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await service.refreshSession();
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'transaction failed' })));

    await service.refreshSession();
    await expect(service.flush()).rejects.toThrow('transaction failed');
  });

  it('executor error without integer statusはclassifyせずrejectする', async () => {
    execute.mockRejectedValueOnce(new Error('programming failure'));
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('programming failure');
    expect(service.pendingCommands()[0]?.state).toBe('sending');
    expect(handleError).not.toHaveBeenCalled();
  });

  it('executor error with negative statusはclassifyせずrejectする', async () => {
    execute.mockRejectedValueOnce({ status: -1 });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: '1' },
        operation: 'documents.upsert',
        payload: {},
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow();
    expect(service.pendingCommands()[0]?.state).toBe('sending');
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
        optimisticValue: {},
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
        payload: {},
        optimisticValue: { favFrom: 7, favTo: '42', title: 'local' },
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
          payload: {},
          optimisticValue: { favFrom: 7, favTo: '42', title: 'local' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline replica source "natural_documents" requires natural identity.');
  });

  it('natural identityとoptimistic valueのkey不一致を永続化前に拒否する', async () => {
    options.replicaSchema = naturalReplicaSchema;

    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'natural_documents',
          identity: { kind: 'natural', naturalKey: { favFrom: 7, favTo: '22' } },
          operation: 'natural_documents.create',
          payload: {},
          optimisticValue: { favFrom: 7, favTo: '21', title: 'local' },
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline command naturalKey must match optimistic values for "natural_documents".');
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('empty generated localIdを永続化前に拒否する', async () => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: '' },
          operation: 'documents.create',
          payload: {},
          optimisticValue: { id: 0, title: 'local' },
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
        optimisticValue: {},
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
        optimisticValue: { name: 'adopted' },
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
        optimisticValue: {},
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
        optimisticValue: { name: 'confirmed' },
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
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
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
        optimisticValue: { name: 'confirmed' },
        baseRevision: 4,
        replicaMutation: 'delete',
      },
      { flush: false },
    );

    execute.mockResolvedValueOnce({ response: null });
    connected.set(true);
    await service.flush();

    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
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
        optimisticValue: rows[0]!.values,
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
        payload: {},
        optimisticValue: { name: 'recreated', presentation: 'pending' },
      },
      { flush: false },
    );
    // A feed/cache integration may patch local-only values while delete is in flight.
    rows[0] = { ...rows[0]!, values: { name: 'recreated', presentation: null } };

    execute.mockResolvedValueOnce({ removeReplica: true, clearRemoteId: true, response: null }).mockImplementationOnce(async () => {
      expect(rows[0]).toMatchObject({
        identity: { kind: 'generated', localId: 'stable-local-id', remoteId: null },
        values: { name: 'recreated', presentation: null },
      });
      return {
        remoteId: 43,
        confirmedValues: { name: 'recreated', presentation: null },
        response: null,
      };
    });
    connected.set(true);

    await service.flush();

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { kind: 'generated', localId: 'stable-local-id', remoteId: 42 },
      { kind: 'generated', localId: 'stable-local-id', remoteId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        identity: { kind: 'generated', localId: 'stable-local-id', remoteId: 43 },
        serverRevision: null,
        values: { name: 'recreated', presentation: null },
        syncState: 'confirmed',
      }),
    ]);
    expect(commands).toEqual([]);
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
        optimisticValue: { name: 'confirmed' },
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
        optimisticValue: { name: 'recreated' },
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
        values: { name: 'recreated' },
        syncState: 'confirmed',
      }),
    ]);
    expect(commands).toEqual([]);
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
        payload: {},
        optimisticValue: { name: 'confirmed', presentation: 'pending' },
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
        payload: {},
        optimisticValue: { name: 'recreated', presentation: 'pending' },
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
        values: { name: 'recreated', presentation: 'pending' },
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
        values: { name: 'recreated', presentation: null },
      }),
    ]);
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
        optimisticValue: { name: 'confirmed' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(rows).toEqual([]);

    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        identity: { kind: 'generated', localId: 'complete-first-local-id', remoteIdHint: 42 },
        operation: 'documents.create',
        payload: {},
        optimisticValue: { name: 'recreated' },
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
        values: { name: 'recreated' },
      }),
    ]);
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
        payload: {},
        optimisticValue: { id: oldRemoteId, title: 'old' },
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
        optimisticValue: { id: '', title: 'new' },
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
      }),
    ]);
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
        optimisticValue: { name: 'updated' },
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
        optimisticValue: rows[0]!.values,
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
        optimisticValue: { name: 'recreated' },
      },
      { flush: false },
    );
    const rebase = vi.spyOn(TestBed.inject(OFFLINE_COMMAND_EXECUTOR), 'withServerRevision');
    rebase.mockClear();
    execute.mockResolvedValueOnce({
      removeReplica: true,
      clearRemoteId: true,
      serverRevision: 5,
      response: null,
    });
    connected.set(true);

    await expect(service.flush()).rejects.toThrow('Offline command cannot return serverRevision and clearRemoteId together.');
    expect(rebase).not.toHaveBeenCalled();
    expect(commands[1]).toMatchObject({ baseRevision: 4 });
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
        optimisticValue: { name: 'confirmed' },
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
        optimisticValue: { name: 'confirmed' },
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
        payload: {},
        optimisticValue: { favFrom: 7, favTo: '42', title: 'confirmed' },
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
        optimisticValue: { name: 'confirmed' },
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
        optimisticValue: { name: 'later optimistic' },
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, response: null });
    execute.mockRejectedValueOnce({ status: 0 });
    connected.set(true);
    await service.flush();
    expect(rows[0]).toMatchObject({ confirmedValues: null, visibility: 'present' });

    await service.discard(followingId, { flush: false });
    expect(rows).toEqual([]);
  });

  it('tombstone read APIを持たないcustom repositoryではdelete enqueueを明示rejectする', async () => {
    const repository = TestBed.inject(OFFLINE_REPOSITORY) as OfflineRepository & { getReplicaRowIncludingPendingDelete?: unknown };
    const getReplicaRowIncludingPendingDelete = repository.getReplicaRowIncludingPendingDelete;
    try {
      delete repository.getReplicaRowIncludingPendingDelete;
      await expect(
        service.enqueue(
          {
            scopeId: '10',
            aggregateType: 'documents',
            identity: { kind: 'generated', localId: 'missing-tombstone-api' },
            operation: 'documents.delete',
            payload: {},
            optimisticValue: {},
            replicaMutation: 'delete',
          },
          { flush: false },
        ),
      ).rejects.toThrow('Offline repository does not support durable replica delete tombstones.');
    } finally {
      repository.getReplicaRowIncludingPendingDelete = getReplicaRowIncludingPendingDelete;
    }
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
          optimisticValue: {},
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
          optimisticValue: {},
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
        optimisticValue: { name: 'draft' },
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
        optimisticValue: { name: 'adopted' },
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
        optimisticValue: { name: 'adopted' },
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
        optimisticValue: {},
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
    const userScopedSourceKeys = new Set(['test_items']);

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
          commands.sort(compareCommands);
        }),
      } as unknown as OfflineRepository;
      TestBed.configureTestingModule({
        providers: [
          OfflineSyncService,
          { provide: OFFLINE_REPOSITORY, useValue: repository },
          { provide: OfflineNetworkService, useValue: { connected } },
          { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', replicaSchema: userReplicaSchema } },
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
              withServerRevision: (command: OfflineCommand, revision: string | number) => ({
                ...command,
                baseRevision: revision,
              }),
            },
          },
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
          optimisticValue: { id: 42, title: 'G10 edit' },
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
          optimisticValue: { id: 42, title: 'G11 edit' },
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
        optimisticValue: { id: 42, title: 'G11 edit' },
      });
      expect(
        findReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', {
          kind: 'generated',
          localId: '019d-user-item',
        }),
      ).toMatchObject({
        values: { title: 'G11 edit' },
        confirmedValues: { title: 'G10 edit' },
        serverRevision: 2,
        syncState: 'pending',
      });
      resolveSecond({ serverRevision: 3, confirmedValues: { id: 42, title: 'G11 edit' }, response: null });
      await flush;
      expect(execute.mock.calls.map(([command]) => (command as OfflineCommand<{ title: string }>).payload)).toEqual([
        { title: 'G10 edit' },
        { title: 'G11 edit' },
      ]);
      expect(service.pendingCount()).toBe(0);
    });

    it('cross-partition commandの一方discardでも他方のoptimistic valueを保持する', async () => {
      const firstId = await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'test_items',
          identity: { kind: 'generated', localId: '019d-user-item' },
          operation: 'test_items.update',
          payload: { title: 'G10 edit' },
          optimisticValue: { id: 42, title: 'G10 edit' },
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
          optimisticValue: { id: 42, title: 'G11 edit' },
          baseRevision: 1,
        },
        { flush: false },
      );
      await service.discard(firstId, { flush: false });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ scopeId: '11', optimisticValue: { id: 42, title: 'G11 edit' } });
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
          optimisticValue: { id: 56, name: 'G10 name' },
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
          optimisticValue: { id: 55, name: 'G11 name' },
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
      expect(service.pendingCount()).toBe(0);
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
          optimisticValue: { id: 0, title: 'queued' },
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
          optimisticValue: { id: 0, title: 'queued' },
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
      const commandId = await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'discard-foreground-policy' },
          operation: 'documents.create',
          payload: { title: 'queued' },
          optimisticValue: { id: 0, title: 'queued' },
        },
        { flush: false },
      );

      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

      await service.discard(commandId, { flush: false });
      pull.mockClear();

      connected.set(false);
      connected.set(true);

      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '20' });
      expect(pull).not.toHaveBeenCalledWith({ userId: 1, scopeId: '30' });
    });

    it('discardAllPending preserves foreground policy so reconnect automatic flush stays partial', async () => {
      await service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          identity: { kind: 'generated', localId: 'discard-all-foreground-policy' },
          operation: 'documents.create',
          payload: { title: 'queued' },
          optimisticValue: { id: 0, title: 'queued' },
        },
        { flush: false },
      );

      await service.refreshSession(['10']);
      await vi.waitFor(() => expect(pull).toHaveBeenCalledWith({ userId: 1, scopeId: '10' }));
      pull.mockClear();

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
