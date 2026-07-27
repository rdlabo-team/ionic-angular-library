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
import { defineOfflineReplicaSchema, defineReplicaEntity, integer, naturalKey, serverId, text } from './offline-replica-schema';
import {
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { OfflinePayloadValidationError, OfflineSyncService } from './offline-sync.service';

const replicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ id: number; title: string }>()({
      table: 'documents',
      sourceKey: 'documents',
      scope: 'partition',
      fields: {
        id: serverId(),
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

describe('OfflineSyncService', () => {
  let service: OfflineSyncService;
  let commands: OfflineCommand[];
  let rows: OfflineReplicaRow[];
  let connected: ReturnType<typeof signal<boolean>>;
  let session: { userId: number; scopes: OfflineScope[] } | null;
  let localSession: { userId: number; scopes: OfflineScope[] } | null | undefined;
  let beforePutCommand: ((command: OfflineCommand) => Promise<void>) | null;
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
    beforeGetReplicaRow = null;
    pull = vi.fn(async () => undefined);
    handleError = vi.fn();
    options = { databaseName: 'test-offline', replicaSchema };
    execute.mockReset();
    execute.mockResolvedValue({ response: null });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async (scope: OfflineScope) =>
        commands.filter((item) => item.userId === scope.userId && item.scopeId === scope.scopeId),
      ),
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
      getReplicaRow: vi.fn(async (scope: OfflineScope, sourceKey: string, localId: string) => {
        await beforeGetReplicaRow?.();
        return (
          rows.find(
            (item) =>
              item.userId === scope.userId && item.scopeId === scope.scopeId && item.sourceKey === sourceKey && item.localId === localId,
          ) ?? null
        );
      }),
      getReplicaRowIncludingPendingDelete: vi.fn(async (scope: OfflineScope, sourceKey: string, localId: string) => {
        await beforeGetReplicaRow?.();
        return (
          rows.find(
            (item) =>
              item.userId === scope.userId && item.scopeId === scope.scopeId && item.sourceKey === sourceKey && item.localId === localId,
          ) ?? null
        );
      }),
      getReplicaRowByServerId: vi.fn(
        async (scope: OfflineScope, sourceKey: string, serverId: number) =>
          rows.find(
            (item) =>
              item.userId === scope.userId && item.scopeId === scope.scopeId && item.sourceKey === sourceKey && item.serverId === serverId,
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
              item.serverId === identity.serverId,
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
              item.localId !== row.localId,
          );
          rows.push(structuredClone(row));
        }
        for (const key of transaction.removeRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== key.userId ||
              item.scopeId !== key.scopeId ||
              item.sourceKey !== key.sourceKey ||
              item.localId !== key.localId,
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
          useValue: { execute, withServerRevision: (command: OfflineCommand) => command },
        },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
  });

  it('Outbox件数上限では既存commandを失わず新規enqueueを拒否する', async () => {
    options.outboxLimits = { maxCommandsPerUser: 1 };
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: 'first',
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
          aggregateLocalId: 'second',
          operation: 'documents.create',
          payload: { title: 'second' },
          optimisticValue: { id: 0, title: 'second' },
        },
        { flush: false },
      ),
    ).rejects.toMatchObject({ name: 'OfflineOutboxCapacityError', reason: 'command_count' });
    expect(commands).toHaveLength(1);
    expect(rows.map((row) => row.localId)).toEqual(['first']);
  });

  it('Outbox容量上限では既存commandとreplicaを失わず新規enqueueを拒否する', async () => {
    options.outboxLimits = { maxBytesPerUser: 1 };

    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          aggregateLocalId: 'oversized',
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
        aggregateLocalId: 'offline-local',
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

  it('offline初期化後の再接続でpending outboxを自動送信する', async () => {
    await service.initialize();
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: 'reconnect-local',
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
        aggregateLocalId: 'revoked',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
  });

  it('local_idを不変主キーにして送信直前に最新server_idへ解決する', async () => {
    execute.mockResolvedValueOnce({
      serverId: 38142,
      serverRevision: 1,
      confirmedValues: { name: 'draft' },
      response: { id: 38142 },
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-aaaa',
        operation: 'documents.create',
        payload: { name: 'draft' },
        optimisticValue: { name: 'draft' },
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({ localId: '019d-aaaa', serverId: null, syncState: 'pending' });
    expect(commands[0]).toMatchObject({ aggregateLocalId: '019d-aaaa' });
    expect('serverId' in commands[0]!).toBe(false);

    connected.set(true);
    await service.flush();
    expect(execute.mock.calls[0]?.[1]).toEqual({ localId: '019d-aaaa', serverId: null });
    expect(rows[0]).toMatchObject({
      localId: '019d-aaaa',
      serverId: 38142,
      serverRevision: 1,
      syncState: 'confirmed',
      confirmedValues: { name: 'draft' },
    });
    expect(commands.every((command) => !('serverId' in command))).toBe(true);

    execute.mockResolvedValueOnce({
      serverRevision: 2,
      confirmedValues: { name: 'edited' },
      response: { id: 38142, name: 'edited' },
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-aaaa',
        operation: 'documents.update',
        payload: { name: 'edited', revision: 1 },
        optimisticValue: { name: 'edited' },
        baseRevision: 1,
      },
      { flush: false },
    );
    await service.flush();
    expect(execute.mock.calls[1]?.[1]).toEqual({ localId: '019d-aaaa', serverId: 38142 });
    expect(rows[0]).toMatchObject({
      localId: '019d-aaaa',
      serverId: 38142,
      serverRevision: 2,
      confirmedValues: { name: 'edited' },
    });
    expect(commands.every((command) => !('serverId' in command))).toBe(true);
  });

  it('session scope発見後に前回起動のsending commandをpendingへ復旧する', async () => {
    session = null;
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-aaaa',
      serverId: null,
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
      aggregateLocalId: '019d-aaaa',
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
        aggregateLocalId: '019d-new',
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
      localId: '019d-existing',
      serverId: 38142,
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
        aggregateLocalId: '019d-existing',
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
      serverId: 38142,
    });
  });

  it('同一ミリ秒のDate.nowでもcreatedAtは単調増加で保存する', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '1',
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
        aggregateLocalId: '2',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '2',
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
          aggregateLocalId: '1',
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
      { scopeId: '10', aggregateType: 'documents', aggregateLocalId: '1', operation: 'documents.upsert', payload: {}, optimisticValue: {} },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state, lastErrorCode: String(status) });
    expect(rows[0]?.syncState).toBe(rowSyncState);
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
      localId: `delete-${status}`,
      serverId: 42,
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
        aggregateLocalId: `delete-${status}`,
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
      expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Offline replica row not found: documents/1' })),
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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
        aggregateLocalId: '1',
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

  it('invalid serverIdはhard failする', async () => {
    execute.mockResolvedValueOnce({ serverId: 0, serverRevision: 1, confirmedValues: {}, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-invalid-id',
        operation: 'documents.create',
        payload: {},
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline command returned invalid serverId 0.');
  });

  it('naturalKey entityへのserverId応答はcompleteCommand境界でhard failする', async () => {
    options.replicaSchema = naturalReplicaSchema;
    execute.mockResolvedValueOnce({
      serverId: 99,
      serverRevision: 1,
      confirmedValues: { favFrom: 7, favTo: '42', title: 'confirmed' },
      response: null,
    });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'natural_documents',
        aggregateLocalId: 'immutable-uuid',
        operation: 'natural_documents.create',
        payload: {},
        optimisticValue: { favFrom: 7, favTo: '42', title: 'local' },
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline command returned serverId for naturalKey source "natural_documents".');
  });

  it('reassigned serverIdはhard failする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-existing',
      serverId: 38142,
      values: {},
      confirmedValues: {},
      serverRevision: 1,
      fetchedAt: 1,
      syncState: 'confirmed',
    });
    execute.mockResolvedValueOnce({ serverId: 99999, serverRevision: 2, confirmedValues: {}, response: null });
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-existing',
        operation: 'documents.update',
        payload: {},
        optimisticValue: {},
        baseRevision: 1,
      },
      { flush: false },
    );
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline replica serverId is immutable');
  });

  it('enqueue時のserverId採用は初回pull前にreplica rowへ永続化する', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-adopted',
        serverId: 38142,
        operation: 'documents.update',
        payload: { name: 'adopted' },
        optimisticValue: { name: 'adopted' },
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({
      localId: '019d-adopted',
      serverId: 38142,
      confirmedValues: null,
      syncState: 'pending',
    });
  });

  it('採用済みserverIdはflush時にdelete操作のexecutor targetへ渡す', async () => {
    await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-adopted',
        serverId: 38142,
        operation: 'documents.delete',
        payload: {},
        optimisticValue: {},
      },
      { flush: false },
    );
    connected.set(true);
    execute.mockResolvedValueOnce({ removeReplica: true, response: null });
    await service.flush();
    expect(execute.mock.calls[0]?.[1]).toEqual({ localId: '019d-adopted', serverId: 38142 });
  });

  it('confirmed rowのdeleteはOutbox markerとhidden baselineを原子的に残し、ACKでphysical removeする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-delete',
      serverId: 38142,
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
        aggregateLocalId: '019d-delete',
        operation: 'documents.delete',
        payload: { id: 38142 },
        optimisticValue: { name: 'confirmed' },
        baseRevision: 4,
        replicaMutation: 'delete',
      },
      { flush: false },
    );

    expect(rows[0]).toMatchObject({ visibility: 'pending_delete', confirmedValues: { name: 'confirmed' }, serverRevision: 4 });
    expect(commands[0]).toMatchObject({ replicaMutation: 'delete', aggregateLocalId: '019d-delete', baseRevision: 4 });

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
      localId: '019d-delete-without-projection',
      serverId: 38142,
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
        aggregateLocalId: '019d-delete-without-projection',
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

  it('delete後のqueued recreateはlocalIdを維持してserverIdを再割当できる', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: 'stable-local-id',
      serverId: 42,
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
        aggregateLocalId: 'stable-local-id',
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
        aggregateLocalId: 'stable-local-id',
        operation: 'documents.create',
        payload: {},
        optimisticValue: { name: 'recreated', presentation: 'pending' },
      },
      { flush: false },
    );
    // A feed/cache integration may patch local-only values while delete is in flight.
    rows[0] = { ...rows[0]!, values: { name: 'recreated', presentation: null } };

    execute.mockResolvedValueOnce({ removeReplica: true, clearServerId: true, response: null }).mockImplementationOnce(async () => {
      expect(rows[0]).toMatchObject({
        localId: 'stable-local-id',
        serverId: null,
        values: { name: 'recreated', presentation: null },
      });
      return {
        serverId: 43,
        confirmedValues: { name: 'recreated', presentation: null },
        response: null,
      };
    });
    connected.set(true);

    await service.flush();

    expect(execute.mock.calls.map((call) => call[1])).toEqual([
      { localId: 'stable-local-id', serverId: 42 },
      { localId: 'stable-local-id', serverId: null },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        localId: 'stable-local-id',
        serverId: 43,
        values: { name: 'recreated', presentation: null },
        syncState: 'confirmed',
      }),
    ]);
    expect(commands).toEqual([]);
  });

  it('clearServerIdはconfirmed delete以外では拒否する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: 'invalid-clear',
      serverId: 42,
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
        aggregateLocalId: 'invalid-clear',
        operation: 'documents.update',
        payload: {},
        optimisticValue: { name: 'updated' },
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ clearServerId: true, response: null });
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline command can clear serverId only for a confirmed replica removal.');
  });

  it('pending deleteのdiscardはconfirmed baselineとpresent visibilityを復元する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-delete-discard',
      serverId: 38142,
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
        aggregateLocalId: '019d-delete-discard',
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
        localId: '019d-delete-discard',
        values: { name: 'confirmed baseline' },
        confirmedValues: { name: 'confirmed baseline' },
        visibility: 'present',
        syncState: 'confirmed',
      }),
    ]);
    expect(commands).toEqual([]);
  });

  it('delete ACKはserverId/naturalKeyのidentity変更をhard failする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: 'delete-server-id',
      serverId: 42,
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
        aggregateLocalId: 'delete-server-id',
        operation: 'documents.delete',
        payload: {},
        optimisticValue: { name: 'confirmed' },
        replicaMutation: 'delete',
      },
      { flush: false },
    );
    execute.mockResolvedValueOnce({ removeReplica: true, serverId: 43, response: null });
    connected.set(true);
    await expect(service.flush()).rejects.toThrow('Offline replica serverId is immutable: current=42, incoming=43.');

    commands = [];
    rows = [
      {
        userId: 1,
        scopeId: '10',
        sourceKey: 'natural_documents',
        localId: 'delete-natural-key',
        serverId: null,
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
        aggregateLocalId: 'delete-natural-key',
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
      localId: 'delete-then-upsert',
      serverId: 42,
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
        aggregateLocalId: 'delete-then-upsert',
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
        aggregateLocalId: 'delete-then-upsert',
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
            aggregateLocalId: 'missing-tombstone-api',
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

  it.each([0, -1, 1.5])('enqueue時の不正serverId %sは永続化前にrejectする', async (serverId) => {
    await expect(
      service.enqueue(
        {
          scopeId: '10',
          aggregateType: 'documents',
          aggregateLocalId: '019d-invalid',
          serverId,
          operation: 'documents.update',
          payload: {},
          optimisticValue: {},
        },
        { flush: false },
      ),
    ).rejects.toThrow(/invalid serverId/);
    expect(commands).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('別localIdへ既存serverIdを割り当てようとするとrejectする', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-existing',
      serverId: 38142,
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
          aggregateLocalId: '019d-new',
          serverId: 38142,
          operation: 'documents.update',
          payload: {},
          optimisticValue: {},
        },
        { flush: false },
      ),
    ).rejects.toThrow('Offline replica serverId 38142 is already mapped to localId 019d-existing.');
    expect(commands).toEqual([]);
  });

  it('同一localIdへのserverId再指定は許容する', async () => {
    rows.push({
      userId: 1,
      scopeId: '10',
      sourceKey: 'documents',
      localId: '019d-same',
      serverId: 38142,
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
        aggregateLocalId: '019d-same',
        serverId: 38142,
        operation: 'documents.update',
        payload: { name: 'draft' },
        optimisticValue: { name: 'draft' },
        baseRevision: 1,
      },
      { flush: false },
    );
    expect(rows[0]).toMatchObject({ localId: '019d-same', serverId: 38142, syncState: 'pending' });
    expect(commands).toHaveLength(1);
  });

  it('採用済み未確定rowはdiscardでoutboxとreplica rowを同時に除く', async () => {
    const commandId = await service.enqueue(
      {
        scopeId: '10',
        aggregateType: 'documents',
        aggregateLocalId: '019d-adopted',
        serverId: 38142,
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
        aggregateLocalId: '019d-adopted',
        serverId: 38142,
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
        aggregateLocalId: '1',
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
            id: serverId(),
            title: text(),
          },
        }),
        defineReplicaEntity<{ id: number; name: string }>()({
          table: 'test_group_items',
          sourceKey: 'test_group_items',
          scope: 'partition',
          fields: {
            id: serverId(),
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

    function findReplicaRow(scope: OfflineScope, sourceKey: string, localId: string): OfflineReplicaRow | undefined {
      return rows.find((item) => {
        if (item.userId !== scope.userId || item.sourceKey !== sourceKey || item.localId !== localId) return false;
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
        getReplicaRow: vi.fn(async (scope: OfflineScope, sourceKey: string, localId: string) => {
          const row = findReplicaRow(scope, sourceKey, localId);
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaRowByServerId: vi.fn(async (scope: OfflineScope, sourceKey: string, serverId: number) => {
          const row = rows.find((item) => {
            if (item.userId !== scope.userId || item.sourceKey !== sourceKey || item.serverId !== serverId) return false;
            return userScopedSourceKeys.has(sourceKey) ? true : item.scopeId === scope.scopeId;
          });
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaRowByRemoteIdentity: vi.fn(async (scope: OfflineScope, sourceKey: string, identity) => {
          if (identity.serverId === undefined) throw new Error(`Natural identity is unsupported by this test repository.`);
          const row = rows.find((item) => {
            if (item.userId !== scope.userId || item.sourceKey !== sourceKey || item.serverId !== identity.serverId) return false;
            return userScopedSourceKeys.has(sourceKey) ? true : item.scopeId === scope.scopeId;
          });
          return row ? projectReplicaRow(row, scope) : null;
        }),
        getReplicaCursor: vi.fn(async () => null),
        transactReplica: vi.fn(async (transaction) => {
          for (const row of transaction.putRows ?? []) {
            const existing = findReplicaRow(row, row.sourceKey, row.localId);
            rows = rows.filter(
              (item) =>
                item.userId !== row.userId ||
                item.sourceKey !== row.sourceKey ||
                item.localId !== row.localId ||
                (!userScopedSourceKeys.has(row.sourceKey) && item.scopeId !== row.scopeId),
            );
            rows.push(structuredClone(existing ? { ...existing, ...row } : row));
          }
          for (const key of transaction.removeRows ?? []) {
            rows = rows.filter(
              (item) =>
                item.userId !== key.userId ||
                item.sourceKey !== key.sourceKey ||
                item.localId !== key.localId ||
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
        localId: '019d-user-item',
        serverId: 42,
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
          aggregateLocalId: '019d-user-item',
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
          aggregateLocalId: '019d-user-item',
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
      expect(findReplicaRow({ userId: 1, scopeId: '10' }, 'test_items', '019d-user-item')).toMatchObject({
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
          aggregateLocalId: '019d-user-item',
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
          aggregateLocalId: '019d-user-item',
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
      expect(findReplicaRow({ userId: 1, scopeId: '11' }, 'test_items', '019d-user-item')).toMatchObject({
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
        localId: '019d-group-same',
        serverId: 55,
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
        localId: '019d-group-same',
        serverId: 56,
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
          aggregateLocalId: '019d-group-same',
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
          aggregateLocalId: '019d-group-same',
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
});
