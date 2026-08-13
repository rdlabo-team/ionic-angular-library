import { InjectionToken } from '@angular/core';
import type { OfflineCommand, OfflineReplicaRow, OfflineReplicaRowKey, OfflineReplicaTransaction } from './offline-repository';

/**
 * Authoritative inputs for rematerializing one aggregate from its remaining
 * ordered Outbox chain.
 *
 * `baseRow` is the current replica row for the aggregate, including its latest
 * `confirmedValues`. `localOnlyRows` are the current localOnly projection rows
 * owned by that aggregate. `commands` is the complete remaining FIFO chain
 * after the triggering mutation.
 */
export interface OfflineAggregateIntentProjectInput {
  /** Current aggregate base replica row, or `null` when the row is absent. */
  readonly baseRow: OfflineReplicaRow | null;
  /** Current authoritative localOnly projection rows for this aggregate. */
  readonly localOnlyRows: readonly OfflineReplicaRow[];
  /** Complete remaining ordered pending command chain for this aggregate. */
  readonly commands: readonly OfflineCommand[];
  /** Boundary that requested rematerialization. Only pull may return a conflict outcome. */
  readonly trigger?: 'local' | 'pull';
  /** Incoming authoritative revision when `trigger` is `pull`. */
  readonly incomingRevision?: string | number;
}

/**
 * Fully rematerialized aggregate projection.
 *
 * Kit writes `baseRow` as the sole base mutation (`null` removes the row) and
 * applies only the localOnly put/remove lists. Domain folding belongs here;
 * Kit never interprets command payloads.
 */
export interface OfflineAggregateIntentProjection {
  /** Rematerialized base replica row, or `null` to remove the aggregate row. */
  readonly baseRow: OfflineReplicaRow | null;
  /** LocalOnly projection rows to upsert for this aggregate. */
  readonly putLocalOnlyRows?: readonly OfflineReplicaRow[];
  /** LocalOnly projection rows to remove for this aggregate. */
  readonly removeLocalOnlyRows?: readonly OfflineReplicaRowKey[];
}

/** Product decision that pending intents cannot be replayed onto an incoming authoritative revision. */
export interface OfflineAggregateIntentConflict {
  readonly kind: 'conflict';
  readonly reason: string;
}

/** Result of product-owned aggregate rematerialization. */
export type OfflineAggregateIntentProjectResult = OfflineAggregateIntentProjection | OfflineAggregateIntentConflict;

/**
 * Product-owned pure rematerialization of one aggregate.
 *
 * Given the authoritative base row, current localOnly projection rows, and the
 * remaining ordered {@link OfflineCommand} chain, return one fully materialized
 * base row plus localOnly put/remove mutations. The adapter must derive only
 * from confirmed base/localOnly values plus complete FIFO pending intents. It
 * must not perform I/O; Kit supplies already-read replica state and validates
 * scope, schema, identity, and footprints before writing.
 */
export interface OfflineAggregateIntentProjector {
  /** Rematerializes one aggregate from authoritative replica state and remaining intents. */
  project(input: OfflineAggregateIntentProjectInput): OfflineAggregateIntentProjectResult;
}

/** Returns whether the projector rejected replay onto an authoritative pull revision. */
export function isOfflineAggregateIntentConflict(result: OfflineAggregateIntentProjectResult): result is OfflineAggregateIntentConflict {
  return 'kind' in result && result.kind === 'conflict';
}

/** Required product adapter for aggregate rematerialization from remaining Outbox intents. */
export const OFFLINE_AGGREGATE_INTENT_PROJECTOR = new InjectionToken<OfflineAggregateIntentProjector>('OFFLINE_AGGREGATE_INTENT_PROJECTOR');

/**
 * Converts a validated aggregate projection into replica put/remove mutations.
 *
 * @param projection - Rematerialized aggregate returned by the product projector.
 * @param baseRow - Current aggregate base row, used when the projection removes it.
 */
export function offlineAggregateIntentMutations(
  projection: OfflineAggregateIntentProjection,
  baseRow: OfflineReplicaRow | null,
): Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'> {
  const putRows: OfflineReplicaRow[] = [];
  const removeRows: OfflineReplicaRowKey[] = [];
  if (projection.baseRow) putRows.push(projection.baseRow);
  else if (baseRow) {
    removeRows.push({
      userId: baseRow.userId,
      scopeId: baseRow.scopeId,
      sourceKey: baseRow.sourceKey,
      identity: baseRow.identity,
    });
  }
  putRows.push(...(projection.putLocalOnlyRows ?? []));
  removeRows.push(...(projection.removeLocalOnlyRows ?? []));
  return { putRows, removeRows };
}
