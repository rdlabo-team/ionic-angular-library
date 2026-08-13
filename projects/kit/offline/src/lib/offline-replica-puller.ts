import { InjectionToken } from '@angular/core';
import type { OfflineReplicaRow, OfflineReplicaRowKey, OfflineScope } from './offline-repository';
import type { OfflineGeneratedRemoteId, OfflineNaturalKey, OfflineReplicaRemoteIdentity } from './offline-replica-schema';

/** Server pull request for one user or partition-scoped replica. */
export interface OfflineReplicaPullRequest {
  scope: OfflineScope;
  cursor: string;
  schemaVersion: number;
  schemaHash: string;
  /**
   * Successfully transported commands that still require an authoritative row acknowledgement.
   * The server must hydrate and authorize each target from primary state and acknowledge it only
   * on the returned reconciliation change; it must never trust this client identity as proof.
   */
  reconciliationTargets: readonly OfflineReplicaReconciliationTarget[];
}

/** One awaiting-pull command whose canonical state must be hydrated independently of journal retention. */
export interface OfflineReplicaReconciliationTarget {
  readonly commandId: string;
  readonly operation: string;
  readonly sourceKey: string;
  readonly identity: OfflineReplicaRemoteIdentity;
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
  /** The server can no longer continue this cursor and requires a confirmed-state snapshot rebuild. */
  rebaselineRequired?: boolean;
}

/** Product projection derived from one collapsed authoritative pull page. */
export interface OfflineReplicaPullProjection {
  putRows?: readonly OfflineReplicaRow[];
  removeRows?: readonly OfflineReplicaRowKey[];
}

/** Pure product adapter for local-only projections derived from server replica changes. */
export interface OfflineReplicaProjector {
  project(input: {
    scope: OfflineScope;
    changes: readonly OfflineReplicaChange[];
    commands: readonly import('./offline-repository').OfflineCommand[];
    repository: import('./offline-repository').OfflineRepository;
  }): Promise<OfflineReplicaPullProjection>;
}

/** Backend response accepted by the shared pull-page normalizer. */
export interface OfflineReplicaWirePullPage {
  schemaVersion: number;
  schemaHash: string;
  changes: readonly OfflineReplicaWireChange[];
  nextCursor: string;
  hasMore: boolean;
  /** The server can no longer continue this cursor and requires a confirmed-state snapshot rebuild. */
  rebaselineRequired?: boolean;
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

/** Optional product adapter for local-only replica projections. */
export const OFFLINE_REPLICA_PROJECTOR = new InjectionToken<OfflineReplicaProjector>('OFFLINE_REPLICA_PROJECTOR');
