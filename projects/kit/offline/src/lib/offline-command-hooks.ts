import { InjectionToken } from '@angular/core';
import type { OfflineCommand } from './offline-repository';

export interface OfflineCommandHooks {
  cacheEntityType(command: Pick<OfflineCommand, 'operation' | 'aggregateType'>): string;
  shouldUpdateCache(command: OfflineCommand, result: { serverRevision?: string | number; response?: unknown }): boolean;
  onCommandRemoved?(command: OfflineCommand): Promise<void>;
}

export const DEFAULT_OFFLINE_COMMAND_HOOKS: OfflineCommandHooks = {
  cacheEntityType: (command) => command.aggregateType,
  shouldUpdateCache: () => true,
};

export const OFFLINE_COMMAND_HOOKS = new InjectionToken<OfflineCommandHooks>('OFFLINE_COMMAND_HOOKS', {
  providedIn: 'root',
  factory: () => DEFAULT_OFFLINE_COMMAND_HOOKS,
});
