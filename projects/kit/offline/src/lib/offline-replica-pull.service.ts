import { inject, Injectable } from '@angular/core';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import {
  OFFLINE_REPLICA_PULLER,
  type OfflineReplicaChange,
  type OfflineReplicaPullPage,
} from './offline-replica-puller';
import {
  projectOfflineReplicaValues,
  sha256OfflineReplicaSchema,
  type OfflineReplicaEntitySchema,
} from './offline-replica-schema';
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

      const commands = await this.#repository.getCommands(scope);
      const changes = this.#collapseChanges(page.changes);
      const putRows: OfflineReplicaRow[] = [];
      const removeRows: OfflineReplicaRowKey[] = [];
      const putCommands = new Map<string, OfflineCommand>();

      for (const change of changes) {
        const schema = this.#entitySchema(change.sourceKey);
        const existing = await this.#repository.getReplicaRowByServerId(scope, change.sourceKey, change.serverId);
        const related = existing
          ? commands.filter(
              (command) =>
                this.#hooks.entityType(command) === change.sourceKey && command.aggregateLocalId === existing.localId,
            )
          : [];
        const hasPending = related.length > 0;

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
    if (
      typeof serverId !== 'number' ||
      !Number.isFinite(serverId) ||
      !Number.isSafeInteger(serverId) ||
      serverId <= 0
    ) {
      throw new Error(`${label}.serverId must be a positive integer.`);
    }
    const revision = change['serverRevision'];
    if (typeof revision !== 'string' && typeof revision !== 'number') {
      throw new Error(`${label}.serverRevision must be a string or number.`);
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

  #validatedValues(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    change: OfflineReplicaChange,
  ): unknown {
    if (change.values === null) {
      throw new Error(`Offline replica change "${change.sourceKey}"/${change.serverId} is missing values.`);
    }
    return projectOfflineReplicaValues(schema, change.values);
  }

  #collapseChanges(changes: readonly OfflineReplicaChange[]): OfflineReplicaChange[] {
    const collapsed = new Map<string, OfflineReplicaChange>();
    for (const change of changes) collapsed.set(`${change.sourceKey}:${change.serverId}`, change);
    return [...collapsed.values()];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
