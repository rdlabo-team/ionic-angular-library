import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_COMMAND_EXECUTOR,
  type OfflineCommandExecutor,
  type OfflineCommandResult,
  type OfflineCommandTarget,
} from './offline-command-executor';
import {
  OfflineCapabilityError,
  OFFLINE_RUNTIME_CAPABILITIES,
  withOfflineOutbox,
  withOfflineReadFallback,
  withOfflineReplicaPull,
} from './offline-capabilities';
import type { OfflineCommand } from './offline-repository';
import type { OfflineRequestPolicy } from './offline-request-policy';
import type { OfflineReplicaPuller } from './offline-replica-puller';
import { defineOfflineReplicaSchema, defineReplicaEntity, serverId, text } from './offline-replica-schema';
import { OFFLINE_REPLICA_PULLER } from './offline-replica-puller';
import { resolveOfflineSetup } from './offline-provider';

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

@Injectable()
class TestRequestPolicy implements OfflineRequestPolicy {
  resolve() {
    return null;
  }
}

@Injectable()
class TestReplicaPuller implements OfflineReplicaPuller {
  pull = async () => ({
    schemaVersion: 1,
    schemaHash: 'test',
    changes: [],
    nextCursor: '',
    hasMore: false,
  });
}

@Injectable()
class TestCommandExecutor implements OfflineCommandExecutor {
  execute(_command: OfflineCommand, _target: OfflineCommandTarget): Promise<OfflineCommandResult> {
    return Promise.resolve({ response: null });
  }

  withServerRevision(command: OfflineCommand, _revision: string | number): OfflineCommand {
    return command;
  }
}

describe('resolveOfflineSetup', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('capabilitiesだけでrequest policy runtimeを構成できる', () => {
    const setup = resolveOfflineSetup({
      databaseName: 'capability-test',
      replicaSchema,
      capabilities: [withOfflineReadFallback(TestRequestPolicy)],
    });
    expect(setup.runtime).toEqual({ replicaPull: false, outbox: false });
  });

  it('legacy optionsは既存の全capabilityを有効にする', () => {
    const setup = resolveOfflineSetup({
      databaseName: 'legacy-test',
      replicaSchema,
      commandExecutor: TestCommandExecutor,
      replicaPuller: TestReplicaPuller,
      requestPolicies: [TestRequestPolicy],
    });
    expect(setup.runtime).toEqual({ replicaPull: true, outbox: true });
  });

  it('同じ単一transport capabilityの重複登録を拒否する', () => {
    expect(() =>
      resolveOfflineSetup({
        databaseName: 'duplicate-test',
        replicaSchema,
        capabilities: [withOfflineReplicaPull(TestReplicaPuller), withOfflineReplicaPull(TestReplicaPuller)],
      }),
    ).toThrow('provideOffline accepts at most one replicaPull capability.');
  });

  it('outbox capabilityが無い場合は内部disabled executorを提供する', async () => {
    const setup = resolveOfflineSetup({
      databaseName: 'capability-test',
      replicaSchema,
      capabilities: [withOfflineReadFallback(TestRequestPolicy)],
    });
    TestBed.configureTestingModule({ providers: [...setup.adapterProviders] });
    await expect(TestBed.inject(OFFLINE_COMMAND_EXECUTOR).execute({} as OfflineCommand, { localId: 'x', serverId: null })).rejects.toThrow(
      OfflineCapabilityError,
    );
  });

  it('replica pull capabilityが無い場合は内部disabled pullerを提供する', async () => {
    const setup = resolveOfflineSetup({
      databaseName: 'capability-test',
      replicaSchema,
      capabilities: [withOfflineReadFallback(TestRequestPolicy)],
    });
    TestBed.configureTestingModule({ providers: [...setup.adapterProviders] });
    await expect(
      TestBed.inject(OFFLINE_REPLICA_PULLER).pull({
        scope: { userId: 1, groupId: 1 },
        cursor: '',
        schemaVersion: 1,
        schemaHash: 'test',
      }),
    ).rejects.toThrow(OfflineCapabilityError);
  });

  it('legacy optionsはproduct adapterをそのまま登録する', () => {
    const setup = resolveOfflineSetup({
      databaseName: 'legacy-test',
      replicaSchema,
      commandExecutor: TestCommandExecutor,
      replicaPuller: TestReplicaPuller,
      requestPolicies: [TestRequestPolicy],
    });
    TestBed.configureTestingModule({
      providers: [
        TestCommandExecutor,
        TestReplicaPuller,
        { provide: OFFLINE_RUNTIME_CAPABILITIES, useValue: setup.runtime },
        ...setup.adapterProviders,
      ],
    });
    expect(TestBed.inject(OFFLINE_RUNTIME_CAPABILITIES)).toEqual({
      replicaPull: true,
      outbox: true,
    });
    expect(TestBed.inject(OFFLINE_COMMAND_EXECUTOR)).toBeInstanceOf(TestCommandExecutor);
    expect(TestBed.inject(OFFLINE_REPLICA_PULLER)).toBeInstanceOf(TestReplicaPuller);
  });
});

describe('offline capability builders', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('outbox capabilityはexecutor providerを返す', () => {
    const capability = withOfflineOutbox({ executor: TestCommandExecutor });
    expect(capability.kind).toBe('outbox');
    TestBed.configureTestingModule({ providers: [TestCommandExecutor, ...capability.providers] });
    expect(TestBed.inject(OFFLINE_COMMAND_EXECUTOR)).toBeInstanceOf(TestCommandExecutor);
  });

  it('replica pull capabilityはpuller providerを返す', () => {
    const capability = withOfflineReplicaPull(TestReplicaPuller);
    expect(capability.kind).toBe('replicaPull');
    TestBed.configureTestingModule({ providers: [TestReplicaPuller, ...capability.providers] });
    expect(TestBed.inject(OFFLINE_REPLICA_PULLER)).toBeInstanceOf(TestReplicaPuller);
  });
});
