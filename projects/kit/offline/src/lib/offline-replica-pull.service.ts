import { inject, Injectable } from '@angular/core';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_COMMAND_EXECUTOR } from './offline-command-executor';
import { OFFLINE_REPLICA_PULLER, type OfflineReplicaChange, type OfflineReplicaPullPage } from './offline-replica-puller';
import { projectOfflineReplicaValues, sha256OfflineReplicaSchema, type OfflineReplicaEntitySchema } from './offline-replica-schema';
import {
  OFFLINE_REPOSITORY,
  type OfflineCommand,
  type OfflineReplicaRow,
  type OfflineReplicaRowKey,
  type OfflineScope,
} from './offline-repository';

/** Pulls authoritative server deltas into one durable local replica partition. */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaPullService {
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #puller = inject(OFFLINE_REPLICA_PULLER);
  readonly #hooks = inject(OFFLINE_COMMAND_HOOKS);
  readonly #executor = inject(OFFLINE_COMMAND_EXECUTOR);
  #schemaHash: Promise<string> | null = null;

  async pull(scope: OfflineScope): Promise<void> {
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
        throw new Error(`Offline replica pull cursor did not advance for scope ${scope.userId}:${scope.groupId}.`);
      }

      const scopeCommands = await this.#repository.getCommands(scope);
      const userCommands = await this.#repository.getCommandsForUser(scope.userId);
      const changes = this.#collapseChanges(page.changes);
      const putRows: OfflineReplicaRow[] = [];
      const removeRows: OfflineReplicaRowKey[] = [];
      const putCommands = new Map<string, OfflineCommand>();
      const removeCommandIds = new Set<string>();

      for (const change of changes) {
        const schema = this.#entitySchema(change.sourceKey);
        const commands = schema.scope === 'user' ? userCommands : scopeCommands;
        const acknowledged = change.acknowledgedCommandIds
          .map((commandId) => {
            const command = commands.find((candidate) => candidate.commandId === commandId);
            if (!command) return null;
            if (this.#hooks.entityType(command) !== change.sourceKey) {
              throw new Error(`Acknowledged command "${commandId}" does not target "${change.sourceKey}".`);
            }
            return command;
          })
          .filter((command): command is OfflineCommand => command !== null);
        const acknowledgedLocalIds = new Set(acknowledged.map((command) => command.aggregateLocalId));
        if (acknowledgedLocalIds.size > 1) {
          throw new Error(`Acknowledged commands for "${change.sourceKey}" target multiple local rows.`);
        }
        const acknowledgedCommand = acknowledged[0];
        const acknowledgedScope = acknowledgedCommand
          ? { userId: acknowledgedCommand.userId, groupId: acknowledgedCommand.groupId }
          : scope;
        const acknowledgedRow = acknowledgedCommand
          ? await this.#repository.getReplicaRow(acknowledgedScope, change.sourceKey, acknowledgedCommand.aggregateLocalId)
          : null;
        if (acknowledgedCommand && !acknowledgedRow) {
          throw new Error(`Acknowledged command "${acknowledgedCommand.commandId}" has no local replica row.`);
        }
        const serverRow = await this.#repository.getReplicaRowByServerId(scope, change.sourceKey, change.serverId);
        if (acknowledgedRow && serverRow && acknowledgedRow.localId !== serverRow.localId) {
          throw new Error(`Server id ${change.serverId} is already mapped to another local replica row.`);
        }
        const existing = acknowledgedRow ?? serverRow;
        const related = existing
          ? commands.filter(
              (command) => this.#hooks.entityType(command) === change.sourceKey && command.aggregateLocalId === existing.localId,
            )
          : [];
        const hasPending = related.length > 0;

        if (acknowledgedCommand) {
          this.#applyAcknowledgement(change, existing!, related, putRows, removeRows, putCommands, removeCommandIds);
          continue;
        }

        if (change.deleted) {
          if (!existing) continue;
          if (!hasPending) {
            removeRows.push(existing);
            continue;
          }
          putRows.push({ ...existing, serverRevision: change.serverRevision, syncState: 'conflict', fetchedAt: Date.now() });
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
            localId: crypto.randomUUID(),
            serverId: change.serverId,
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
    const serverId = change['serverId'];
    if (typeof serverId !== 'number' || !Number.isFinite(serverId) || !Number.isSafeInteger(serverId) || serverId <= 0) {
      throw new Error(`${label}.serverId must be a positive integer.`);
    }
    const revision = change['serverRevision'];
    if (typeof revision !== 'string' && (typeof revision !== 'number' || !Number.isFinite(revision))) {
      throw new Error(`${label}.serverRevision must be a string or number.`);
    }
    const acknowledgedCommandIds = change['acknowledgedCommandIds'];
    if (
      !Array.isArray(acknowledgedCommandIds) ||
      acknowledgedCommandIds.some((commandId) => typeof commandId !== 'string' || commandId.length === 0)
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
      throw new Error(`Offline replica change "${change.sourceKey}"/${change.serverId} is missing values.`);
    }
    return projectOfflineReplicaValues(schema, change.values);
  }

  #collapseChanges(changes: readonly OfflineReplicaChange[]): OfflineReplicaChange[] {
    const collapsed = new Map<string, OfflineReplicaChange>();
    for (const change of changes) {
      const key = `${change.sourceKey}:${change.serverId}`;
      const previous = collapsed.get(key);
      collapsed.set(key, {
        ...change,
        acknowledgedCommandIds: [...new Set([...(previous?.acknowledgedCommandIds ?? []), ...change.acknowledgedCommandIds])],
      });
    }
    return [...collapsed.values()];
  }

  #applyAcknowledgement(
    change: OfflineReplicaChange,
    row: OfflineReplicaRow,
    related: readonly OfflineCommand[],
    putRows: OfflineReplicaRow[],
    removeRows: OfflineReplicaRowKey[],
    putCommands: Map<string, OfflineCommand>,
    removeCommandIds: Set<string>,
  ): void {
    const acknowledgedIds = new Set(change.acknowledgedCommandIds);
    const lastAcknowledgedIndex = related.reduce((last, command, index) => (acknowledgedIds.has(command.commandId) ? index : last), -1);
    if (lastAcknowledgedIndex < 0) {
      throw new Error(`Replica acknowledgement does not match the local aggregate outbox.`);
    }
    if (related.slice(0, lastAcknowledgedIndex + 1).some((command) => !acknowledgedIds.has(command.commandId))) {
      throw new Error(`Replica acknowledgement skipped an earlier aggregate command.`);
    }
    const following = related
      .slice(lastAcknowledgedIndex + 1)
      .map((command) => this.#executor.withServerRevision(command, change.serverRevision));
    for (const command of following) putCommands.set(command.commandId, command);
    for (const command of related.slice(0, lastAcknowledgedIndex + 1)) {
      removeCommandIds.add(command.commandId);
    }

    if (change.deleted) {
      if (following.length > 0) {
        putRows.push({ ...row, serverRevision: change.serverRevision, syncState: 'conflict', fetchedAt: Date.now() });
        for (const command of following) {
          putCommands.set(command.commandId, { ...command, state: 'conflict', lastErrorCode: 'remote_deleted' });
        }
      } else {
        removeRows.push(row);
      }
      return;
    }

    const schema = this.#entitySchema(change.sourceKey);
    const confirmedValues = this.#validatedValues(schema, change);
    this.#assertServerIdAssignment(row.serverId, change.serverId);
    putRows.push({
      ...row,
      serverId: change.serverId,
      values: following.length > 0 ? following.at(-1)!.optimisticValue : confirmedValues,
      confirmedValues,
      serverRevision: change.serverRevision,
      fetchedAt: Date.now(),
      syncState: following.length > 0 ? 'pending' : 'confirmed',
    });
  }

  #assertServerIdAssignment(current: number | null, incoming: number): void {
    if (current !== null && current !== incoming) {
      throw new Error(`Replica serverId is immutable: current=${current}, incoming=${incoming}.`);
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
