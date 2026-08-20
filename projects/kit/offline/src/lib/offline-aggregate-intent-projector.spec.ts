import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_AGGREGATE_INTENT_PROJECTOR,
  type OfflineAggregateIntentProjectInput,
  type OfflineAggregateIntentProjector,
} from './offline-aggregate-intent-projector';
import { OFFLINE_COMMAND_EXECUTOR, OFFLINE_SYNC_CONTEXT } from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineReplicaPullService } from './offline-replica-pull.service';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import { defineOfflineReplicaSchema, defineReplicaEntity, generatedId, integer, localOnly, text } from './offline-replica-schema';
import {
  canonicalOfflineReplicaIdentity,
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineReplicaAddress,
  type OfflineReplicaRow,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';
import { rematerializeTestAggregate } from './offline-test-helpers';
import { OfflineSyncService } from './offline-sync.service';

const replicaSchema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ id: number; qty: number }>()({
      table: 'items',
      sourceKey: 'items',
      scope: 'partition',
      fields: { id: generatedId('integer'), qty: integer() },
    }),
    defineReplicaEntity<{ qty: number }>()({
      table: 'item_views',
      sourceKey: 'item_views',
      scope: 'partition',
      identity: localOnly(),
      fields: { qty: integer() },
    }),
    defineReplicaEntity<{ name: string }>()({
      table: 'item_attachments',
      sourceKey: 'item_attachments',
      scope: 'partition',
      identity: localOnly(),
      fields: { name: text() },
    }),
  ],
  migrations: [],
});

const scope: OfflineScope = { userId: 1, scopeId: '10' };

