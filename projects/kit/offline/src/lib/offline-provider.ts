import type { EnvironmentProviders, Provider, Type } from '@angular/core';
import { inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { OfflineCommandExecutor } from './offline-command-executor';
import { OFFLINE_COMMAND_EXECUTOR, OFFLINE_SYNC_CONTEXT } from './offline-command-executor';
import type { OfflineCommandHooks } from './offline-command-hooks';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import type { OfflineKitOptions } from './offline-kit-options';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineCoordinatorService } from './offline-coordinator.service';
import { IonicOfflineRepository, OFFLINE_REPOSITORY, selectOfflineRepository } from './offline-repository';
import type { OfflineRequestPolicy } from './offline-request-policy';
import { provideOfflineRequestPolicy } from './offline-request-policy';
import { OfflineSessionService } from './offline-session.service';
import { SqliteOfflineRepository } from './sqlite-offline-repository';

/** Configuration for the standard offline repository, outbox, and request-policy runtime. */
export interface ProvideOfflineOptions extends OfflineKitOptions {
  /** Product adapter that sends opaque commands to its API. */
  commandExecutor: Type<OfflineCommandExecutor>;
  /** Product policies that map URLs and DTOs to generic cache/outbox operations. */
  requestPolicies: readonly Type<OfflineRequestPolicy>[];
  /** Optional product hooks for cache projection and command cleanup. */
  commandHooks?: Type<OfflineCommandHooks>;
  /** Optional additional providers required by product adapters. */
  providers?: readonly Provider[];
}

/**
 * Provide the standard scoped offline runtime.
 *
 * @remarks
 * Web uses Ionic Storage. Native iOS/Android uses encrypted Capacitor SQLite. The application owns
 * URL/DTO policy and command execution; the kit owns persistence, ordering, retries, and session
 * isolation.
 */
export function provideOffline(options: ProvideOfflineOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    options.commandExecutor,
    { provide: OFFLINE_KIT_OPTIONS, useValue: { databaseName: options.databaseName } },
    {
      provide: OFFLINE_REPOSITORY,
      useFactory: () => selectOfflineRepository(Capacitor.getPlatform(), inject(IonicOfflineRepository), inject(SqliteOfflineRepository)),
    },
    { provide: OFFLINE_SYNC_CONTEXT, useExisting: OfflineSessionService },
    { provide: OFFLINE_COMMAND_EXECUTOR, useExisting: options.commandExecutor },
    ...(options.commandHooks ? [options.commandHooks, { provide: OFFLINE_COMMAND_HOOKS, useExisting: options.commandHooks }] : []),
    ...options.requestPolicies.flatMap((policy) => provideOfflineRequestPolicy(policy)),
    ...(options.providers ?? []),
    provideAppInitializer(() => inject(OfflineCoordinatorService).initialize()),
  ]);
}
