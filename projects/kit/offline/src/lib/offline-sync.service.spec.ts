import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_EXECUTOR, OFFLINE_SYNC_CONTEXT } from './offline-command-executor';
import { OfflineNetworkService } from './offline-network.service';
import {
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineEntity,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { OfflinePayloadValidationError, OfflineSyncService } from './offline-sync.service';

describe('OfflineSyncService', () => {
  let service: OfflineSyncService;
  let commands: OfflineCommand[];
  let entities: OfflineEntity[];
  let connected: ReturnType<typeof signal<boolean>>;
  let session: { userId: number; scopes: OfflineScope[] } | null;
  let beforePutCommand: ((command: OfflineCommand) => Promise<void>) | null;
  const execute = vi.fn(async (_command: OfflineCommand) => ({ response: null }));

  beforeEach(() => {
    commands = [];
    entities = [];
    connected = signal(false);
    session = { userId: 1, scopes: [{ userId: 1, groupId: 10 }] };
    beforePutCommand = null;
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
      getEntity: vi.fn(
        async (scope: OfflineScope, type: string, id: string) =>
          entities.find(
            (item) => item.userId === scope.userId && item.groupId === scope.groupId && item.entityType === type && item.entityId === id,
          ) ?? null,
      ),
      putEntity: vi.fn(async (entity: OfflineEntity) => {
        entities = entities.filter(
          (item) =>
            item.userId !== entity.userId ||
            item.groupId !== entity.groupId ||
            item.entityType !== entity.entityType ||
            item.entityId !== entity.entityId,
        );
        entities.push(entity);
      }),
    } as unknown as OfflineRepository;
    TestBed.configureTestingModule({
      providers: [
        OfflineSyncService,
        { provide: OFFLINE_REPOSITORY, useValue: repository },
        { provide: OfflineNetworkService, useValue: { connected } },
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
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 1 } },
      { flush: false },
    );
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 2 } },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(execute.mock.calls.map(([command]) => (command as OfflineCommand<{ seq: number }>).payload.seq)).toEqual([1, 2]);
    expect(service.pendingCount()).toBe(0);
  });

  it('locale非依存のkey順で同じJSON payloadを同一hashにする', async () => {
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { あ: 3, z: 1, ä: 2 } },
      { flush: false },
    );
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '2', operation: 'documents.upsert', payload: { ä: 2, あ: 3, z: 1 } },
      { flush: false },
    );
    expect(service.pendingCommands()[0]?.payloadHash).toBe(service.pendingCommands()[1]?.payloadHash);
  });

  it('JSON外payloadを衝突するhashへ変換せずrejectする', async () => {
    await expect(
      service.enqueue(
        { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { value: undefined } },
        { flush: false },
      ),
    ).rejects.toBeInstanceOf(OfflinePayloadValidationError);
  });

  it.each([
    [401, 'blocked_auth'],
    [409, 'conflict'],
    [422, 'rejected'],
    [500, 'retry_wait'],
  ] as const)('HTTP %sを%sへ分類して操作を保持する', async (status, state) => {
    execute.mockRejectedValueOnce({ status });
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: {} },
      { flush: false },
    );
    connected.set(true);
    await service.flush();
    expect(service.pendingCommands()[0]).toMatchObject({ state, lastErrorCode: String(status) });
  });

  it('flush中の一括discard後に旧commandを送信・復活させない', async () => {
    let resolveExecute!: (value: { response: null; serverRevision?: number }) => void;
    execute.mockImplementationOnce(() => new Promise((resolve) => (resolveExecute = resolve)));
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 1 } },
      { flush: false },
    );
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 2 } },
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
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 1 } },
      { flush: false },
    );
    await service.enqueue(
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 2 } },
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
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 1 } },
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
      { groupId: 10, aggregateType: 'documents', aggregateId: '1', operation: 'documents.upsert', payload: { seq: 1 } },
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
