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
import { OfflineSyncService } from './offline-sync.service';

describe('OfflineSyncService', () => {
  let service: OfflineSyncService;
  let commands: OfflineCommand[];
  let entities: OfflineEntity[];
  let connected: ReturnType<typeof signal<boolean>>;
  const execute = vi.fn(async (_command: OfflineCommand) => ({ response: null }));

  beforeEach(() => {
    commands = [];
    entities = [];
    connected = signal(false);
    execute.mockReset();
    execute.mockResolvedValue({ response: null });
    const repository = {
      initialize: vi.fn(async () => undefined),
      getCommands: vi.fn(async (scope: OfflineScope) =>
        commands.filter((item) => item.userId === scope.userId && item.groupId === scope.groupId),
      ),
      putCommand: vi.fn(async (command: OfflineCommand) => {
        commands = commands.filter((item) => item.commandId !== command.commandId);
        commands.push(structuredClone(command));
        commands.sort((left, right) => left.createdAt - right.createdAt);
      }),
      replaceCommand: vi.fn(async (command: OfflineCommand) => {
        commands = commands.map((item) => (item.commandId === command.commandId ? structuredClone(command) : item));
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
          useValue: { getSession: vi.fn(async () => ({ userId: 1, scopes: [{ userId: 1, groupId: 10 }] })) },
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
});
