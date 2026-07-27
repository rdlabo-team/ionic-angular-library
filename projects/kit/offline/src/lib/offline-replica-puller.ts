import { InjectionToken } from '@angular/core';
import type { OfflineScope } from './offline-repository';
import type { OfflineReplicaRemoteIdentity } from './offline-replica-schema';

/** Server pull request for one user or partition-scoped replica. */
export interface OfflineReplicaPullRequest {
  scope: OfflineScope;
  cursor: string;
  schemaVersion: number;
  schemaHash: string;
}

/** One server-side replica mutation returned by an explicit pull page. */
interface OfflineReplicaChangeBase {
  sourceKey: string;
  serverRevision: string | number;
  /**
   * Idempotency command ids durably recorded by the server and reflected in this final row state.
   * They may include commands from other clients; the runtime correlates only ids in its local Outbox.
   */
  acknowledgedCommandIds?: readonly string[];
  values: unknown | null;
  deleted: boolean;
}

/** One server-side mutation with the identity kind declared by its replica schema. */
export type OfflineReplicaChange = OfflineReplicaChangeBase & OfflineReplicaRemoteIdentity;

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
