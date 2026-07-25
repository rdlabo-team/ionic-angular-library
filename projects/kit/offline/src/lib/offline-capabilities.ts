import type { Provider, Type } from '@angular/core';
import { InjectionToken } from '@angular/core';
import type { OfflineCommandExecutor } from './offline-command-executor';
import { OFFLINE_COMMAND_EXECUTOR } from './offline-command-executor';
import type { OfflineCommandHooks } from './offline-command-hooks';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import type { OfflineRequestPolicy } from './offline-request-policy';
import { provideOfflineRequestPolicy } from './offline-request-policy';
import type { OfflineReplicaPuller } from './offline-replica-puller';
import { OFFLINE_REPLICA_PULLER } from './offline-replica-puller';

/** Enabled offline runtime features resolved from `provideOffline` configuration. */
export interface OfflineRuntimeCapabilities {
  /** Explicit server delta pull transport is configured. */
  replicaPull: boolean;
  /** Durable outbox enqueue and replay transport is configured. */
  outbox: boolean;
}

/** DI token for runtime offline capability flags. */
export const OFFLINE_RUNTIME_CAPABILITIES = new InjectionToken<OfflineRuntimeCapabilities>('OFFLINE_RUNTIME_CAPABILITIES', {
  providedIn: 'root',
  factory: () => ({
    replicaPull: true,
    outbox: true,
  }),
});

/** Tagged offline capability kinds registered through `provideOffline`. */
export type OfflineCapabilityKind = 'replicaPull' | 'outbox' | 'readFallback';

/** One tagged offline capability and its DI providers. */
export interface OfflineCapability<TKind extends OfflineCapabilityKind = OfflineCapabilityKind> {
  readonly kind: TKind;
  readonly providers: readonly Provider[];
}

/** Registers explicit replica pull transport. */
export function withOfflineReplicaPull(puller: Type<OfflineReplicaPuller>): OfflineCapability<'replicaPull'> {
  return {
    kind: 'replicaPull',
    providers: [puller, { provide: OFFLINE_REPLICA_PULLER, useExisting: puller }],
  };
}

/** Registers durable outbox transport and optional projection hooks. */
export function withOfflineOutbox(options: {
  executor: Type<OfflineCommandExecutor>;
  hooks?: Type<OfflineCommandHooks>;
}): OfflineCapability<'outbox'> {
  const providers: Provider[] = [options.executor, { provide: OFFLINE_COMMAND_EXECUTOR, useExisting: options.executor }];
  if (options.hooks) {
    providers.push(options.hooks, { provide: OFFLINE_COMMAND_HOOKS, useExisting: options.hooks });
  }
  return { kind: 'outbox', providers };
}

/** Registers one or more HTTP read policies for the offline interceptor. */
export function withOfflineReadFallback(...policies: readonly Type<OfflineRequestPolicy>[]): OfflineCapability<'readFallback'> {
  return {
    kind: 'readFallback',
    providers: policies.flatMap((policy) => provideOfflineRequestPolicy(policy)),
  };
}

/** Raised when an operation requires a capability that was not configured. */
export class OfflineCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineCapabilityError';
  }
}
