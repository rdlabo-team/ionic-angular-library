import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_COMMAND_EXECUTOR,
  OFFLINE_SYNC_CONTEXT,
  type OfflineCommandResult,
  type OfflineCommandTarget,
} from './offline-command-executor';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineReplicaPullService } from './offline-replica-pull.service';
import { defineOfflineReplicaSchema, defineReplicaEntity, serverId, text } from './offline-replica-schema';
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
      scope: 'group',
      fields: {
        id: serverId(),
        title: text(),
      },
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
  let beforePutCommand: ((command: OfflineCommand) => Promise<void>) | null;
  let pull: ReturnType<typeof vi.fn<(scope: OfflineScope) => Promise<void>>>;
  let handleError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
  const execute = vi.fn(
    async (_command: OfflineCommand, _target: OfflineCommandTarget): Promise<OfflineCommandResult> => ({ response: null }),
  );

  beforeEach(() => {
    commands = [];
    rows = [];
    connected = signal(false);
    session = { userId: 1, scopes: [{ userId: 1, groupId: 10 }] };
    beforePutCommand = null;
    pull = vi.fn(async () => undefined);
    handleError = vi.fn();
    execute.mockReset();
    execute.mockResolvedValue({ response: null });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async (scope: OfflineScope) =>
        commands.filter((item) => item.userId === scope.userId && item.groupId === scope.groupId),
      ),
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
      getReplicaRow: vi.fn(
        async (scope: OfflineScope, sourceKey: string, localId: string) =>
          rows.find(
            (item) =>
              item.userId === scope.userId &&
              item.groupId === scope.groupId &&
              item.sourceKey === sourceKey &&
              item.localId === localId,
          ) ?? null,
      ),
      getReplicaCursor: vi.fn(async () => null),
      transactReplica: vi.fn(async (transaction) => {
        for (const row of transaction.putRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== row.userId ||
              item.groupId !== row.groupId ||
              item.sourceKey !== row.sourceKey ||
              item.localId !== row.localId,
          );
          rows.push(structuredClone(row));
        }
        for (const key of transaction.removeRows ?? []) {
          rows = rows.filter(
            (item) =>
              item.userId !== key.userId ||
              item.groupId !== key.groupId ||
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
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', replicaSchema } },
        { provide: OfflineReplicaPullService, useValue: { pull } },
        { provide: ErrorHandler, useValue: { handleError } },
        {
          provide: OFFLINE_SYNC_CONTEXT,
          useValue: { getSession: vi.fn(async () => session) },
        },
        {
          provide: OFFLINE_COMMAND_EXECUTOR,
          useValue: { execute, withServerRevision: (command: OfflineCommand) => command },
        },
      ],
    });
    service = TestBed.inject(OfflineSyncService);
  });

  it('同じaggregateの操作を作成順に送り、成功後だけoutboxから除く', async () => {
    await service.enqueue(
      {
        groupId: 10,
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
        groupId: 10,
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
        groupId: 10,
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
        groupId: 10,
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
      groupId: 10,
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
      groupId: 10,
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
    session = { userId: 1, scopes: [{ userId: 1, groupId: 10 }] };
    await service.refreshSession();
    expect(service.pendingCommands()[0]?.state).toBe('pending');
  });

  it('未同期createを破棄するとoutboxと未確定replica rowを同時に除く', async () => {
    const commandId = await service.enqueue(
      {
        groupId: 10,
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
      groupId: 10,
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
        groupId: 10,
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

  it('locale非依存のkey順で同じJSON payloadを同一hashにする', async () => {
    await service.enqueue(
      {
        groupId: 10,
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
        groupId: 10,
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
          groupId: 10,
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
      { groupId: 10, aggregateType: 'documents', aggregateLocalId: '1', operation: 'documents.upsert', payload: {}, optimisticValue: {} },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state, lastErrorCode: String(status) });
    expect(rows[0]?.syncState).toBe(rowSyncState);
  });

  it('flush中の一括discard後に旧commandを送信・復活させない', async () => {
    let resolveExecute!: (value: { response: null; serverRevision?: number }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    await service.enqueue(
      {
        groupId: 10,
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
        groupId: 10,
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
        groupId: 10,
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
        groupId: 10,
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
    await service.resetSession();
    commands = commands.filter((command) => command.userId !== 1);
    connected.set(false);
    session = { userId: 2, scopes: [{ userId: 2, groupId: 20 }] };
    await service.refreshSession();
    resolveExecute({ response: null, serverRevision: 2 });
    await oldFlush;
    expect(execute).toHaveBeenCalledOnce();
    expect(commands.some((command) => command.userId === 1)).toBe(false);
  });

  it('flush中に同一sessionを再activateしてもsending commandをpendingへ戻す', async () => {
    let resolveFirst!: (value: { response: null }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    await service.enqueue(
      {
        groupId: 10,
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
    await service.resetSession();
    await service.refreshSession();
    expect(service.pendingCommands()[0]?.state).toBe('pending');
    resolveFirst({ response: null });
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
        groupId: 10,
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
});
