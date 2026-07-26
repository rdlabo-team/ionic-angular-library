import type { EnvironmentProviders, Provider, Type } from '@angular/core';
import { inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { OfflineCommandExecutor } from './offline-command-executor';
import { OFFLINE_COMMAND_EXECUTOR, OFFLINE_SYNC_CONTEXT } from './offline-command-executor';
import type { OfflineCommandHooks } from './offline-command-hooks';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import type { OfflineCapability, OfflineRuntimeCapabilities } from './offline-capabilities';
import { OfflineCapabilityError, OFFLINE_RUNTIME_CAPABILITIES } from './offline-capabilities';
import type { OfflineKitOptions } from './offline-kit-options';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineCoordinatorService } from './offline-coordinator.service';
import { IonicOfflineRepository, OFFLINE_REPOSITORY, selectOfflineRepository } from './offline-repository';
import type { OfflineRequestPolicy } from './offline-request-policy';
import { provideOfflineRequestPolicy } from './offline-request-policy';
import type { OfflineReplicaPuller } from './offline-replica-puller';
import { OFFLINE_REPLICA_PULLER } from './offline-replica-puller';
import { OfflineSessionService } from './offline-session.service';
import {
  COMMUNITY_SQLITE,
  type CommunitySqliteConnection,
  createCommunitySqliteDriver,
  SqliteOfflineRepository,
} from './sqlite-offline-repository';

/** Shared offline runtime settings for legacy and capability-based setup. */
export interface ProvideOfflineBaseOptions extends OfflineKitOptions {
  /** Optional additional providers required by product adapters. */
  providers?: readonly Provider[];
  /** Application-installed `@capacitor-community/sqlite` connection. Required only on iOS and Android. */
  sqliteConnection?: CommunitySqliteConnection;
}

/** Existing full-runtime configuration with explicit adapter types. */
export interface ProvideOfflineOptions extends ProvideOfflineBaseOptions {
  /** Product adapter that sends opaque commands to its API. */
  commandExecutor: Type<OfflineCommandExecutor>;
  /** Product transport for explicit cursor-based server delta pulls. */
  replicaPuller: Type<OfflineReplicaPuller>;
  /** Product policies that map URLs and DTOs to generic replica/outbox operations. */
  requestPolicies: readonly Type<OfflineRequestPolicy>[];
  /** Optional product hooks for entity projection and command cleanup. */
  commandHooks?: Type<OfflineCommandHooks>;
}

/** Explicit alias for the existing full-runtime configuration. */
export type ProvideOfflineLegacyOptions = ProvideOfflineOptions;

/** Capability-based `provideOffline` configuration without dummy adapters. */
export interface ProvideOfflineCapabilityOptions extends ProvideOfflineBaseOptions {
  /** Tagged offline capabilities to enable. */
  capabilities: readonly OfflineCapability[];
}

/** Accepted legacy or capability-based configuration for the offline runtime. */
export type ProvideOfflineConfiguration = ProvideOfflineOptions | ProvideOfflineCapabilityOptions;

const DISABLED_OFFLINE_COMMAND_EXECUTOR: OfflineCommandExecutor = {
  execute: async () => {
    throw new OfflineCapabilityError('Offline outbox capability is not enabled.');
  },
  withServerRevision: (command) => command,
};

const DISABLED_OFFLINE_REPLICA_PULLER: OfflineReplicaPuller = {
  pull: async () => {
    throw new OfflineCapabilityError('Offline replica pull capability is not enabled.');
  },
};

/**
 * Provide the standard scoped offline runtime.
 *
 * @remarks
 * Web uses Ionic Storage. Native iOS/Android uses encrypted `@capacitor-community/sqlite`. The application owns
 * URL/DTO policy and command execution; the kit owns persistence, ordering, retries, and session
 * isolation.
 */
export function provideOffline(options: ProvideOfflineConfiguration): EnvironmentProviders {
  const { runtime, adapterProviders } = resolveOfflineSetup(options);
  return makeEnvironmentProviders([
    {
      provide: OFFLINE_KIT_OPTIONS,
      useValue: {
        databaseName: options.databaseName,
        createEncryptionKey: options.createEncryptionKey,
        replicaSchema: options.replicaSchema,
      },
    },
    {
      provide: OFFLINE_RUNTIME_CAPABILITIES,
      useValue: runtime,
    },
    {
      provide: COMMUNITY_SQLITE,
      useValue: options.sqliteConnection ? createCommunitySqliteDriver(options.sqliteConnection) : null,
    },
    {
      provide: OFFLINE_REPOSITORY,
      useFactory: () => selectOfflineRepository(Capacitor.getPlatform(), inject(IonicOfflineRepository), inject(SqliteOfflineRepository)),
    },
    { provide: OFFLINE_SYNC_CONTEXT, useExisting: OfflineSessionService },
    ...adapterProviders,
    ...(options.providers ?? []),
    provideAppInitializer(() => inject(OfflineCoordinatorService).initialize()),
  ]);
}

/** Resolves runtime flags and adapter providers from legacy or capability-based setup. */
export function resolveOfflineSetup(options: ProvideOfflineConfiguration): {
  runtime: OfflineRuntimeCapabilities;
  adapterProviders: Provider[];
} {
  if ('capabilities' in options && options.capabilities !== undefined) {
    const runtime = {
      replicaPull: options.capabilities.some((capability) => capability.kind === 'replicaPull'),
      outbox: options.capabilities.some((capability) => capability.kind === 'outbox'),
    };
    for (const kind of ['replicaPull', 'outbox'] as const) {
      if (options.capabilities.filter((capability) => capability.kind === kind).length > 1) {
        throw new Error(`provideOffline accepts at most one ${kind} capability.`);
      }
    }
    const adapterProviders: Provider[] = [...options.capabilities.flatMap((capability) => capability.providers)];
    if (!runtime.outbox) {
      adapterProviders.push({ provide: OFFLINE_COMMAND_EXECUTOR, useValue: DISABLED_OFFLINE_COMMAND_EXECUTOR });
    }
    if (!runtime.replicaPull) {
      adapterProviders.push({ provide: OFFLINE_REPLICA_PULLER, useValue: DISABLED_OFFLINE_REPLICA_PULLER });
    }
    return { runtime, adapterProviders };
  }

  const legacy = options as ProvideOfflineOptions;
  const adapterProviders: Provider[] = [
    legacy.commandExecutor,
    legacy.replicaPuller,
    { provide: OFFLINE_COMMAND_EXECUTOR, useExisting: legacy.commandExecutor },
    { provide: OFFLINE_REPLICA_PULLER, useExisting: legacy.replicaPuller },
    ...legacy.requestPolicies.flatMap((policy) => provideOfflineRequestPolicy(policy)),
  ];
  if (legacy.commandHooks) {
    adapterProviders.push(legacy.commandHooks, { provide: OFFLINE_COMMAND_HOOKS, useExisting: legacy.commandHooks });
  }
  return {
    runtime: { replicaPull: true, outbox: true },
    adapterProviders,
  };
}
