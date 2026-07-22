import { InjectionToken } from '@angular/core';
import type { OfflineCommand, OfflineScope } from './offline-repository';

/** Server acknowledgement used to reconcile one optimistic local mutation. */
export interface OfflineCommandResult {
  /** AUTO_INCREMENT id returned by a successful create. */
  serverId?: number;
  serverRevision?: string | number;
  /** Full server-confirmed domain values after applying the mutation. */
  confirmedValues?: unknown;
  /** Removes the local replica row after a confirmed server delete. */
  removeReplica?: boolean;
  response?: unknown;
}

/** Target ids resolved from the local replica immediately before transport. */
export interface OfflineCommandTarget {
  localId: string;
  serverId: number | null;
}

/** 不透明なoperationを製品APIへ送信し、local replicaへ投影するadapter。 */
/** Product adapter that sends commands and projects acknowledgements into entities. */
export interface OfflineCommandExecutor {
  execute(command: OfflineCommand, target: OfflineCommandTarget): Promise<OfflineCommandResult>;
  withServerRevision(command: OfflineCommand, revision: string | number): OfflineCommand;
}

/** DI token for the product-specific command transport adapter. */
export const OFFLINE_COMMAND_EXECUTOR = new InjectionToken<OfflineCommandExecutor>('OFFLINE_COMMAND_EXECUTOR');

/** Authenticated user and group scopes currently eligible for synchronization. */
export interface OfflineSyncSession {
  userId: number;
  scopes: OfflineScope[];
}

/** Product adapter that exposes the currently authenticated synchronization session. */
export interface OfflineSyncContext {
  getSession(): Promise<OfflineSyncSession | null>;
}

/** DI token for authenticated synchronization context. */
export const OFFLINE_SYNC_CONTEXT = new InjectionToken<OfflineSyncContext>('OFFLINE_SYNC_CONTEXT');
