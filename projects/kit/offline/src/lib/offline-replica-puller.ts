import { InjectionToken } from '@angular/core';
import type { OfflineScope } from './offline-repository';
import type {
  OfflineGeneratedRemoteId,
  OfflineNaturalKey,
  OfflineReplicaRemoteIdentity,
} from './offline-replica-schema';

/** Server pull request for one user or partition-scoped replica. */
export interface OfflineReplicaPullRequest {
  scope: OfflineScope;
  cursor: string;
  schemaVersion: number;
  schemaHash: string;
}

/** One server-side replica mutation returned by an explicit pull page. */
export interface OfflineReplicaChangeBase {
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

/**
 * Backend wire identity accepted at the HTTP boundary.
 *
 * `serverId` is the database-facing name used by Hono applications. The
 * offline runtime deliberately calls the same value `remoteId`, because the
 * repository is not tied to a particular server database. Normalize exactly
 * once at the transport boundary with {@link normalizeOfflineReplicaPullPage}.
 */
export type OfflineReplicaWireIdentity =
  | { readonly serverId: OfflineGeneratedRemoteId }
  | { readonly remoteId: OfflineGeneratedRemoteId }
  | { readonly naturalKey: OfflineNaturalKey };

/** One backend pull mutation before its DB-facing identity is normalized. */
export type OfflineReplicaWireChange = OfflineReplicaChangeBase & OfflineReplicaWireIdentity;

/** One explicit replica pull response page from the application backend. */
export interface OfflineReplicaPullPage {
  schemaVersion: number;
  schemaHash: string;
  changes: readonly OfflineReplicaChange[];
  nextCursor: string;
  hasMore: boolean;
}

/** Backend response accepted by the shared pull-page normalizer. */
export interface OfflineReplicaWirePullPage {
  schemaVersion: number;
  schemaHash: string;
  changes: readonly OfflineReplicaWireChange[];
  nextCursor: string;
  hasMore: boolean;
}

/**
 * Converts a backend DB identity (`serverId`) to the runtime identity
 * (`remoteId`) without allowing product pullers to each reimplement the rule.
 */
export function normalizeOfflineReplicaPullPage(page: OfflineReplicaWirePullPage): OfflineReplicaPullPage {
  return {
    ...page,
    changes: page.changes.map((change, index) => {
      if ('naturalKey' in change) return change;
      if ('serverId' in change && 'remoteId' in change) {
        throw new Error(`Offline replica pull page changes[${index}] cannot contain both serverId and remoteId.`);
      }
      if ('serverId' in change) {
        const { serverId, ...rest } = change;
        return { ...rest, remoteId: serverId };
      }
      return change;
    }),
  };
}

/** Application-provided transport that fetches explicit replica pull pages from the server. */
export interface OfflineReplicaPuller {
  pull(request: OfflineReplicaPullRequest): Promise<OfflineReplicaPullPage>;
}

/** DI token for the application-provided explicit replica pull transport. */
export const OFFLINE_REPLICA_PULLER = new InjectionToken<OfflineReplicaPuller>('OFFLINE_REPLICA_PULLER');
