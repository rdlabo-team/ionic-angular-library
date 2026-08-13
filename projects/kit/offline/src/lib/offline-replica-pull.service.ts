import { inject, Injectable } from '@angular/core';
import { isOfflineAggregateIntentConflict, offlineAggregateIntentMutations } from './offline-aggregate-intent-projector';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { offlineCommandWithBaseRevision } from './offline-command-executor';
import { commandFootprintKeys, OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import {
  OFFLINE_REPLICA_PROJECTOR,
  OFFLINE_REPLICA_PULLER,
  type OfflineReplicaChange,
  type OfflineReplicaPullPage,
  type OfflineReplicaReconciliationTarget,
} from './offline-replica-puller';
import {
  canonicalOfflineCommandIdentity,
  commandIdentityFromReplicaIdentity,
  commandIdentityMatchesReplicaRow,
  offlineGeneratedReplicaIdentity,
  offlineNaturalReplicaIdentity,
} from './offline-identity';
import {
  canonicalOfflineRemoteIdentity,
  normalizeOfflineNaturalKey,
  offlineNaturalKeyFromValues,
  projectOfflineReplicaValues,
  sha256OfflineReplicaSchema,
  type OfflineReplicaRemoteIdentity,
  type OfflineReplicaEntitySchema,
} from './offline-replica-schema';
import {
  OFFLINE_REPOSITORY,
  canonicalOfflineReplicaRowKey,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineReplicaRowKey,
  type OfflineScope,
} from './offline-repository';

type CollapsedOfflineReplicaChange = OfflineReplicaChange & {
  /** Last position in this page at which each command id was acknowledged. */
  acknowledgementOrdinals: Readonly<Record<string, number>>;
  /** Position of the authoritative last change retained by the collapse. */
  collapsedOrdinal: number;
};

/**
 * Pull handshake reported a replica schema version/hash that does not match the local Kit schema.
 *
 * Prefer `instanceof` (or {@link OfflineReplicaSchemaMismatchError.code}) over English message text.
 */
export class OfflineReplicaSchemaMismatchError extends Error {
  /** Stable machine-readable discriminator for fatal pull classification (pre- and post-send). */
  static readonly code = 'OFFLINE_REPLICA_SCHEMA_MISMATCH' as const;

  readonly code = OfflineReplicaSchemaMismatchError.code;

  constructor(
    readonly clientVersion: number,
    readonly clientHash: string,
    readonly serverVersion: number,
    readonly serverHash: string,
  ) {
    super(`Offline replica schema mismatch: client=${clientVersion}/${clientHash}, server=${serverVersion}/${serverHash}.`);
    this.name = 'OfflineReplicaSchemaMismatchError';
  }
}

/** Pulls authoritative server deltas into one durable local replica partition. */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaPullService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #puller = inject(OFFLINE_REPLICA_PULLER);
  readonly #projector = inject(OFFLINE_REPLICA_PROJECTOR, { optional: true });
  readonly #hooks = inject(OFFLINE_COMMAND_HOOKS);
  readonly #replicaMutations = inject(OfflineReplicaMutationCoordinator);
  #schemaHash: Promise<string> | null = null;

  async pull(scope: OfflineScope): Promise<void> {
    if (this.#options.mode === 'readCacheOnly') return;
    const storageSchemaHash = await (this.#schemaHash ??= sha256OfflineReplicaSchema(this.#options.replicaSchema));
    const wireProtocol = this.#options.wireProtocol ?? {
      version: this.#options.replicaSchema.version,
      hash: storageSchemaHash,
    };
    let persistedCursor = (await this.#repository.getReplicaCursor(scope))?.cursor ?? '';
    let requestCursor = persistedCursor;
    let rebaselinePending = false;

    for (;;) {
      const reconciliationTargets = await this.#reconciliationTargets(scope);
      const reconciliationTargetsById = new Map(reconciliationTargets.map((target) => [target.commandId, target] as const));
      const page = await this.#puller.pull({
        scope,
        cursor: requestCursor,
        schemaVersion: wireProtocol.version,
        schemaHash: wireProtocol.hash,
        reconciliationTargets,
      });
      this.#assertPullPage(page);
      this.#assertHandshake(page.schemaVersion, page.schemaHash, wireProtocol);
      if (page.hasMore && page.nextCursor === requestCursor) {
        throw new Error(`Offline replica pull cursor did not advance for scope ${scope.userId}:${scope.scopeId}.`);
      }
      if (page.changes.length === 0 && !page.hasMore && page.nextCursor === requestCursor && !rebaselinePending) {
        return;
      }
      if (page.rebaselineRequired && page.changes.length === 0 && !page.hasMore) {
        throw new Error('Offline replica rebaseline marker must lead to a snapshot page.');
      }
      if (page.rebaselineRequired && page.changes.length === 0 && page.hasMore) {
        rebaselinePending = true;
        requestCursor = page.nextCursor;
        continue;
      }

      const applied = await this.#replicaMutations.run(async (repository) => {
        const currentCursor = (await repository.getReplicaCursor(scope))?.cursor ?? '';
        if (currentCursor !== persistedCursor) return currentCursor;
        const scopeCommands = await repository.getCommands(scope);
        const userCommands = repository.getCommandsForUser ? await repository.getCommandsForUser(scope.userId) : scopeCommands;
        const changes = this.#collapseChanges(page.changes);
        const projection = await this.#projector?.project({
          scope,
          changes,
        });
        this.#assertProjection(scope, projection);
        const putRows: OfflineReplicaRow[] = [];
        const removeRows: OfflineReplicaRowKey[] = [];
        const putCommands = new Map<string, OfflineCommand>();
        const removeCommandIds = new Set<string>();
        const rematerializeAfter: OfflineCommand[] = [];
        if (rebaselinePending || page.rebaselineRequired) {
          removeRows.push(...(await this.#confirmedRowsForRebaseline(scope, userCommands)));
        }

        for (const change of changes) {
          const schema = this.#entitySchema(change.sourceKey);
          const commands = schema.scope === 'user' ? userCommands : scopeCommands;
          const acknowledged = (change.acknowledgedCommandIds ?? [])
            .map((commandId) => {
              const command = commands.find((candidate) => candidate.commandId === commandId);
              if (!command) return null;
              if (command.sourceKey !== change.sourceKey) {
                throw new Error(`Acknowledged command "${commandId}" does not target "${change.sourceKey}".`);
              }
              const requested = reconciliationTargetsById.get(commandId);
              if (command.state === 'awaiting_pull') {
                if (!requested) {
                  throw new Error(`Acknowledged command "${commandId}" was not requested for reconciliation on this pull page.`);
                }
                const schema = this.#entitySchema(change.sourceKey);
                if (
                  canonicalOfflineRemoteIdentity(schema, requested.identity) !==
                  canonicalOfflineRemoteIdentity(schema, this.#identity(change))
                ) {
                  throw new Error(`Acknowledged command "${commandId}" does not match the requested remote identity.`);
                }
              }
              return command;
            })
            .filter((command): command is OfflineCommand => command !== null);
          const acknowledgedIdentities = new Set(acknowledged.map((command) => canonicalOfflineCommandIdentity(command.identity)));
          if (acknowledgedIdentities.size > 1) {
            throw new Error(`Acknowledged commands for "${change.sourceKey}" target multiple replica identities.`);
          }
          const acknowledgedCommand = acknowledged[0];
          const acknowledgedScope = acknowledgedCommand
            ? { userId: acknowledgedCommand.userId, scopeId: acknowledgedCommand.scopeId }
            : scope;
          const acknowledgedRow = acknowledgedCommand
            ? await (this.#repository.getReplicaRowIncludingPendingDelete?.(
                acknowledgedScope,
                change.sourceKey,
                acknowledgedCommand.identity,
              ) ?? this.#repository.getReplicaRow(acknowledgedScope, change.sourceKey, acknowledgedCommand.identity))
            : null;
          if (acknowledgedCommand && !acknowledgedRow) {
            throw new Error(`Acknowledged command "${acknowledgedCommand.commandId}" has no local replica row.`);
          }
          const identity = this.#identity(change);
          const serverRow = await this.#repository.getReplicaRowByRemoteIdentity(scope, change.sourceKey, identity);
          if (
            acknowledgedRow &&
            serverRow &&
            !commandIdentityMatchesReplicaRow(schema, acknowledgedRow, commandIdentityFromReplicaIdentity(serverRow.identity))
          ) {
            if (identity.remoteId !== undefined) {
              throw new Error(`Server id ${String(identity.remoteId)} is already mapped to another local replica row.`);
            }
            throw new Error(`Remote identity for "${change.sourceKey}" is already mapped to another local replica row.`);
          }
          const existing = acknowledgedRow ?? serverRow;
          const related = existing
            ? commands.filter(
                (command) => command.sourceKey === change.sourceKey && commandIdentityMatchesReplicaRow(schema, existing, command.identity),
              )
            : [];
          const hasPending = related.length > 0;

          if (acknowledgedCommand) {
            this.#assertIdentityAssignment(schema, existing!, identity);
            this.#applyAcknowledgement(change, existing!, related, putRows, removeRows, putCommands, removeCommandIds, rematerializeAfter);
            continue;
          }

          if (change.deleted) {
            if (!existing) continue;
            if (!hasPending) {
              removeRows.push({ ...existing, identity: existing.identity });
              continue;
            }
            putRows.push({
              ...existing,
              confirmedValues: null,
              serverRevision: change.serverRevision,
              syncState: 'conflict',
              fetchedAt: Date.now(),
            });
            for (const command of related) {
              putCommands.set(command.commandId, { ...command, state: 'conflict', retryAt: null, lastErrorCode: 'remote_deleted' });
            }
            rematerializeAfter.push(related[0]!);
            continue;
          }

          const confirmedValues = this.#validatedValues(schema, change);
          if (!existing) {
            putRows.push({
              ...scope,
              sourceKey: change.sourceKey,
              identity:
                schema.identity.kind === 'naturalKey'
                  ? offlineNaturalReplicaIdentity(schema, confirmedValues)
                  : offlineGeneratedReplicaIdentity(crypto.randomUUID(), identity.remoteId ?? null),
              values: confirmedValues,
              confirmedValues,
              serverRevision: change.serverRevision,
              fetchedAt: Date.now(),
              syncState: 'confirmed',
            });
            continue;
          }

          const remaining = related.filter((command) => !removeCommandIds.has(command.commandId));
          const confirmedRow: OfflineReplicaRow = {
            ...existing,
            confirmedValues,
            serverRevision: change.serverRevision,
            fetchedAt: Date.now(),
            values: remaining.length > 0 ? existing.values : confirmedValues,
            syncState: remaining.length > 0 ? 'pending' : 'confirmed',
          };
          putRows.push(confirmedRow);
          if (remaining.length > 0) rematerializeAfter.push(remaining[0]!);
          for (const command of remaining) {
            putCommands.set(command.commandId, offlineCommandWithBaseRevision(command, change.serverRevision));
          }
        }

        const confirmedAndProjected = this.#mergeRowMutations([
          { putRows, removeRows },
          { putRows: projection?.putRows ?? [], removeRows: projection?.removeRows ?? [] },
        ]);
        const rematerialized = await this.#rematerializePendingAggregates(
          scope,
          userCommands,
          scopeCommands,
          confirmedAndProjected,
          putCommands,
          removeCommandIds,
          rematerializeAfter,
        );
        const finalRows = this.#mergeRowMutations([confirmedAndProjected, rematerialized]);
        const removedCommands = [...removeCommandIds]
          .map(
            (commandId) =>
              userCommands.find((command) => command.commandId === commandId) ??
              scopeCommands.find((command) => command.commandId === commandId),
          )
          .filter((command): command is OfflineCommand => command != null);
        await repository.transactReplica({
          putRows: finalRows.putRows,
          removeRows: finalRows.removeRows,
          putCommands: [...putCommands.values()],
          removeCommandIds: [...removeCommandIds],
          putCursors: [{ ...scope, cursor: page.nextCursor }],
        });
        await Promise.all(removedCommands.map((command) => this.#hooks.onCommandRemoved?.(command).catch(() => undefined)));
        return page.nextCursor;
      });
      if (applied !== page.nextCursor) {
        persistedCursor = applied;
        requestCursor = applied;
        rebaselinePending = false;
        continue;
      }
      persistedCursor = page.nextCursor;
      requestCursor = page.nextCursor;
      rebaselinePending = false;
      if (!page.hasMore) return;
    }
  }

  async #reconciliationTargets(scope: OfflineScope): Promise<OfflineReplicaReconciliationTarget[]> {
    const commands = (await this.#repository.getCommands(scope)).filter((command) => command.state === 'awaiting_pull');
    const targets: OfflineReplicaReconciliationTarget[] = [];
    for (const command of commands) {
      const row =
        (await this.#repository.getReplicaRowIncludingPendingDelete?.(scope, command.sourceKey, command.identity)) ??
        (await this.#repository.getReplicaRow(scope, command.sourceKey, command.identity));
      if (!row) throw new Error(`Awaiting-pull command "${command.commandId}" has no replica row.`);
      const identity =
        command.reconciliationIdentity ??
        (row.identity.kind === 'generated'
          ? row.identity.remoteId === null
            ? null
            : { remoteId: row.identity.remoteId }
          : row.identity.kind === 'natural'
            ? { naturalKey: row.identity.naturalKey }
            : null);
      if (!identity) throw new Error(`Awaiting-pull command "${command.commandId}" has no remote identity.`);
      canonicalOfflineRemoteIdentity(this.#entitySchema(command.sourceKey), identity);
      targets.push({ commandId: command.commandId, operation: command.operation, sourceKey: command.sourceKey, identity });
    }
    return targets;
  }

  async #confirmedRowsForRebaseline(scope: OfflineScope, commands: readonly OfflineCommand[]): Promise<OfflineReplicaRowKey[]> {
    const preserved = new Set(
      commands.flatMap((command) => {
        const identity =
          command.identity.kind === 'generated'
            ? offlineGeneratedReplicaIdentity(command.identity.localId, null)
            : { kind: 'natural' as const, naturalKey: command.identity.naturalKey };
        return [this.#rowKey({ ...command, identity }), ...commandFootprintKeys(command).map((key) => this.#rowKey(key))];
      }),
    );
    const rows = (
      await Promise.all(this.#options.replicaSchema.entities.map((entity) => this.#repository.getReplicaRows(scope, entity.sourceKey)))
    ).flat();
    return rows.filter((row) => row.syncState === 'confirmed' && !preserved.has(this.#rowKey(row)));
  }

  #rowKey(row: OfflineReplicaRowKey): string {
    return canonicalOfflineReplicaRowKey(this.#entitySchema(row.sourceKey), row);
  }

  #mergeRowMutations(
    layers: readonly {
      putRows: readonly OfflineReplicaRow[];
      removeRows: readonly OfflineReplicaRowKey[];
    }[],
  ): { putRows: OfflineReplicaRow[]; removeRows: OfflineReplicaRowKey[] } {
    const mutations = new Map<string, { kind: 'put'; row: OfflineReplicaRow } | { kind: 'remove'; row: OfflineReplicaRowKey }>();
    for (const layer of layers) {
      for (const row of layer.removeRows) mutations.set(this.#rowKey(row), { kind: 'remove', row });
      for (const row of layer.putRows) mutations.set(this.#rowKey(row), { kind: 'put', row });
    }
    const putRows: OfflineReplicaRow[] = [];
    const removeRows: OfflineReplicaRowKey[] = [];
    for (const mutation of mutations.values()) {
      if (mutation.kind === 'put') putRows.push(mutation.row);
      else removeRows.push(mutation.row);
    }
    return { putRows, removeRows };
  }

  #assertProjection(
    scope: OfflineScope,
    projection: { putRows?: readonly OfflineReplicaRow[]; removeRows?: readonly OfflineReplicaRowKey[] } | undefined,
  ): void {
    for (const row of [...(projection?.putRows ?? []), ...(projection?.removeRows ?? [])]) {
      const schema = this.#entitySchema(row.sourceKey);
      if (schema.identity.kind !== 'localOnly') {
        throw new Error(`Offline replica projector may only mutate localOnly source "${row.sourceKey}".`);
      }
      if (row.userId !== scope.userId || row.scopeId !== scope.scopeId || row.identity.kind !== 'local') {
        throw new Error('Offline replica projector rows must use the current scope and local identity.');
      }
    }
  }

  #assertPullPage(page: OfflineReplicaPullPage): void {
    if (typeof page.nextCursor !== 'string') {
      throw new Error('Offline replica pull page nextCursor must be a string.');
    }
    if (typeof page.hasMore !== 'boolean') {
      throw new Error('Offline replica pull page hasMore must be a boolean.');
    }
    if (!Array.isArray(page.changes)) {
      throw new Error('Offline replica pull page changes must be an array.');
    }
    if (page.rebaselineRequired !== undefined && typeof page.rebaselineRequired !== 'boolean') {
      throw new Error('Offline replica pull page rebaselineRequired must be a boolean when present.');
    }
    for (const [index, change] of page.changes.entries()) {
      this.#assertPullChange(change, index);
    }
  }

  async #rematerializePendingAggregates(
    scope: OfflineScope,
    userCommands: readonly OfflineCommand[],
    scopeCommands: readonly OfflineCommand[],
    currentRows: { putRows: readonly OfflineReplicaRow[]; removeRows: readonly OfflineReplicaRowKey[] },
    putCommands: Map<string, OfflineCommand>,
    removeCommandIds: ReadonlySet<string>,
    seeds: readonly OfflineCommand[],
  ): Promise<{ putRows: OfflineReplicaRow[]; removeRows: OfflineReplicaRowKey[] }> {
    const remaining = [...userCommands, ...scopeCommands]
      .filter((command, index, all) => all.findIndex((candidate) => candidate.commandId === command.commandId) === index)
      .filter((command) => !removeCommandIds.has(command.commandId))
      .map((command) => putCommands.get(command.commandId) ?? command);
    const affected = new Map<string, OfflineCommand>();
    for (const command of [...seeds, ...remaining]) {
      if (removeCommandIds.has(command.commandId) && !remaining.some((item) => this.#aggregateKey(item) === this.#aggregateKey(command))) {
        affected.set(this.#aggregateKey(command), command);
        continue;
      }
      if (!removeCommandIds.has(command.commandId) || seeds.some((seed) => seed.commandId === command.commandId)) {
        affected.set(this.#aggregateKey(command), command);
      }
    }
    const putRows: OfflineReplicaRow[] = [];
    const removeRows: OfflineReplicaRowKey[] = [];
    const overlay = new Map(currentRows.putRows.map((row) => [this.#rowKey(row), row] as const));
    const removed = new Set(currentRows.removeRows.map((row) => this.#rowKey(row)));
    for (const [key, seed] of affected) {
      const remainingForAggregate = remaining.filter((command) => this.#aggregateKey(command) === key);
      const existingConflict = remainingForAggregate.find((command) => command.state === 'conflict');
      const footprintCommands = [...remainingForAggregate, seed];
      const baseRow = await this.#overlayBaseRow(seed, overlay, removed);
      const persistedLocalOnlyRows = await this.#persistedLocalOnlyRows(footprintCommands);
      const localOnlyRows = await this.#overlayLocalOnlyRows(footprintCommands, overlay, removed);
      const projection = existingConflict
        ? { kind: 'conflict' as const, reason: existingConflict.lastErrorCode ?? 'remote_revision' }
        : this.#replicaMutations.projectAggregateIntent({
            baseRow,
            localOnlyRows,
            commands: remainingForAggregate,
            trigger: 'pull',
            incomingRevision: baseRow?.serverRevision ?? undefined,
          });
      if (isOfflineAggregateIntentConflict(projection)) {
        if (!baseRow) throw new Error('Offline aggregate conflict requires an authoritative base row.');
        putRows.push({ ...baseRow, values: baseRow.values, syncState: 'conflict' });
        for (const command of remainingForAggregate) {
          putCommands.set(command.commandId, {
            ...command,
            state: 'conflict',
            retryAt: null,
            lastErrorCode: projection.reason,
          });
        }
        const incomingByKey = new Map(localOnlyRows.map((row) => [this.#rowKey(row), row] as const));
        for (const previous of persistedLocalOnlyRows) {
          const incoming = incomingByKey.get(this.#rowKey(previous));
          putRows.push({
            ...(incoming ?? previous),
            values: previous.values,
            confirmedValues: incoming?.confirmedValues ?? null,
            syncState: 'conflict',
            visibility: previous.visibility,
          });
        }
        continue;
      }
      const mutations = offlineAggregateIntentMutations(projection, baseRow);
      putRows.push(...(mutations.putRows ?? []));
      removeRows.push(...(mutations.removeRows ?? []));
    }
    void scope;
    return { putRows, removeRows };
  }

  async #overlayBaseRow(
    command: OfflineCommand,
    overlay: ReadonlyMap<string, OfflineReplicaRow>,
    removed: ReadonlySet<string>,
  ): Promise<OfflineReplicaRow | null> {
    const schema = this.#entitySchema(command.sourceKey);
    const identity =
      command.identity.kind === 'generated'
        ? offlineGeneratedReplicaIdentity(command.identity.localId, null)
        : { kind: 'natural' as const, naturalKey: command.identity.naturalKey };
    const canonical = this.#rowKey({ ...command, identity });
    if (removed.has(canonical)) return null;
    const overlaid = [...overlay.values()].find(
      (row) => row.sourceKey === command.sourceKey && commandIdentityMatchesReplicaRow(schema, row, command.identity),
    );
    if (overlaid) return overlaid;
    const commandScope = { userId: command.userId, scopeId: command.scopeId };
    return (
      this.#repository.getReplicaRowIncludingPendingDelete?.(commandScope, command.sourceKey, command.identity) ??
      this.#repository.getReplicaRow(commandScope, command.sourceKey, command.identity)
    );
  }

  async #overlayLocalOnlyRows(
    commands: readonly OfflineCommand[],
    overlay: ReadonlyMap<string, OfflineReplicaRow>,
    removed: ReadonlySet<string>,
  ): Promise<OfflineReplicaRow[]> {
    const keys = new Map<string, OfflineReplicaRowKey>();
    for (const command of commands) {
      for (const key of commandFootprintKeys(command)) keys.set(this.#rowKey(key), key);
    }
    const rows: OfflineReplicaRow[] = [];
    for (const [canonical, key] of keys) {
      if (removed.has(canonical)) continue;
      const overlaid = overlay.get(canonical);
      if (overlaid) {
        rows.push(overlaid);
        continue;
      }
      const rowScope = { userId: key.userId, scopeId: key.scopeId };
      const row =
        (await this.#repository.getReplicaRowIncludingPendingDelete?.(rowScope, key.sourceKey, key.identity)) ??
        (await this.#repository.getReplicaRow(rowScope, key.sourceKey, key.identity));
      if (row) rows.push(row);
    }
    return rows;
  }

  async #persistedLocalOnlyRows(commands: readonly OfflineCommand[]): Promise<OfflineReplicaRow[]> {
    return this.#overlayLocalOnlyRows(commands, new Map(), new Set());
  }

  #aggregateKey(command: OfflineCommand): string {
    const schema = this.#entitySchema(command.sourceKey);
    const partition = schema.scope === 'user' ? 'user' : `partition:${command.scopeId}`;
    return `${command.userId}:${partition}:${command.sourceKey}:${canonicalOfflineCommandIdentity(command.identity)}`;
  }

  #assertPullChange(change: unknown, index: number): void {
    const label = `Offline replica pull page changes[${index}]`;
    if (!isPlainObject(change)) {
      throw new Error(`${label} must be a plain object.`);
    }
    if (typeof change['sourceKey'] !== 'string') {
      throw new Error(`${label}.sourceKey must be a string.`);
    }
    if (typeof change['deleted'] !== 'boolean') {
      throw new Error(`${label}.deleted must be a boolean.`);
    }
    const schema = this.#entitySchema(change['sourceKey']);
    if (schema.identity.kind === 'generated') {
      const remoteId = change['remoteId'];
      const validInteger = typeof remoteId === 'number' && Number.isSafeInteger(remoteId) && remoteId > 0;
      const validText = typeof remoteId === 'string' && remoteId.length > 0;
      if (schema.identity.affinity === 'INTEGER' ? !validInteger : !validText) {
        throw new Error(`${label}.remoteId must be a valid generated remote id.`);
      }
      if (change['naturalKey'] !== undefined) {
        throw new Error(`${label}.naturalKey must be omitted for a generated entity.`);
      }
    }
    try {
      canonicalOfflineRemoteIdentity(schema, change as unknown as OfflineReplicaRemoteIdentity);
    } catch (error) {
      throw new Error(`${label} has invalid remote identity: ${error instanceof Error ? error.message : String(error)}`);
    }
    const revision = change['serverRevision'];
    if (typeof revision !== 'string' && (typeof revision !== 'number' || !Number.isFinite(revision))) {
      throw new Error(`${label}.serverRevision must be a string or number.`);
    }
    const acknowledgedCommandIds = change['acknowledgedCommandIds'];
    if (
      (acknowledgedCommandIds !== undefined && !Array.isArray(acknowledgedCommandIds)) ||
      (Array.isArray(acknowledgedCommandIds) &&
        acknowledgedCommandIds.some((commandId) => typeof commandId !== 'string' || commandId.length === 0))
    ) {
      throw new Error(`${label}.acknowledgedCommandIds must be an array of non-empty strings.`);
    }
    if (change['deleted']) {
      if (change['values'] !== null) {
        throw new Error(`${label} with deleted=true must have null values.`);
      }
    }
  }

  #assertHandshake(version: number, hash: string, expected: { readonly version: number; readonly hash: string }): void {
    if (version !== expected.version || hash !== expected.hash) {
      throw new OfflineReplicaSchemaMismatchError(expected.version, expected.hash, version, hash);
    }
  }

  #entitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }

  #validatedValues(schema: OfflineReplicaEntitySchema<Record<string, unknown>>, change: OfflineReplicaChange): unknown {
    if (change.values === null) {
      throw new Error(
        change.remoteId === undefined
          ? `Offline replica change "${change.sourceKey}" is missing values.`
          : `Offline replica change "${change.sourceKey}"/${String(change.remoteId)} is missing values.`,
      );
    }
    const values = projectOfflineReplicaValues(schema, change.values);
    if (schema.identity.kind === 'naturalKey') {
      const expected = offlineNaturalKeyFromValues(schema, values)!;
      const incoming = normalizeOfflineNaturalKey(schema, change.naturalKey!);
      if (
        canonicalOfflineRemoteIdentity(schema, { naturalKey: expected }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: incoming })
      ) {
        throw new Error(`Offline replica change "${change.sourceKey}" naturalKey does not match values.`);
      }
    }
    return values;
  }

  #collapseChanges(changes: readonly OfflineReplicaChange[]): CollapsedOfflineReplicaChange[] {
    const collapsed = new Map<string, CollapsedOfflineReplicaChange>();
    for (const [ordinal, change] of changes.entries()) {
      const schema = this.#entitySchema(change.sourceKey);
      const key = `${change.sourceKey}:${canonicalOfflineRemoteIdentity(schema, this.#identity(change))}`;
      const previous = collapsed.get(key);
      const acknowledgedCommandIds = [...new Set([...(previous?.acknowledgedCommandIds ?? []), ...(change.acknowledgedCommandIds ?? [])])];
      const acknowledgementOrdinals = { ...(previous?.acknowledgementOrdinals ?? {}) };
      for (const commandId of change.acknowledgedCommandIds ?? []) {
        acknowledgementOrdinals[commandId] = ordinal;
      }
      collapsed.set(key, {
        ...change,
        acknowledgedCommandIds,
        acknowledgementOrdinals,
        collapsedOrdinal: ordinal,
      });
    }
    return [...collapsed.values()];
  }

  #applyAcknowledgement(
    change: CollapsedOfflineReplicaChange,
    row: OfflineReplicaRow,
    related: readonly OfflineCommand[],
    putRows: OfflineReplicaRow[],
    removeRows: OfflineReplicaRowKey[],
    putCommands: Map<string, OfflineCommand>,
    removeCommandIds: Set<string>,
    rematerializeAfter: OfflineCommand[],
  ): void {
    const acknowledgedIds = new Set(change.acknowledgedCommandIds ?? []);
    const lastAcknowledgedIndex = related.reduce((last, command, index) => (acknowledgedIds.has(command.commandId) ? index : last), -1);
    if (lastAcknowledgedIndex < 0) {
      throw new Error(`Replica acknowledgement does not match the local aggregate outbox.`);
    }
    if (related.slice(0, lastAcknowledgedIndex + 1).some((command) => !acknowledgedIds.has(command.commandId))) {
      throw new Error(`Replica acknowledgement skipped an earlier aggregate command.`);
    }
    const lastAcknowledgedCommand = related[lastAcknowledgedIndex]!;
    const acknowledgementSuperseded = (change.acknowledgementOrdinals[lastAcknowledgedCommand.commandId] ?? -1) < change.collapsedOrdinal;
    const following = related
      .slice(lastAcknowledgedIndex + 1)
      .map((command) =>
        acknowledgementSuperseded || change.deleted
          ? { ...command, state: 'conflict' as const, retryAt: null, lastErrorCode: change.deleted ? 'remote_deleted' : 'remote_revision' }
          : offlineCommandWithBaseRevision(command, change.serverRevision),
      );
    for (const command of following) putCommands.set(command.commandId, command);
    for (const command of related.slice(0, lastAcknowledgedIndex + 1)) {
      removeCommandIds.add(command.commandId);
    }
    rematerializeAfter.push(lastAcknowledgedCommand);

    if (change.deleted) {
      if (following.length > 0) {
        putRows.push({
          ...row,
          confirmedValues: null,
          serverRevision: change.serverRevision,
          syncState: 'conflict',
          visibility: following.at(-1)!.replicaMutation === 'delete' ? 'pending_delete' : 'present',
          fetchedAt: Date.now(),
        });
      } else {
        removeRows.push({ ...row, identity: row.identity });
      }
      return;
    }

    const schema = this.#entitySchema(change.sourceKey);
    const confirmedValues = this.#validatedValues(schema, change);
    this.#assertIdentityAssignment(schema, row, this.#identity(change));
    putRows.push({
      ...row,
      identity: row.identity.kind === 'generated' ? { ...row.identity, remoteId: change.remoteId ?? row.identity.remoteId } : row.identity,
      values: following.length > 0 ? row.values : confirmedValues,
      confirmedValues,
      serverRevision: change.serverRevision,
      fetchedAt: Date.now(),
      syncState: following.length > 0 ? (acknowledgementSuperseded ? 'conflict' : 'pending') : 'confirmed',
      visibility: following.at(-1)?.replicaMutation === 'delete' ? 'pending_delete' : 'present',
    });
  }

  #identity(change: OfflineReplicaChange): OfflineReplicaRemoteIdentity {
    return change.remoteId !== undefined ? { remoteId: change.remoteId } : { naturalKey: change.naturalKey! };
  }

  #assertIdentityAssignment(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    row: OfflineReplicaRow,
    incoming: OfflineReplicaRemoteIdentity,
  ): void {
    if (schema.identity.kind === 'generated') {
      const remoteId = incoming.remoteId!;
      if (row.identity.kind !== 'generated') {
        throw new Error(`Replica generated identity is required for "${schema.sourceKey}".`);
      }
      if (row.identity.remoteId !== null && row.identity.remoteId !== remoteId) {
        throw new Error(`Replica remote id is immutable: current=${String(row.identity.remoteId)}, incoming=${String(remoteId)}.`);
      }
      return;
    }
    const current = row.identity.kind === 'natural' ? row.identity.naturalKey : offlineNaturalKeyFromValues(schema, row.values);
    if (
      current !== null &&
      canonicalOfflineRemoteIdentity(schema, { naturalKey: current }) !== canonicalOfflineRemoteIdentity(schema, incoming)
    ) {
      throw new Error(`Replica naturalKey is immutable for "${schema.sourceKey}".`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
