import { inject, Injectable } from '@angular/core';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OFFLINE_COMMAND_EXECUTOR } from './offline-command-executor';
import { OFFLINE_REPLICA_PULLER, type OfflineReplicaChange, type OfflineReplicaPullPage } from './offline-replica-puller';
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

/** Pulls authoritative server deltas into one durable local replica partition. */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaPullService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #puller = inject(OFFLINE_REPLICA_PULLER);
  readonly #executor = inject(OFFLINE_COMMAND_EXECUTOR);
  #schemaHash: Promise<string> | null = null;

  async pull(scope: OfflineScope): Promise<void> {
    if (this.#options.mode === 'readCacheOnly') return;
    const schemaHash = await (this.#schemaHash ??= sha256OfflineReplicaSchema(this.#options.replicaSchema));
    let cursor = (await this.#repository.getReplicaCursor(scope))?.cursor ?? '';

    for (;;) {
      const page = await this.#puller.pull({
        scope,
        cursor,
        schemaVersion: this.#options.replicaSchema.version,
        schemaHash,
      });
      this.#assertPullPage(page);
      this.#assertHandshake(page.schemaVersion, page.schemaHash, schemaHash);
      if (page.hasMore && page.nextCursor === cursor) {
        throw new Error(`Offline replica pull cursor did not advance for scope ${scope.userId}:${scope.scopeId}.`);
      }

      const scopeCommands = await this.#repository.getCommands(scope);
      const userCommands = this.#repository.getCommandsForUser ? await this.#repository.getCommandsForUser(scope.userId) : scopeCommands;
      const changes = this.#collapseChanges(page.changes);
      const putRows: OfflineReplicaRow[] = [];
      const removeRows: OfflineReplicaRowKey[] = [];
      const putCommands = new Map<string, OfflineCommand>();
      const removeCommandIds = new Set<string>();

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
          this.#applyAcknowledgement(change, existing!, related, putRows, removeRows, putCommands, removeCommandIds);
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

        const conflicted = related.some((command) => command.baseRevision !== change.serverRevision);
        putRows.push({
          ...existing,
          values: hasPending ? existing.values : confirmedValues,
          confirmedValues,
          serverRevision: change.serverRevision,
          fetchedAt: Date.now(),
          syncState: conflicted ? 'conflict' : hasPending ? 'pending' : 'confirmed',
        });
        if (conflicted) {
          for (const command of related) {
            putCommands.set(command.commandId, {
              ...command,
              state: 'conflict',
              retryAt: null,
              lastErrorCode: 'remote_revision',
            });
          }
        }
      }

      await this.#repository.transactReplica({
        putRows,
        removeRows,
        putCommands: [...putCommands.values()],
        removeCommandIds: [...removeCommandIds],
        putCursors: [{ ...scope, cursor: page.nextCursor }],
      });
      cursor = page.nextCursor;
      if (!page.hasMore) return;
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
    for (const [index, change] of page.changes.entries()) {
      this.#assertPullChange(change, index);
    }
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

  #assertHandshake(version: number, hash: string, expectedHash: string): void {
    if (version !== this.#options.replicaSchema.version || hash !== expectedHash) {
      throw new Error(
        `Offline replica schema mismatch: client=${this.#options.replicaSchema.version}/${expectedHash}, server=${version}/${hash}.`,
      );
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
        acknowledgementSuperseded
          ? { ...command, state: 'conflict' as const, retryAt: null, lastErrorCode: change.deleted ? 'remote_deleted' : 'remote_revision' }
          : this.#executor.withServerRevision(command, change.serverRevision),
      );
    for (const command of following) putCommands.set(command.commandId, command);
    for (const command of related.slice(0, lastAcknowledgedIndex + 1)) {
      removeCommandIds.add(command.commandId);
    }

    if (change.deleted) {
      if (following.length > 0) {
        if (acknowledgementSuperseded) {
          putRows.push({
            ...row,
            confirmedValues: null,
            serverRevision: change.serverRevision,
            syncState: 'conflict',
            fetchedAt: Date.now(),
          });
          for (const command of following) {
            putCommands.set(command.commandId, { ...command, state: 'conflict', lastErrorCode: 'remote_deleted' });
          }
        } else {
          putRows.push({
            ...row,
            values: following.at(-1)!.optimisticValue,
            confirmedValues: null,
            serverRevision: change.serverRevision,
            syncState: 'pending',
            visibility: following.at(-1)!.replicaMutation === 'delete' ? 'pending_delete' : 'present',
            fetchedAt: Date.now(),
          });
        }
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
      values: following.length > 0 ? following.at(-1)!.optimisticValue : confirmedValues,
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
