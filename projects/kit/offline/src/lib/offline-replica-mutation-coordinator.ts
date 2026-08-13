import { inject, Injectable } from '@angular/core';
import {
  OFFLINE_AGGREGATE_INTENT_PROJECTOR,
  isOfflineAggregateIntentConflict,
  type OfflineAggregateIntentProjectInput,
  type OfflineAggregateIntentProjection,
  type OfflineAggregateIntentProjectResult,
} from './offline-aggregate-intent-projector';
import { canonicalOfflineReplicaIdentity, commandIdentityMatchesReplicaRow, type OfflineCommandIdentity } from './offline-identity';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  canonicalOfflineReplicaRowKey,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineReplicaRowKey,
  type OfflineScope,
} from './offline-repository';
import type { OfflineReplicaEntitySchema } from './offline-replica-schema';

/**
 * Serializes only local replica read/derive/write critical sections. Network
 * transport must stay outside this coordinator so synchronization never holds
 * the local mutation lane while waiting on I/O.
 *
 * This coordinator is the sole caller and validator of aggregate rematerialization.
 * Invoke {@link projectAggregateIntent} only from inside {@link run}; this
 * method does not acquire the lane itself.
 */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaMutationCoordinator {
  readonly #projector = inject(OFFLINE_AGGREGATE_INTENT_PROJECTOR, { optional: true });
  readonly #options = inject(OFFLINE_KIT_OPTIONS, { optional: true });
  #tail: Promise<void> = Promise.resolve();

  /** Enqueues one local replica critical section behind any in-flight mutation. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.#tail.then(operation);
    this.#tail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  /** Resolves after every currently queued replica mutation has settled. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  /**
   * Calls the product aggregate-intent projector and validates scope, schema,
   * identity, and footprints. Throws before returning when the projector is
   * missing or the projection is unsafe to write.
   *
   * @param input - Authoritative base row, current localOnly rows, and remaining commands.
   */
  projectAggregateIntent(input: OfflineAggregateIntentProjectInput): OfflineAggregateIntentProjectResult {
    if (!this.#projector) {
      throw new Error('Offline aggregate intent projector is not configured.');
    }
    if (!this.#options) {
      throw new Error('Offline aggregate intent projector requires replica schema configuration.');
    }
    const projection = this.#projector.project(input);
    if (isOfflineAggregateIntentConflict(projection)) {
      if (input.trigger !== 'pull' || input.commands.length === 0 || projection.reason.length === 0) {
        throw new Error('Offline aggregate intent conflict is valid only for pending commands during pull.');
      }
      return projection;
    }
    this.#assertAggregateIntentProjection(input, projection);
    return projection;
  }

  #assertAggregateIntentProjection(input: OfflineAggregateIntentProjectInput, projection: OfflineAggregateIntentProjection): void {
    const expected = this.#expectedAggregate(input);
    const footprint = this.#localOnlyFootprint(input);
    this.#assertBaseProjection(input, projection, expected);
    this.#assertLocalOnlyProjection(input, expected.scope, footprint, projection);
  }

  #expectedAggregate(input: OfflineAggregateIntentProjectInput): {
    scope: OfflineScope | null;
    sourceKey: string | null;
    commandIdentity: OfflineCommandIdentity | null;
  } {
    const command = input.commands[0] ?? null;
    const base = input.baseRow;
    const local = input.localOnlyRows[0] ?? null;
    const scope = base
      ? { userId: base.userId, scopeId: base.scopeId }
      : command
        ? { userId: command.userId, scopeId: command.scopeId }
        : local
          ? { userId: local.userId, scopeId: local.scopeId }
          : null;
    return {
      scope,
      sourceKey: base?.sourceKey ?? command?.sourceKey ?? null,
      commandIdentity: command?.identity ?? null,
    };
  }

  #assertBaseProjection(
    input: OfflineAggregateIntentProjectInput,
    projection: OfflineAggregateIntentProjection,
    expected: {
      scope: OfflineScope | null;
      sourceKey: string | null;
      commandIdentity: OfflineCommandIdentity | null;
    },
  ): void {
    const remaining = input.commands;
    const base = input.baseRow;
    if (remaining.length === 0) {
      if (base?.confirmedValues == null) {
        if (projection.baseRow !== null) {
          throw new Error('Offline aggregate intent projector must remove a base row whose confirmedValues are null.');
        }
        return;
      }
      this.#assertBaseRowIdentity(expected, projection.baseRow, base);
      if (!sameJson(projection.baseRow!.values, base.confirmedValues)) {
        throw new Error('Offline aggregate intent projector must restore confirmed values when no commands remain.');
      }
      if (projection.baseRow!.syncState !== 'confirmed' || (projection.baseRow!.visibility ?? 'present') !== 'present') {
        throw new Error('Offline aggregate intent projector must restore a confirmed present base row when no commands remain.');
      }
      return;
    }
    if (!projection.baseRow) {
      throw new Error('Offline aggregate intent projector must return a base row while pending commands remain.');
    }
    this.#assertBaseRowIdentity(expected, projection.baseRow, base);
    const last = remaining.at(-1)!;
    if (projection.baseRow.syncState !== 'pending') {
      throw new Error('Offline aggregate intent projector must keep a pending base row while commands remain.');
    }
    const expectedVisibility = last.replicaMutation === 'delete' ? 'pending_delete' : 'present';
    if ((projection.baseRow.visibility ?? 'present') !== expectedVisibility) {
      throw new Error('Offline aggregate intent projector must match remaining replica visibility.');
    }
  }

  #assertBaseRowIdentity(
    expected: {
      scope: OfflineScope | null;
      sourceKey: string | null;
      commandIdentity: OfflineCommandIdentity | null;
    },
    row: OfflineReplicaRow | null,
    inputBase: OfflineReplicaRow | null,
  ): void {
    if (!row || !expected.scope || !expected.sourceKey) {
      throw new Error('Offline aggregate intent projector base row must keep the aggregate identity.');
    }
    const schema = this.#entitySchema(expected.sourceKey);
    if (schema.identity.kind === 'localOnly') {
      throw new Error(`Offline aggregate intent projector cannot rematerialize localOnly source "${expected.sourceKey}".`);
    }
    if (row.userId !== expected.scope.userId || row.scopeId !== expected.scope.scopeId || row.sourceKey !== expected.sourceKey) {
      throw new Error('Offline aggregate intent projector base row must use the current scope and source.');
    }
    if (inputBase) {
      if (!sameJson(row.confirmedValues, inputBase.confirmedValues) || row.serverRevision !== inputBase.serverRevision) {
        throw new Error('Offline aggregate intent projector base row must keep confirmedValues.');
      }
      if (canonicalOfflineReplicaIdentity(row.identity) !== canonicalOfflineReplicaIdentity(inputBase.identity)) {
        throw new Error('Offline aggregate intent projector base row must keep the aggregate identity.');
      }
      return;
    }
    if (row.confirmedValues !== null) {
      throw new Error('Offline aggregate intent projector base row must keep confirmedValues.');
    }
    if (!expected.commandIdentity || !commandIdentityMatchesReplicaRow(schema, row, expected.commandIdentity)) {
      throw new Error('Offline aggregate intent projector base row must keep the aggregate identity.');
    }
  }

  #assertLocalOnlyProjection(
    input: OfflineAggregateIntentProjectInput,
    scope: OfflineScope | null,
    footprint: ReadonlySet<string>,
    projection: OfflineAggregateIntentProjection,
  ): void {
    const currentByKey = new Map(
      input.localOnlyRows.map((row) => [canonicalOfflineReplicaRowKey(this.#entitySchema(row.sourceKey), row), row] as const),
    );
    const putRows = projection.putLocalOnlyRows ?? [];
    const removeRows = projection.removeLocalOnlyRows ?? [];
    const seen = new Set<string>();
    for (const row of putRows) {
      const key = this.#assertLocalOnlyMutation(scope, footprint, row);
      if (seen.has(key)) throw new Error(`Offline aggregate intent projector contains duplicate localOnly row ${key}.`);
      const current = currentByKey.get(key);
      if (!sameJson(row.confirmedValues, current?.confirmedValues ?? null)) {
        throw new Error('Offline aggregate intent projector localOnly rows must keep confirmedValues.');
      }
      seen.add(key);
    }
    for (const row of removeRows) {
      const key = this.#assertLocalOnlyMutation(scope, footprint, row);
      if (seen.has(key)) throw new Error(`Offline aggregate intent projector contains duplicate localOnly row ${key}.`);
      seen.add(key);
    }
    if (seen.size !== footprint.size) {
      throw new Error('Offline aggregate intent projector must cover every localOnly footprint exactly once.');
    }
  }

  #assertLocalOnlyMutation(scope: OfflineScope | null, footprint: ReadonlySet<string>, row: OfflineReplicaRowKey): string {
    const schema = this.#entitySchema(row.sourceKey);
    if (schema.identity.kind !== 'localOnly') {
      throw new Error(`Offline aggregate intent projector may only mutate localOnly source "${row.sourceKey}".`);
    }
    if (!scope || row.userId !== scope.userId || row.scopeId !== scope.scopeId || row.identity.kind !== 'local') {
      throw new Error('Offline aggregate intent projector rows must use the current scope and local identity.');
    }
    const key = canonicalOfflineReplicaRowKey(schema, row);
    if (!footprint.has(key)) {
      throw new Error(`Offline aggregate intent projector changed undeclared localOnly row ${key}.`);
    }
    return key;
  }

  #localOnlyFootprint(input: OfflineAggregateIntentProjectInput): Set<string> {
    const keys = new Set<string>();
    for (const row of input.localOnlyRows) {
      keys.add(canonicalOfflineReplicaRowKey(this.#entitySchema(row.sourceKey), row));
    }
    for (const command of input.commands) {
      for (const key of commandFootprintKeys(command)) {
        keys.add(canonicalOfflineReplicaRowKey(this.#entitySchema(key.sourceKey), key));
      }
    }
    return keys;
  }

  #entitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options?.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }
}

/** Declared localOnly keys persisted on one Outbox command. */
export function commandFootprintKeys(command: Pick<OfflineCommand, 'localOnlyFootprint'>): readonly OfflineReplicaRowKey[] {
  return command.localOnlyFootprint ?? [];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
