import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineReplicaQueryService } from './offline-replica-query.service';
import { defineOfflineReplicaSchema, defineReplicaEntity, serverId, text } from './offline-replica-schema';
import { OFFLINE_REPOSITORY, type OfflineCommand, type OfflineReplicaRow, type OfflineScope } from './offline-repository';

const scope: OfflineScope = { userId: 1, groupId: 10 };
const row: OfflineReplicaRow<{ title: string }> = {
  ...scope,
  sourceKey: 'documents',
  localId: 'local-1',
  serverId: 42,
  values: { title: 'Document' },
  confirmedValues: { title: 'Document' },
  serverRevision: 1,
  fetchedAt: 1,
  syncState: 'pending',
};
const schema = defineOfflineReplicaSchema({
  version: 1,
  entities: [
    defineReplicaEntity<{ id: number; title: string }>()({
      table: 'documents',
      sourceKey: 'documents',
      scope: 'group',
      fields: { id: serverId(), title: text() },
    }),
  ],
  migrations: [],
});

function command(effect: OfflineCommand['effect'], state: OfflineCommand['state'] = 'pending'): OfflineCommand {
  return {
    ...scope,
    commandId: 'command-1',
    aggregateType: 'documents',
    aggregateLocalId: row.localId,
    operation: 'documents.remove',
    effect,
    payload: {},
    optimisticValue: row.values,
    payloadHash: 'hash',
    baseRevision: 1,
    state,
    attempts: 0,
    retryAt: null,
    createdAt: 1,
    lastErrorCode: null,
  };
}

describe('OfflineReplicaQueryService', () => {
  let commands: OfflineCommand[];
  let service: OfflineReplicaQueryService;

  beforeEach(() => {
    commands = [];
    TestBed.configureTestingModule({
      providers: [
        OfflineReplicaQueryService,
        { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: 'query-test', replicaSchema: schema } },
        {
          provide: OFFLINE_REPOSITORY,
          useValue: {
            getReplicaRows: vi.fn(async () => [row]),
            getCommands: vi.fn(async () => commands),
          },
        },
        {
          provide: OFFLINE_COMMAND_HOOKS,
          useValue: { entityType: (item: OfflineCommand) => item.aggregateType },
        },
      ],
    });
    service = TestBed.inject(OfflineReplicaQueryService);
  });

  it('pending deleteをlocal tombstoneとして通常のprojectionから隠す', async () => {
    commands = [command('delete')];
    await expect(service.getVisibleRows(scope, 'documents')).resolves.toEqual([]);
  });

  it.each(['rejected', 'conflict'] as const)('%s deleteは解決可能なserver rowを表示する', async (state) => {
    commands = [command('delete', state)];
    await expect(service.getVisibleRows(scope, 'documents')).resolves.toEqual([row]);
  });

  it('旧commandのeffect未指定はupsertとして表示する', async () => {
    commands = [command(undefined)];
    await expect(service.getVisibleRows(scope, 'documents')).resolves.toEqual([row]);
  });
});
