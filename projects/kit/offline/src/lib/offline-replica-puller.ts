import { InjectionToken } from '@angular/core';
import type { OfflineScope } from './offline-repository';

/** Server pull request for one user/group replica partition. */
export interface OfflineReplicaPullRequest {
  scope: OfflineScope;
  cursor: string;
  schemaVersion: number;
  schemaHash: string;
}

/** One server-side replica mutation returned by an explicit pull page. */
export interface OfflineReplicaChange {
  sourceKey: string;
  serverId: number;
  serverRevision: string | number;
  /** Idempotency command ids durably recorded by the server and reflected in this final row state. */
  acknowledgedCommandIds?: readonly string[];
  values: unknown | null;
  deleted: boolean;
}

/** One explicit replica pull response page from the application backend. */
export interface OfflineReplicaPullPage {
  schemaVersion: number;
  schemaHash: string;
  changes: readonly OfflineReplicaChange[];
  nextCursor: string;
  hasMore: boolean;
}

/** Application-provided transport that fetches explicit replica pull pages from the server. */
export interface OfflineReplicaPuller {
  pull(request: OfflineReplicaPullRequest): Promise<OfflineReplicaPullPage>;
}

/** DI token for the application-provided explicit replica pull transport. */
export const OFFLINE_REPLICA_PULLER = new InjectionToken<OfflineReplicaPuller>('OFFLINE_REPLICA_PULLER');
