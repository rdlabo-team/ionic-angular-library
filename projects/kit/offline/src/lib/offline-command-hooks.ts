import { InjectionToken } from '@angular/core';
import type { OfflineCommand } from './offline-repository';

/** Optional product hooks for entity projection and command cleanup. */
export interface OfflineCommandHooks {
  entityType(command: Pick<OfflineCommand, 'operation' | 'aggregateType'>): string;
  onCommandRemoved?(command: OfflineCommand): Promise<void>;
}

export const DEFAULT_OFFLINE_COMMAND_HOOKS: OfflineCommandHooks = {
  entityType: (command) => command.aggregateType,
};

/** DI token for optional product-specific synchronization hooks. */
export const OFFLINE_COMMAND_HOOKS = new InjectionToken<OfflineCommandHooks>('OFFLINE_COMMAND_HOOKS', {
  providedIn: 'root',
  factory: () => DEFAULT_OFFLINE_COMMAND_HOOKS,
});
