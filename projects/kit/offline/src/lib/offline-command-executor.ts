import { InjectionToken } from '@angular/core';
import type { OfflineCommand, OfflineEntity, OfflineScope } from './offline-repository';

export interface OfflineCommandResult {
  serverRevision?: string | number;
  response?: unknown;
}

/** 不透明なoperationを製品APIへ送信し、cacheへ投影するadapter。 */
export interface OfflineCommandExecutor {
  execute(command: OfflineCommand): Promise<OfflineCommandResult>;
  withServerRevision(command: OfflineCommand, revision: string | number): OfflineCommand;
  projectEntity?(command: OfflineCommand, entity: OfflineEntity, result: OfflineCommandResult): OfflineEntity;
}

export const OFFLINE_COMMAND_EXECUTOR = new InjectionToken<OfflineCommandExecutor>('OFFLINE_COMMAND_EXECUTOR');

export interface OfflineSyncSession {
  userId: number;
  scopes: OfflineScope[];
}

export interface OfflineSyncContext {
  getSession(): Promise<OfflineSyncSession | null>;
}

export const OFFLINE_SYNC_CONTEXT = new InjectionToken<OfflineSyncContext>('OFFLINE_SYNC_CONTEXT');