describe('OfflineAggregateIntentProjector', () => {
  describe('OfflineReplicaMutationCoordinator validation', () => {
    const baseRow = (overrides: Partial<OfflineReplicaRow> = {}): OfflineReplicaRow => ({
      ...scope,
      sourceKey: 'items',
      identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
      values: { id: 7, qty: 12 },
      confirmedValues: { id: 7, qty: 10 },
      serverRevision: 3,
      fetchedAt: 1,
      syncState: 'pending',
      visibility: 'present',
      ...overrides,
    });
    const viewRow = (overrides: Partial<OfflineReplicaRow> = {}): OfflineReplicaRow => ({
      ...scope,
      sourceKey: 'item_views',
      identity: { kind: 'local', localId: 'item-1-view' },
      values: { qty: 12 },
      confirmedValues: { qty: 10 },
      serverRevision: null,
      fetchedAt: 1,
      syncState: 'pending',
      visibility: 'present',
      ...overrides,
    });

    function coordinatorWith(project: OfflineAggregateIntentProjector['project']): OfflineReplicaMutationCoordinator {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          OfflineReplicaMutationCoordinator,
          { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', databaseEncryption: false, replicaSchema } },
          { provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR, useValue: { project } },
        ],
      });
      return TestBed.inject(OfflineReplicaMutationCoordinator);
    }

    it('rejects a base row that changes scope or identity and a localOnly row outside the footprint', () => {
      const coordinator = coordinatorWith(() => ({
        baseRow: baseRow({ scopeId: '99', identity: { kind: 'generated', localId: 'other', remoteId: 7 } }),
        putLocalOnlyRows: [viewRow({ scopeId: '99', identity: { kind: 'local', localId: 'foreign' } })],
      }));
      expect(() =>
        coordinator.projectAggregateIntent({
          baseRow: baseRow(),
          localOnlyRows: [viewRow()],
          commands: [],
        }),
      ).toThrow(/scope and source|aggregate identity/);
    });

    it('rejects undeclared localOnly output even when the base row is valid', () => {
      const coordinator = coordinatorWith(() => ({
        baseRow: baseRow({ values: { id: 7, qty: 10 }, syncState: 'confirmed', visibility: 'present' }),
        putLocalOnlyRows: [
          viewRow({ values: { qty: 10 }, syncState: 'confirmed' }),
          viewRow({ identity: { kind: 'local', localId: 'extra' }, values: { qty: 10 }, confirmedValues: null }),
        ],
      }));
      expect(() =>
        coordinator.projectAggregateIntent({
          baseRow: baseRow({ values: { id: 7, qty: 12 } }),
          localOnlyRows: [viewRow()],
          commands: [],
        }),
      ).toThrow('undeclared localOnly row');
    });

    it('propagates projector failure without returning a projection', () => {
      const coordinator = coordinatorWith(() => {
        throw new Error('fold failed');
      });
      expect(() =>
        coordinator.projectAggregateIntent({
          baseRow: baseRow(),
          localOnlyRows: [viewRow()],
          commands: [],
        }),
      ).toThrow('fold failed');
    });

    it('accepts conflict only for pull with pending commands', () => {
      const coordinator = coordinatorWith(() => ({ kind: 'conflict', reason: 'revision_sensitive' }));
      const command = {
        ...scope,
        commandId: 'cmd-1',
        aggregateType: 'items',
        sourceKey: 'items',
        identity: { kind: 'generated' as const, localId: 'item-1' },
        operation: 'items.absolute',
        payload: {},
        baseRevision: 1,
        state: 'pending' as const,
        attempts: 0,
        retryAt: null,
        createdAt: 1,
        lastErrorCode: null,
      };

      expect(
        coordinator.projectAggregateIntent({
          baseRow: baseRow(),
          localOnlyRows: [],
          commands: [command],
          trigger: 'pull',
          incomingRevision: 2,
        }),
      ).toEqual({ kind: 'conflict', reason: 'revision_sensitive' });
      expect(() =>
        coordinator.projectAggregateIntent({ baseRow: baseRow(), localOnlyRows: [], commands: [command], trigger: 'local' }),
      ).toThrow('valid only for pending commands during pull');
    });
  });

  describe('discard rematerialization', () => {
    let service: OfflineSyncService;
    let commands: OfflineCommand[];
    let rows: OfflineReplicaRow[];
    let transactReplica: ReturnType<typeof vi.fn>;
    let projectImpl: OfflineAggregateIntentProjector['project'];

    beforeEach(() => {
      commands = [];
      rows = [];
      projectImpl = rematerializeTestAggregate;
      transactReplica = vi.fn(async (transaction) => {
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
      });
      const findRow = (queryScope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) =>
        rows.find((item) => {
          if (item.userId !== queryScope.userId || item.scopeId !== queryScope.scopeId || item.sourceKey !== sourceKey) return false;
          if (identity.kind === 'generated') {
            return item.identity.kind === 'generated' && item.identity.localId === identity.localId;
          }
          if (identity.kind === 'local') {
            return item.identity.kind === 'local' && item.identity.localId === identity.localId;
          }
          return item.identity.kind === 'natural' && JSON.stringify(item.identity.naturalKey) === JSON.stringify(identity.naturalKey);
        }) ?? null;
      const repository = {
        initialize: vi.fn(async () => undefined),
        getCommands: vi.fn(async (queryScope: OfflineScope) =>
          commands.filter((item) => item.userId === queryScope.userId && item.scopeId === queryScope.scopeId),
        ),
        getCommandsForUser: vi.fn(async (userId: number) => commands.filter((item) => item.userId === userId)),
        putCommand: vi.fn(async (command: OfflineCommand) => {
          commands = commands.filter((item) => item.commandId !== command.commandId);
          commands.push(structuredClone(command));
          commands.sort((left, right) => left.createdAt - right.createdAt);
        }),
        getReplicaRow: vi.fn(async (queryScope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) =>
          findRow(queryScope, sourceKey, identity),
        ),
        getReplicaRowIncludingPendingDelete: vi.fn(async (queryScope: OfflineScope, sourceKey: string, identity: OfflineReplicaAddress) =>
          findRow(queryScope, sourceKey, identity),
        ),
        getReplicaRowByRemoteId: vi.fn(async () => null),
        getReplicaRowByRemoteIdentity: vi.fn(async () => null),
        getReplicaCursor: vi.fn(async () => null),
        getPullAttentions: vi.fn(async () => []),
        transactReplica,
      } as unknown as OfflineRepository;
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          OfflineSyncService,
          { provide: OFFLINE_REPOSITORY, useValue: repository },
          { provide: OfflineNetworkService, useValue: { connected: signal(false) } },
          { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'test-offline', databaseEncryption: false, replicaSchema } },
          { provide: OfflineReplicaPullService, useValue: { pull: vi.fn(async () => undefined) } },
          { provide: ErrorHandler, useValue: { handleError: vi.fn() } },
          {
            provide: OFFLINE_COMMAND_HOOKS,
            useValue: { entityType: (command: OfflineCommand) => command.aggregateType },
          },
          {
            provide: OFFLINE_SYNC_CONTEXT,
            useValue: {
              getLocalSession: vi.fn(async () => ({ userId: 1, scopes: [scope] })),
              getSession: vi.fn(async () => ({ userId: 1, scopes: [scope] })),
            },
          },
          {
            provide: OFFLINE_COMMAND_EXECUTOR,
            useValue: {
              execute: vi.fn(async () => ({ response: null })),
            },
          },
          {
            provide: OFFLINE_AGGREGATE_INTENT_PROJECTOR,
            useValue: { project: (input: OfflineAggregateIntentProjectInput) => projectImpl(input) },
          },
        ],
      });
      service = TestBed.inject(OfflineSyncService);
    });

    async function enqueueQty(
      localId: string,
      payload: { kind: 'delta' | 'stocktake'; qty: number },
      optimisticQty: number,
      view?: OfflineReplicaRow,
    ): Promise<string> {
      return service.enqueuePrepared(
        async () => ({
          request: {
            scopeId: scope.scopeId,
            aggregateType: 'items',
            identity: { kind: 'generated', localId },
            operation: 'inventory.changeQty',
            payload,
            localOnlyFootprint: view ? [view] : undefined,
          },
        }),
        { flush: false },
      );
    }

    it('quantity chain discard rematerializes remaining deltas onto confirmed qty', async () => {
      const view: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'item_views',
        identity: { kind: 'local', localId: 'item-1-view' },
        values: { qty: 10 },
        confirmedValues: { qty: 10 },
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed',
      };
      rows.push(
        {
          ...scope,
          sourceKey: 'items',
          identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
          values: { id: 7, qty: 10 },
          confirmedValues: { id: 7, qty: 10 },
          serverRevision: 3,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
        view,
      );
      const firstId = await enqueueQty('item-1', { kind: 'delta', qty: 2 }, 12, view);
      await enqueueQty('item-1', { kind: 'delta', qty: 3 }, 15, view);
      expect(rows.find((row) => row.sourceKey === 'items')?.values).toEqual({ id: 7, qty: 15 });

      await service.discard(firstId, { flush: false });

      expect(commands).toHaveLength(1);
      expect(commands[0]?.payload).toEqual({ kind: 'delta', qty: 3 });
      expect(rows.find((row) => row.sourceKey === 'items')).toMatchObject({
        values: { id: 7, qty: 13 },
        confirmedValues: { id: 7, qty: 10 },
        syncState: 'pending',
      });
      expect(rows.find((row) => row.sourceKey === 'item_views')).toMatchObject({
        values: { qty: 13 },
        confirmedValues: { qty: 10 },
      });
    });

    it('stocktake then delta rematerializes the remaining intent after discard', async () => {
      const view: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'item_views',
        identity: { kind: 'local', localId: 'item-1-view' },
        values: { qty: 10 },
        confirmedValues: { qty: 10 },
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed',
      };
      rows.push(
        {
          ...scope,
          sourceKey: 'items',
          identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
          values: { id: 7, qty: 10 },
          confirmedValues: { id: 7, qty: 10 },
          serverRevision: 3,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
        view,
      );
      const stocktakeId = await enqueueQty('item-1', { kind: 'stocktake', qty: 7 }, 7, view);
      const deltaId = await enqueueQty('item-1', { kind: 'delta', qty: -1 }, 6, view);

      await service.discard(stocktakeId, { flush: false });
      expect(rows.find((row) => row.sourceKey === 'items')?.values).toEqual({ id: 7, qty: 9 });

      await service.discard(deltaId, { flush: false });
      expect(commands).toEqual([]);
      expect(rows.find((row) => row.sourceKey === 'items')).toMatchObject({
        values: { id: 7, qty: 10 },
        syncState: 'confirmed',
      });
      expect(rows.find((row) => row.sourceKey === 'item_views')).toMatchObject({
        values: { qty: 10 },
        syncState: 'confirmed',
      });
    });

    it('attachment/slip-style localOnly row is removed when its remaining chain no longer owns it', async () => {
      const view: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'item_views',
        identity: { kind: 'local', localId: 'item-1-view' },
        values: { qty: 10 },
        confirmedValues: { qty: 10 },
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'confirmed',
      };
      const attachment: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'item_attachments',
        identity: { kind: 'local', localId: 'slip-1' },
        values: { name: 'pending-slip' },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 2,
        syncState: 'pending',
      };
      rows.push(
        {
          ...scope,
          sourceKey: 'items',
          identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
          values: { id: 7, qty: 10 },
          confirmedValues: { id: 7, qty: 10 },
          serverRevision: 3,
          fetchedAt: 1,
          syncState: 'confirmed',
        },
        view,
      );
      const attachId = await service.enqueuePrepared(
        async () => ({
          request: {
            scopeId: scope.scopeId,
            aggregateType: 'items',
            identity: { kind: 'generated', localId: 'item-1' },
            operation: 'items.attach',
            payload: { attachment: { id: 'slip-1', name: 'pending-slip' } },
            localOnlyFootprint: [view, attachment],
          },
        }),
        { flush: false },
      );
      expect(rows.some((row) => row.sourceKey === 'item_attachments')).toBe(true);

      await service.discard(attachId, { flush: false });

      expect(commands).toEqual([]);
      expect(rows.find((row) => row.sourceKey === 'item_attachments')).toBeUndefined();
      expect(rows.find((row) => row.sourceKey === 'item_views')).toMatchObject({ values: { qty: 10 }, syncState: 'confirmed' });
    });

    it('projector failure leaves commands and replica rows unchanged', async () => {
      rows.push({
        ...scope,
        sourceKey: 'items',
        identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
        values: { id: 7, qty: 10 },
        confirmedValues: { id: 7, qty: 10 },
        serverRevision: 3,
        fetchedAt: 1,
        syncState: 'confirmed',
      });
      const commandId = await enqueueQty('item-1', { kind: 'delta', qty: 2 }, 12);
      const beforeRows = structuredClone(rows);
      const beforeCommands = structuredClone(commands);
      const writes = transactReplica.mock.calls.length;
      projectImpl = () => {
        throw new Error('fold failed');
      };

      await expect(service.discard(commandId, { flush: false })).rejects.toThrow('fold failed');
      expect(transactReplica).toHaveBeenCalledTimes(writes);
      expect(rows).toEqual(beforeRows);
      expect(commands).toEqual(beforeCommands);
    });

    it('scope or identity invalid output is rejected with zero writes', async () => {
      rows.push({
        ...scope,
        sourceKey: 'items',
        identity: { kind: 'generated', localId: 'item-1', remoteId: 7 },
        values: { id: 7, qty: 10 },
        confirmedValues: { id: 7, qty: 10 },
        serverRevision: 3,
        fetchedAt: 1,
        syncState: 'confirmed',
      });
      const commandId = await enqueueQty('item-1', { kind: 'delta', qty: 2 }, 12);
      const beforeRows = structuredClone(rows);
      const beforeCommands = structuredClone(commands);
      const writes = transactReplica.mock.calls.length;
      projectImpl = (input) => ({
        ...rematerializeTestAggregate(input),
        baseRow: input.baseRow ? { ...input.baseRow, scopeId: '99', identity: { kind: 'generated', localId: 'other', remoteId: 8 } } : null,
      });

      await expect(service.discard(commandId, { flush: false })).rejects.toThrow(/scope and source|aggregate identity/);
      expect(transactReplica).toHaveBeenCalledTimes(writes);
      expect(rows).toEqual(beforeRows);
      expect(commands).toEqual(beforeCommands);
    });

    it('current confirmedValues null removes the unconfirmed aggregate when no commands remain', async () => {
      const view: OfflineReplicaRow = {
        ...scope,
        sourceKey: 'item_views',
        identity: { kind: 'local', localId: 'draft-1-view' },
        values: { qty: 4 },
        confirmedValues: null,
        serverRevision: null,
        fetchedAt: 1,
        syncState: 'pending',
      };
      const commandId = await service.enqueuePrepared(
        async () => ({
          request: {
            scopeId: scope.scopeId,
            aggregateType: 'items',
            identity: { kind: 'generated', localId: 'draft-1' },
            operation: 'items.create',
            payload: { kind: 'delta', qty: 4 },
            localOnlyFootprint: [view],
          },
        }),
        { flush: false },
      );
      expect(rows.find((row) => row.sourceKey === 'items')?.confirmedValues).toBeNull();

      await service.discard(commandId, { flush: false });

      expect(commands).toEqual([]);
      expect(rows).toEqual([]);
    });
  });
});
