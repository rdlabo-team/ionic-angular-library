import { inject, Injectable, InjectionToken } from '@angular/core';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import {
  canonicalOfflineCommandIdentity,
  canonicalOfflinePrincipalId,
  canonicalOfflineReplicaIdentity,
  commandIdentityFromReplicaIdentity,
  offlineReplicaRemoteIdentity,
  type OfflineCommandIdentity,
  type OfflineReplicaAddress,
  type OfflineReplicaIdentity,
  type OfflinePrincipalId,
} from './offline-identity';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  assertOfflineReplicaGeneratedRemoteId,
  assertOfflineReplicaNaturalKeyBaseline,
  canonicalOfflineRemoteIdentity,
  encodeOfflineReplicaValues,
  normalizeOfflineNaturalKey,
  offlineNaturalKeyFromValues,
  projectOfflineReplicaValues,
  sha256OfflineReplicaSchema,
  type OfflineGeneratedRemoteId,
  type OfflineReplicaEntitySchema,
  type OfflineReplicaRemoteIdentity,
  type OfflineReplicaWebMigrationRow,
} from './offline-replica-schema';

export type { OfflineCommandIdentity, OfflinePrincipalId, OfflineReplicaAddress, OfflineReplicaIdentity } from './offline-identity';
export {
  canonicalOfflineCommandIdentity,
  canonicalOfflinePrincipalId,
  canonicalOfflineReplicaIdentity,
  commandIdentityFromReplicaIdentity,
  commandIdentityMatchesReplicaRow,
  offlineGeneratedReplicaIdentity,
  offlineNaturalReplicaIdentity,
  offlineReplicaRemoteIdentity,
  parseOfflineCommandIdentity,
  parseOfflinePrincipalId,
  replicaAddressFromIdentity,
  serializeOfflineCommandIdentity,
} from './offline-identity';

/** Current durable storage schema used by both web and native repositories. */
export const OFFLINE_SCHEMA_VERSION = 1;

/** User and partition scope of all local offline data. */
export interface OfflineScope {
  userId: OfflinePrincipalId;
  scopeId: string;
}

/** Synchronization state of a locally materialized product replica row. */
export type OfflineReplicaSyncState = 'confirmed' | 'pending' | 'blocked_auth' | 'rejected' | 'conflict';
export type OfflineReplicaVisibility = 'present' | 'pending_delete';
export type OfflineReplicaMutation = 'upsert' | 'delete';

/** Durable processing state of an outbox command. */
export type OfflineCommandState = 'pending' | 'sending' | 'retry_wait' | 'blocked_auth' | 'rejected' | 'conflict';

interface OfflineCommandBase<T> extends OfflineScope {
  commandId: string;
  aggregateType: string;
  /** Replica schema source key resolved when the command is enqueued. */
  sourceKey: string;
  /** Stable row identity. The Outbox never persists a generated server id. */
  identity: OfflineCommandIdentity;
  operation: string;
  payload: T;
  /** Full optimistic entity value displayed while this command is pending. */
  optimisticValue: unknown;
  /** Product-owned companion rows changed atomically with this command. */
  optimisticCompanions?: readonly OfflineOptimisticReplicaCompanion[];
  /** Durable intent used to preserve a hidden tombstone across restart and replay. */
  replicaMutation?: OfflineReplicaMutation;
  payloadHash: string;
  baseRevision: string | number | null;
  state: OfflineCommandState;
  attempts: number;
  retryAt: number | null;
  createdAt: number;
  lastErrorCode: string | null;
  /** True when transport started but the client cannot prove whether the server committed. */
  serverCommitUnknown?: boolean;
}

/** Durable before/after image used to reconcile product-owned derived rows. */
export interface OfflineOptimisticReplicaCompanion {
  key: OfflineReplicaRowKey;
  before: OfflineReplicaRow | null;
  after: OfflineReplicaRow | null;
}

export type OfflineCommand<T = unknown> = OfflineCommandBase<T>;

/** Product replica row materialized from a versioned schema entity. */
interface OfflineReplicaRowBase<TValues> extends OfflineScope {
  /** Stable source key matching {@link OfflineReplicaEntitySchema.sourceKey}. */
  sourceKey: string;
  /** Row identity matching the entity schema. Natural-key rows have no synthetic ids. */
  identity: OfflineReplicaIdentity;
  /** Current optimistic domain values displayed locally. */
  values: TValues;
  /** Last server-confirmed domain values, or null while pending. */
  confirmedValues: TValues | null;
  serverRevision: string | number | null;
  fetchedAt: number;
  syncState: OfflineReplicaSyncState;
  /** Library-owned visibility; pending deletes remain durable but are hidden from product reads. */
  visibility?: OfflineReplicaVisibility;
}

export type OfflineReplicaRow<TValues = unknown> = OfflineReplicaRowBase<TValues>;

/** Stable address of a product replica row inside a user or partition-scoped replica. */
export interface OfflineReplicaRowKey extends OfflineScope {
  sourceKey: string;
  identity: OfflineReplicaIdentity;
}

/** Canonical physical key shared by every repository and replica transaction coordinator. */
export function canonicalOfflineReplicaRowKey(
  schema: Pick<OfflineReplicaEntitySchema<Record<string, unknown>>, 'scope'>,
  row: OfflineReplicaRowKey,
): string {
  const partition = schema.scope === 'user' ? 'user' : String(row.scopeId);
  return `${canonicalOfflinePrincipalId(row.userId)}:${partition}:${row.sourceKey}:${canonicalOfflineReplicaIdentity(row.identity)}`;
}

/** Explicit one-way release of a generated remote id during a replica delete acknowledgement. */
export interface OfflineReplicaRemoteIdRelease extends OfflineReplicaRowKey {
  /** The current remote id being released; the matching put row must set `remoteId` to null. */
  remoteId: OfflineGeneratedRemoteId;
}

/** Scope partition plus the durable replica pull cursor for that partition. */
export interface OfflineReplicaCursor extends OfflineScope {
  cursor: string;
}

/** Atomic changes applied to the local replica and durable outbox together. */
export interface OfflineReplicaTransaction {
  putRows?: readonly OfflineReplicaRow[];
  /**
   * Allows only the matching `remoteId: current -> null` transition in `putRows`.
   * All other remote-id changes remain immutable.
   */
  releaseRemoteIds?: readonly OfflineReplicaRemoteIdRelease[];
  removeRows?: readonly OfflineReplicaRowKey[];
  putCommands?: readonly OfflineCommand[];
  removeCommandIds?: readonly string[];
  putCursors?: readonly OfflineReplicaCursor[];
  /** Scopes whose acknowledged server changes still require an authoritative pull. */
  putReconciliationScopes?: readonly OfflineScope[];
  /** Scopes whose authoritative post-acknowledgement pull completed successfully. */
  removeReconciliationScopes?: readonly OfflineScope[];
}

/** Durable local replica and outbox persistence contract. */
export interface OfflineRepository {
  initialize(): Promise<void>;
  getLastUserId(): Promise<OfflinePrincipalId | null>;
  setLastUserId(userId: OfflinePrincipalId): Promise<void>;
  getSessionManifest<T>(userId: OfflinePrincipalId): Promise<T | null>;
  putSessionManifest<T>(userId: OfflinePrincipalId, value: T): Promise<void>;
  getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  /** Internal durable lookup used by synchronization; includes pending-delete tombstones. */
  getReplicaRowIncludingPendingDelete?<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  getReplicaRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]>;
  getReplicaRowByRemoteId<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    remoteId: OfflineGeneratedRemoteId,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  getReplicaRowByRemoteIdentity<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaRemoteIdentity,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null>;
  getReconciliationScopes?(userId: OfflinePrincipalId): Promise<OfflineScope[]>;
  getCommands(scope: OfflineScope): Promise<OfflineCommand[]>;
  getCommandsForUser?(userId: OfflinePrincipalId): Promise<OfflineCommand[]>;
  putCommand(command: OfflineCommand): Promise<void>;
  replaceCommand(command: OfflineCommand): Promise<void>;
  removeCommand(commandId: string): Promise<void>;
  clearUser(userId: OfflinePrincipalId): Promise<void>;
  clearScope(scope: OfflineScope): Promise<void>;
  transactReplica(transaction: OfflineReplicaTransaction): Promise<void>;
}

/** DI token for the selected platform repository. */
export const OFFLINE_REPOSITORY = new InjectionToken<OfflineRepository>('OFFLINE_REPOSITORY');

/** Returns whether the platform uses the cross-process-safe native repository. */
export function supportsSynchronizedOfflineRepository(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}

/** Selects encrypted SQLite on native platforms and Ionic Storage elsewhere. */
export function selectOfflineRepository(
  platform: string,
  webRepository: OfflineRepository,
  nativeRepository: OfflineRepository,
): OfflineRepository {
  return supportsSynchronizedOfflineRepository(platform) ? nativeRepository : webRepository;
}

interface OfflineMetadata {
  schemaVersion: number;
  lastUserId: OfflinePrincipalId | null;
  replicaSchemaVersion: number | null;
  replicaSchemaHash: string | null;
}

/** Crash-recoverable journal for an in-flight web replica schema migration. */
interface OfflineReplicaSchemaMigrationJournal {
  originalRows: Record<string, OfflineReplicaRow>;
  fromVersion: number;
  fromHash: string;
  targetVersion: number;
  targetHash: string;
}

const METADATA_KEY = 'offline:metadata';
const SESSION_MANIFESTS_KEY = 'offline:session:manifests';
const ROWS_KEY = 'offline:replica:rows';
const ROW_PARTITION_PREFIX = 'offline:replica:rows:index:v1:';
const ROW_PARTITION_READY_KEY = 'offline:replica:rows:index:v1:ready';
const CURSORS_KEY = 'offline:replica:cursors';
const OUTBOX_KEY = 'offline:outbox:commands';
const REPLICA_TRANSACTION_KEY = 'offline:replica:transaction';
const REPLICA_SCHEMA_MIGRATION_KEY = 'offline:replica:schema-migration';
const RECONCILIATION_SCOPES_KEY = 'offline:replica:reconciliation-scopes';

function compareOfflineCommands(left: OfflineCommand, right: OfflineCommand): number {
  return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
}

/** WebはIonic StorageのIndexedDB driverを利用する。 */
@Injectable({ providedIn: 'root' })
export class IonicOfflineRepository implements OfflineRepository {
  readonly #storage = inject(KitStorageService);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  #initialization: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();
  #rowIndexBuild: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.#migrate().catch((error: unknown) => {
        this.#initialization = null;
        throw error;
      });
    }
    return this.#initialization;
  }

  async getLastUserId(): Promise<OfflinePrincipalId | null> {
    await this.initialize();
    return (await this.#metadata()).lastUserId;
  }

  async setLastUserId(userId: OfflinePrincipalId): Promise<void> {
    await this.initialize();
    await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...(await this.#metadata()), lastUserId: userId });
  }

  async getSessionManifest<T>(userId: OfflinePrincipalId): Promise<T | null> {
    await this.initialize();
    await this.#writes;
    const manifests = await this.#readRecord<T>(SESSION_MANIFESTS_KEY);
    return manifests[canonicalOfflinePrincipalId(userId)] ?? null;
  }

  async putSessionManifest<T>(userId: OfflinePrincipalId, value: T): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<T>(SESSION_MANIFESTS_KEY, (manifests) => {
      manifests[canonicalOfflinePrincipalId(userId)] = value;
      return manifests;
    });
  }

  async getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const rows = await this.#readRowPartition<TValues>(scope, sourceKey, schema);
    const row = this.#findRowByAddress(rows, scope, sourceKey, schema, identity);
    if (!row || (row.visibility ?? 'present') === 'pending_delete') return null;
    return this.#rowForScope(row, schema, scope) as OfflineReplicaRow<TValues>;
  }

  async getReplicaRowIncludingPendingDelete<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const rows = await this.#readRowPartition<TValues>(scope, sourceKey, schema);
    const row = this.#findRowByAddress(rows, scope, sourceKey, schema, identity);
    return row ? (this.#rowForScope(row, schema, scope) as OfflineReplicaRow<TValues>) : null;
  }

  async getReplicaRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const rows = await this.#readRowPartition<TValues>(scope, sourceKey, schema);
    return Object.values(rows)
      .filter((row) => {
        if (row.sourceKey !== sourceKey || row.userId !== scope.userId) return false;
        if ((row.visibility ?? 'present') === 'pending_delete') return false;
        return schema.scope === 'partition' ? row.scopeId === scope.scopeId : true;
      })
      .map((row) => this.#rowForScope(row, schema, scope))
      .sort((left, right) => this.#compareReplicaIdentity(schema, left.identity, right.identity));
  }

  async getReplicaRowByRemoteId<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    remoteId: OfflineGeneratedRemoteId,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    if (this.#resolveReplicaEntitySchema(sourceKey).identity.kind !== 'generated') return null;
    return this.getReplicaRowByRemoteIdentity(scope, sourceKey, { remoteId });
  }

  async getReplicaRowByRemoteIdentity<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaRemoteIdentity,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const canonical = canonicalOfflineRemoteIdentity(schema, identity);
    const rows = await this.#readRowPartition<TValues>(scope, sourceKey, schema);
    const row = Object.values(rows).find((candidate) => {
      if (candidate.sourceKey !== sourceKey || candidate.userId !== scope.userId) return false;
      if (schema.scope === 'partition' && candidate.scopeId !== scope.scopeId) return false;
      const candidateIdentity = offlineReplicaRemoteIdentity(schema, candidate.identity);
      return candidateIdentity !== null && canonicalOfflineRemoteIdentity(schema, candidateIdentity) === canonical;
    });
    return row ? (this.#rowForScope(row, schema, scope) as OfflineReplicaRow<TValues>) : null;
  }

  async getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null> {
    await this.initialize();
    await this.#writes;
    const cursors = await this.#readRecord<string>(CURSORS_KEY);
    const cursor = cursors[this.#cursorKey(scope)];
    return cursor === undefined ? null : { ...scope, cursor };
  }

  async getReconciliationScopes(userId: OfflinePrincipalId): Promise<OfflineScope[]> {
    await this.initialize();
    await this.#writes;
    const scopes = await this.#readRecord<OfflineScope>(RECONCILIATION_SCOPES_KEY);
    return Object.values(scopes).filter((scope) => scope.userId === userId);
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    await this.initialize();
    await this.#writes;
    const commands = await this.#readRecord<OfflineCommand>(OUTBOX_KEY);
    return Object.values(commands)
      .filter((command) => command.userId === scope.userId && command.scopeId === scope.scopeId)
      .map((command) => this.#normalizeCommand(command))
      .sort(compareOfflineCommands);
  }

  async getCommandsForUser(userId: OfflinePrincipalId): Promise<OfflineCommand[]> {
    await this.initialize();
    await this.#writes;
    const commands = await this.#readRecord<OfflineCommand>(OUTBOX_KEY);
    return Object.values(commands)
      .filter((command) => command.userId === userId)
      .map((command) => this.#normalizeCommand(command))
      .sort(compareOfflineCommands);
  }

  #normalizeCommand(command: OfflineCommand): OfflineCommand {
    if (command.serverCommitUnknown !== undefined) return command;
    const legacyAmbiguousFailure = command.attempts >= 2 && ['blocked_auth', 'conflict', 'rejected'].includes(command.state);
    return command.state === 'sending' || command.state === 'retry_wait' || legacyAmbiguousFailure
      ? { ...command, serverCommitUnknown: true }
      : command;
  }

  async putCommand(command: OfflineCommand): Promise<void> {
    await this.initialize();
    await this.#assertReplicaSchemaLocked();
    await this.#mutateRecord<OfflineCommand>(OUTBOX_KEY, (commands) => {
      commands[command.commandId] = command;
      return commands;
    });
  }

  replaceCommand(command: OfflineCommand): Promise<void> {
    return this.putCommand(command);
  }

  async removeCommand(commandId: string): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<OfflineCommand>(OUTBOX_KEY, (commands) => {
      delete commands[commandId];
      return commands;
    });
  }

  async clearUser(userId: OfflinePrincipalId): Promise<void> {
    await this.initialize();
    await this.#enqueueWrite(async () => {
      await this.#removeRowPartitions((key) => key.startsWith(`${ROW_PARTITION_PREFIX}${canonicalOfflinePrincipalId(userId)}:`));
      await Promise.all([
        this.#mutateRecordNow(SESSION_MANIFESTS_KEY, (manifests) => {
          delete manifests[canonicalOfflinePrincipalId(userId)];
          return manifests;
        }),
        this.#filterRecordNow<OfflineReplicaRow>(ROWS_KEY, (value) => value.userId !== userId),
        this.#filterRecordNow<OfflineCommand>(OUTBOX_KEY, (value) => value.userId !== userId),
        this.#filterRecordNow<string>(CURSORS_KEY, (_value, key) => !key.startsWith(`${canonicalOfflinePrincipalId(userId)}:`)),
        this.#filterRecordNow<OfflineScope>(RECONCILIATION_SCOPES_KEY, (value) => value.userId !== userId),
      ]);
      const metadata = await this.#metadata();
      if (metadata.lastUserId === userId) {
        await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...metadata, lastUserId: null });
      }
    });
  }

  async clearScope(scope: OfflineScope): Promise<void> {
    await this.initialize();
    const belongsToGroup = (value: OfflineScope) => value.userId === scope.userId && value.scopeId === scope.scopeId;
    await this.#enqueueWrite(async () => {
      await this.#removeRowPartitions((key) => {
        if (!key.startsWith(`${ROW_PARTITION_PREFIX}${canonicalOfflinePrincipalId(scope.userId)}:`)) return false;
        return key.includes(`:partition:${encodeURIComponent(scope.scopeId)}:`);
      });
      await Promise.all([
        this.#filterRecordNow<OfflineReplicaRow>(ROWS_KEY, (value) => {
          const schema = this.#resolveReplicaEntitySchema(value.sourceKey);
          return schema.scope === 'user' || !belongsToGroup(value);
        }),
        this.#filterRecordNow<OfflineCommand>(OUTBOX_KEY, (value) => {
          const schema = this.#resolveReplicaEntitySchema(value.sourceKey);
          return schema.scope === 'user' || !belongsToGroup(value);
        }),
        this.#filterRecordNow<string>(CURSORS_KEY, (_value, key) => key !== this.#cursorKey(scope)),
        this.#filterRecordNow<OfflineScope>(RECONCILIATION_SCOPES_KEY, (value) => !belongsToGroup(value)),
      ]);
    });
  }

  async transactReplica(transaction: OfflineReplicaTransaction): Promise<void> {
    await this.initialize();
    return this.#enqueueWrite(() => this.#applyReplicaTransaction(transaction, true));
  }

  async #migrate(): Promise<void> {
    const metadata = await this.#storage.get<Partial<OfflineMetadata>>(METADATA_KEY);
    if (metadata?.schemaVersion !== undefined && metadata.schemaVersion !== OFFLINE_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported offline storage schema version ${metadata.schemaVersion}; expected ${OFFLINE_SCHEMA_VERSION}. ` +
          'A lossless core schema migration is required before this database can be opened.',
      );
    }

    const interruptedSchemaMigration = await this.#storage.get<OfflineReplicaSchemaMigrationJournal>(REPLICA_SCHEMA_MIGRATION_KEY);
    if (interruptedSchemaMigration) {
      await this.#recoverReplicaSchemaMigration(interruptedSchemaMigration);
    }

    const currentMetadata = await this.#metadata();
    await this.#initializeReplicaSchema(currentMetadata.replicaSchemaVersion, currentMetadata.replicaSchemaHash);

    const interrupted = await this.#storage.get<OfflineReplicaTransaction>(REPLICA_TRANSACTION_KEY);
    if (interrupted) await this.#applyReplicaTransaction(interrupted, false);
  }

  async #initializeReplicaSchema(storedVersion: number | null, storedHash: string | null): Promise<void> {
    const bundle = this.#options.replicaSchema;
    const targetVersion = bundle.version;
    const targetHash = await sha256OfflineReplicaSchema(bundle);

    if (storedVersion === null) {
      const metadata = await this.#metadata();
      await this.#storage.set<OfflineMetadata>(METADATA_KEY, {
        ...metadata,
        replicaSchemaVersion: targetVersion,
        replicaSchemaHash: targetHash,
      });
      return;
    }

    if (storedVersion === targetVersion && storedHash === targetHash) {
      return;
    }

    if (storedVersion === targetVersion) {
      throw new Error(
        `Offline replica schema hash mismatch at version ${targetVersion}. Reinstall the application or bump replicaSchema.version after intentional schema changes.`,
      );
    }

    if (storedVersion > targetVersion) {
      throw new Error(
        `Offline replica schema version ${storedVersion} is newer than application version ${targetVersion}. Upgrade the application before opening this database.`,
      );
    }

    if (storedHash === null) {
      throw new Error(`Offline replica schema metadata at version ${storedVersion} is missing its schema hash.`);
    }

    await this.#runReplicaSchemaMigration(storedVersion, storedHash, targetVersion, targetHash);
  }

  async #recoverReplicaSchemaMigration(journal: OfflineReplicaSchemaMigrationJournal): Promise<void> {
    await this.#removeRowPartitions(() => true);
    await this.#storage.set(ROWS_KEY, journal.originalRows);
    const metadata = await this.#metadata();
    await this.#storage.set<OfflineMetadata>(METADATA_KEY, {
      ...metadata,
      replicaSchemaVersion: journal.fromVersion,
      replicaSchemaHash: journal.fromHash,
    });
    await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
  }

  async #runReplicaSchemaMigration(fromVersion: number, fromHash: string, targetVersion: number, targetHash: string): Promise<void> {
    const bundle = this.#options.replicaSchema;
    for (let version = fromVersion; version < targetVersion; version++) {
      if (!bundle.migrations.some((migration) => migration.fromVersion === version)) {
        throw new Error(`Missing offline replica schema migration from version ${version} to ${version + 1}.`);
      }
    }

    return this.#enqueueWrite(async (): Promise<void> => {
      const rows = await this.#readRecord<OfflineReplicaRow>(ROWS_KEY);
      const originalRows = structuredClone(rows);
      await this.#storage.set<OfflineReplicaSchemaMigrationJournal>(REPLICA_SCHEMA_MIGRATION_KEY, {
        originalRows,
        fromVersion,
        fromHash,
        targetVersion,
        targetHash,
      });

      try {
        const transformedRows: Record<string, OfflineReplicaRow> = {};
        for (const row of Object.values(rows)) {
          let current: OfflineReplicaWebMigrationRow | null = this.#toWebMigrationRow(row);
          for (let version = fromVersion; version < targetVersion; version++) {
            if (current === null) break;
            const migration = bundle.migrations.find((candidate) => candidate.fromVersion === version);
            if (!migration) {
              throw new Error(`Missing offline replica schema migration from version ${version} to ${version + 1}.`);
            }
            current = await migration.migrateWebRow(current);
          }
          if (current === null) continue;

          const entitySchema = bundle.entities.find((entity) => entity.sourceKey === current!.sourceKey);
          if (!entitySchema) {
            throw new Error(`Unknown offline replica source key "${current!.sourceKey}" after schema migration.`);
          }
          encodeOfflineReplicaValues(entitySchema, current!.values);
          if (current!.confirmedValues !== null) {
            encodeOfflineReplicaValues(entitySchema, current!.confirmedValues);
          }

          const transformedRow: OfflineReplicaRow = {
            ...row,
            sourceKey: current!.sourceKey,
            values: projectOfflineReplicaValues(entitySchema, current!.values),
            confirmedValues: current!.confirmedValues === null ? null : projectOfflineReplicaValues(entitySchema, current!.confirmedValues),
          };
          const transformedKey = this.#rowKey(transformedRow);
          if (transformedRows[transformedKey]) {
            throw new Error(`Replica schema migration produced duplicate row key "${transformedKey}".`);
          }
          transformedRows[transformedKey] = transformedRow;
        }

        const metadata = await this.#metadata();
        await this.#storage.set(ROWS_KEY, transformedRows);
        await this.#removeRowPartitions(() => true);
        await this.#storage.set<OfflineMetadata>(METADATA_KEY, {
          ...metadata,
          replicaSchemaVersion: targetVersion,
          replicaSchemaHash: targetHash,
        });
        await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
      } catch (error) {
        await this.#recoverReplicaSchemaMigration({
          originalRows,
          fromVersion,
          fromHash,
          targetVersion,
          targetHash,
        });
        throw error;
      }
    });
  }

  #toWebMigrationRow(row: OfflineReplicaRow): OfflineReplicaWebMigrationRow {
    return {
      sourceKey: row.sourceKey,
      values: structuredClone(row.values as Record<string, unknown>),
      confirmedValues: row.confirmedValues === null ? null : structuredClone(row.confirmedValues as Record<string, unknown>),
    };
  }

  async #assertReplicaSchemaLocked(): Promise<void> {
    const bundle = this.#options.replicaSchema;
    const metadata = await this.#metadata();
    const targetHash = await sha256OfflineReplicaSchema(bundle);
    if (metadata.replicaSchemaVersion === null) {
      throw new Error('Offline replica schema metadata is not initialized.');
    }
    if (metadata.replicaSchemaVersion !== bundle.version) {
      throw new Error(
        `Offline replica schema version ${metadata.replicaSchemaVersion} does not match application version ${bundle.version}.`,
      );
    }
    if (metadata.replicaSchemaHash !== targetHash) {
      throw new Error(
        `Offline replica schema hash mismatch at version ${bundle.version}. Reinstall the application or bump replicaSchema.version after intentional schema changes.`,
      );
    }
  }

  async #applyReplicaTransaction(transaction: OfflineReplicaTransaction, journal: boolean): Promise<void> {
    await this.#assertReplicaSchemaLocked();
    for (const row of transaction.putRows ?? []) this.#validateReplicaRow(row);
    const [rows, commands, cursors, reconciliationScopes] = await Promise.all([
      this.#readRecord<OfflineReplicaRow>(ROWS_KEY),
      this.#readRecord<OfflineCommand>(OUTBOX_KEY),
      this.#readRecord<string>(CURSORS_KEY),
      this.#readRecord<OfflineScope>(RECONCILIATION_SCOPES_KEY),
    ]);
    const identityCheckRows = { ...rows };
    const releases = new Map<string, OfflineReplicaRemoteIdRelease>();
    for (const release of transaction.releaseRemoteIds ?? []) {
      this.#assertValidReleaseRemoteId(release.remoteId);
      const key = this.#rowKey(release);
      if (releases.has(key)) {
        throw new Error(
          `Offline replica remoteId release is duplicated for ${release.sourceKey}/${canonicalOfflineReplicaIdentity(release.identity)}.`,
        );
      }
      releases.set(key, release);
    }
    const consumedReleases = new Set<string>();
    for (const row of transaction.putRows ?? []) {
      const key = this.#rowKey(row);
      const existing = identityCheckRows[key];
      const release = releases.get(key);
      if (!existing && release) {
        throw new Error(
          `Offline replica remoteId release requires an existing row for ${row.sourceKey}/${canonicalOfflineReplicaIdentity(row.identity)}.`,
        );
      }
      if (existing) this.#assertReplicaIdentityAssignment(existing, row, release);
      if (release) consumedReleases.add(key);
      this.#assertUniqueReplicaIdentity(identityCheckRows, row);
      identityCheckRows[key] = row;
    }
    if (consumedReleases.size !== releases.size) {
      throw new Error('Offline replica remoteId release must match an existing row in putRows.');
    }
    if (journal) await this.#storage.set(REPLICA_TRANSACTION_KEY, transaction);
    for (const row of transaction.putRows ?? []) {
      const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
      rows[this.#rowKey(row)] = {
        ...row,
        scopeId: schema.scope === 'user' ? '' : row.scopeId,
        values: projectOfflineReplicaValues(schema, row.values),
        confirmedValues: row.confirmedValues === null ? null : projectOfflineReplicaValues(schema, row.confirmedValues),
      };
    }
    for (const row of transaction.removeRows ?? []) {
      delete rows[this.#rowKey(row)];
    }
    for (const command of transaction.putCommands ?? []) commands[command.commandId] = command;
    for (const commandId of transaction.removeCommandIds ?? []) delete commands[commandId];
    for (const cursor of transaction.putCursors ?? []) {
      cursors[this.#cursorKey(cursor)] = cursor.cursor;
    }
    for (const scope of transaction.putReconciliationScopes ?? []) {
      reconciliationScopes[this.#cursorKey(scope)] = scope;
    }
    for (const scope of transaction.removeReconciliationScopes ?? []) {
      delete reconciliationScopes[this.#cursorKey(scope)];
    }
    await Promise.all([
      this.#storage.set(ROWS_KEY, rows),
      this.#storage.set(OUTBOX_KEY, commands),
      this.#storage.set(CURSORS_KEY, cursors),
      this.#storage.set(RECONCILIATION_SCOPES_KEY, reconciliationScopes),
    ]);
    await this.#writeAffectedRowPartitions(rows, transaction);
    await this.#storage.remove(REPLICA_TRANSACTION_KEY);
  }

  async #readRowPartition<TValues>(
    scope: OfflineScope,
    sourceKey: string,
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  ): Promise<Record<string, OfflineReplicaRow<TValues>>> {
    const key = this.#rowPartitionKey(scope, sourceKey, schema);
    const cached = await this.#storage.get<Record<string, OfflineReplicaRow<TValues>>>(key);
    if (cached !== null) return cached;
    if (await this.#storage.get<boolean>(ROW_PARTITION_READY_KEY)) return {};
    await this.#buildRowPartitions();
    const built = await this.#storage.get<Record<string, OfflineReplicaRow<TValues>>>(key);
    return built ?? {};
  }

  #buildRowPartitions(): Promise<void> {
    if (!this.#rowIndexBuild) {
      const build = this.#enqueueWrite(async () => {
        if (await this.#storage.get<boolean>(ROW_PARTITION_READY_KEY)) return;
        const rows = await this.#readRecord<OfflineReplicaRow>(ROWS_KEY);
        const partitions = new Map<string, Record<string, OfflineReplicaRow>>();
        for (const [rowKey, row] of Object.entries(rows)) {
          const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
          const key = this.#rowPartitionKey(row, row.sourceKey, schema);
          const partition = partitions.get(key) ?? {};
          partition[rowKey] = row;
          partitions.set(key, partition);
        }
        await Promise.all([...partitions].map(([key, partition]) => this.#storage.set(key, partition)));
        await this.#storage.set(ROW_PARTITION_READY_KEY, true);
      });
      this.#rowIndexBuild = build.finally(() => {
        this.#rowIndexBuild = null;
      });
    }
    return this.#rowIndexBuild;
  }

  async #writeAffectedRowPartitions(rows: Record<string, OfflineReplicaRow>, transaction: OfflineReplicaTransaction): Promise<void> {
    const affected = new Map<
      string,
      { scope: OfflineScope; sourceKey: string; schema: OfflineReplicaEntitySchema<Record<string, unknown>> }
    >();
    for (const row of [...(transaction.putRows ?? []), ...(transaction.removeRows ?? [])]) {
      const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
      const key = this.#rowPartitionKey(row, row.sourceKey, schema);
      affected.set(key, { scope: row, sourceKey: row.sourceKey, schema });
    }
    await Promise.all(
      [...affected].map(([key, { scope, sourceKey, schema }]) =>
        this.#storage.set(
          key,
          Object.fromEntries(
            Object.entries(rows).filter(([, row]) => {
              if (row.userId !== scope.userId || row.sourceKey !== sourceKey) return false;
              return schema.scope === 'user' || row.scopeId === scope.scopeId;
            }),
          ),
        ),
      ),
    );
  }

  #rowPartitionKey(scope: OfflineScope, sourceKey: string, schema: OfflineReplicaEntitySchema<Record<string, unknown>>): string {
    const partition = schema.scope === 'user' ? 'user' : `partition:${encodeURIComponent(scope.scopeId)}`;
    return `${ROW_PARTITION_PREFIX}${canonicalOfflinePrincipalId(scope.userId)}:${partition}:${encodeURIComponent(sourceKey)}`;
  }

  async #removeRowPartitions(matches: (key: string) => boolean): Promise<void> {
    const keys = (await this.#storage.keys()).filter((key) => key.startsWith(ROW_PARTITION_PREFIX) && matches(key));
    await Promise.all(keys.map((key) => this.#storage.remove(key)));
  }

  async #metadata(): Promise<OfflineMetadata> {
    const metadata = await this.#storage.get<Partial<OfflineMetadata>>(METADATA_KEY);
    return {
      schemaVersion: metadata?.schemaVersion ?? OFFLINE_SCHEMA_VERSION,
      lastUserId: metadata?.lastUserId ?? null,
      replicaSchemaVersion: metadata?.replicaSchemaVersion ?? null,
      replicaSchemaHash: metadata?.replicaSchemaHash ?? null,
    };
  }

  async #readRecord<T>(key: string): Promise<Record<string, T>> {
    return (await this.#storage.get<Record<string, T>>(key)) ?? {};
  }

  #filterRecordNow<T>(key: string, predicate: (value: T, recordKey: string) => boolean): Promise<void> {
    return this.#mutateRecordNow<T>(key, (record) =>
      Object.fromEntries(Object.entries(record).filter(([recordKey, value]) => predicate(value, recordKey))),
    );
  }

  #mutateRecord<T>(key: string, mutate: (record: Record<string, T>) => Record<string, T>): Promise<void> {
    return this.#enqueueWrite(() => this.#mutateRecordNow(key, mutate));
  }

  async #mutateRecordNow<T>(key: string, mutate: (record: Record<string, T>) => Record<string, T>): Promise<void> {
    const record = await this.#readRecord<T>(key);
    await this.#storage.set(key, mutate(record));
  }

  #enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const write = this.#writes.then(operation);
    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  #rowKey(row: OfflineScope & { sourceKey: string; identity: OfflineReplicaIdentity }): string {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    return canonicalOfflineReplicaRowKey(schema, row);
  }

  #findRowByAddress<TValues>(
    rows: Record<string, OfflineReplicaRow<TValues>>,
    scope: OfflineScope,
    sourceKey: string,
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    identity: OfflineReplicaAddress,
  ): OfflineReplicaRow<TValues> | undefined {
    return Object.values(rows).find((row) => {
      if (row.sourceKey !== sourceKey || row.userId !== scope.userId) return false;
      if (schema.scope === 'partition' && row.scopeId !== scope.scopeId) return false;
      if (identity.kind === 'generated') {
        return row.identity.kind === 'generated' && row.identity.localId === identity.localId;
      }
      if (identity.kind === 'local') {
        return row.identity.kind === 'local' && row.identity.localId === identity.localId;
      }
      if (row.identity.kind !== 'natural') return false;
      return (
        canonicalOfflineRemoteIdentity(schema, { naturalKey: row.identity.naturalKey }) ===
        canonicalOfflineRemoteIdentity(schema, { naturalKey: normalizeOfflineNaturalKey(schema, identity.naturalKey) })
      );
    });
  }

  #rowForScope<TValues>(
    row: OfflineReplicaRow<TValues>,
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    scope: OfflineScope,
  ): OfflineReplicaRow<TValues> {
    const normalized = { ...row, visibility: row.visibility ?? ('present' as const) };
    return schema.scope === 'user' ? { ...normalized, scopeId: scope.scopeId } : normalized;
  }

  #cursorKey(scope: OfflineScope): string {
    return `${canonicalOfflinePrincipalId(scope.userId)}:${scope.scopeId}`;
  }

  #compareReplicaIdentity(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    left: import('./offline-identity').OfflineReplicaIdentity,
    right: import('./offline-identity').OfflineReplicaIdentity,
  ): number {
    if (left.kind === 'natural' && right.kind === 'natural' && schema.identity.kind === 'naturalKey') {
      const leftKey = normalizeOfflineNaturalKey(schema, left.naturalKey);
      const rightKey = normalizeOfflineNaturalKey(schema, right.naturalKey);
      for (const sourceKey of schema.identity.sourceKeys) {
        const leftValue = leftKey[sourceKey]!;
        const rightValue = rightKey[sourceKey]!;
        if (leftValue === rightValue) continue;
        if (typeof leftValue === 'number' && typeof rightValue === 'number') {
          return leftValue < rightValue ? -1 : 1;
        }
        return compareUtf8Binary(String(leftValue), String(rightValue));
      }
      return 0;
    }
    const leftId = left.kind === 'natural' ? canonicalOfflineReplicaIdentity(left) : left.localId;
    const rightId = right.kind === 'natural' ? canonicalOfflineReplicaIdentity(right) : right.localId;
    return compareUtf8Binary(leftId, rightId);
  }

  #validateReplicaRow(row: OfflineReplicaRow): void {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    this.#validateRowIdentity(schema, row);
    encodeOfflineReplicaValues(schema, row.values);
    if (row.confirmedValues !== null) encodeOfflineReplicaValues(schema, row.confirmedValues);
    assertOfflineReplicaNaturalKeyBaseline(schema, row.values, row.confirmedValues);
  }

  #validateRowIdentity(schema: OfflineReplicaEntitySchema<Record<string, unknown>>, row: OfflineReplicaRow): void {
    if (schema.identity.kind === 'localOnly') {
      if (row.identity.kind !== 'local') {
        throw new Error(`Offline replica source "${schema.sourceKey}" requires local identity.`);
      }
      return;
    }
    if (schema.identity.kind === 'generated') {
      if (row.identity.kind !== 'generated') {
        throw new Error(`Offline replica source "${schema.sourceKey}" requires generated identity.`);
      }
      assertOfflineReplicaGeneratedRemoteId(schema, row.identity.remoteId);
      return;
    }
    if (schema.identity.kind === 'naturalKey') {
      if (row.identity.kind !== 'natural') {
        throw new Error(`Offline replica source "${schema.sourceKey}" requires natural identity.`);
      }
      const fromValues = offlineNaturalKeyFromValues(schema, row.values)!;
      if (
        canonicalOfflineRemoteIdentity(schema, { naturalKey: row.identity.naturalKey }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: fromValues })
      ) {
        throw new Error(`Offline replica identity naturalKey must match values for "${schema.sourceKey}".`);
      }
    }
  }

  #assertUniqueReplicaIdentity(rows: Record<string, OfflineReplicaRow>, incoming: OfflineReplicaRow): void {
    const schema = this.#resolveReplicaEntitySchema(incoming.sourceKey);
    const identity = offlineReplicaRemoteIdentity(schema, incoming.identity);
    if (identity === null) return;
    const canonical = canonicalOfflineRemoteIdentity(schema, identity);
    const incomingKey = this.#rowKey(incoming);
    const collision = Object.entries(rows).find(([key, row]) => {
      if (key === incomingKey) return false;
      if (row.userId !== incoming.userId || row.sourceKey !== incoming.sourceKey) return false;
      if (schema.scope === 'partition' && row.scopeId !== incoming.scopeId) return false;
      const rowIdentity = offlineReplicaRemoteIdentity(schema, row.identity);
      return rowIdentity !== null && canonicalOfflineRemoteIdentity(schema, rowIdentity) === canonical;
    });
    if (collision) {
      if (schema.identity.kind === 'generated') {
        const remoteId = incoming.identity.kind === 'generated' ? incoming.identity.remoteId : null;
        const mapped =
          collision[1].identity.kind === 'generated'
            ? collision[1].identity.localId
            : canonicalOfflineReplicaIdentity(collision[1].identity);
        throw new Error(`Offline replica remote id ${String(remoteId)} is already mapped to ${mapped}.`);
      }
      throw new Error(`Offline replica remote identity is already mapped to another row.`);
    }
  }

  #assertReplicaIdentityAssignment(
    existing: OfflineReplicaRow,
    incoming: OfflineReplicaRow,
    release: OfflineReplicaRemoteIdRelease | undefined,
  ): void {
    const schema = this.#resolveReplicaEntitySchema(incoming.sourceKey);
    if (release && schema.identity.kind !== 'generated') {
      throw new Error(`Offline replica remoteId release is unsupported for source "${incoming.sourceKey}".`);
    }
    if (schema.identity.kind === 'localOnly') {
      if (existing.identity.kind !== 'local' || incoming.identity.kind !== 'local') {
        throw new Error(`Offline replica local identity is required for "${incoming.sourceKey}".`);
      }
      if (existing.identity.localId !== incoming.identity.localId) {
        throw new Error(`Offline replica localId is immutable for "${schema.sourceKey}".`);
      }
      return;
    }
    if (schema.identity.kind === 'generated') {
      if (existing.identity.kind !== 'generated' || incoming.identity.kind !== 'generated') {
        throw new Error(`Offline replica generated identity is required for "${incoming.sourceKey}".`);
      }
      if (release) {
        if (existing.identity.remoteId !== release.remoteId || incoming.identity.remoteId !== null) {
          throw new Error(
            `Offline replica remoteId release must transition current=${String(existing.identity.remoteId)} to incoming=null for ${incoming.sourceKey}/${incoming.identity.localId}.`,
          );
        }
        return;
      }
      if (existing.identity.localId !== incoming.identity.localId) {
        throw new Error(`Offline replica localId is immutable for "${schema.sourceKey}".`);
      }
      if (existing.identity.remoteId !== null && existing.identity.remoteId !== incoming.identity.remoteId) {
        throw new Error(
          `Offline replica remoteId is immutable: current=${String(existing.identity.remoteId)}, incoming=${String(incoming.identity.remoteId)}.`,
        );
      }
      return;
    }
    if (schema.identity.kind === 'naturalKey') {
      if (existing.identity.kind !== 'natural' || incoming.identity.kind !== 'natural') {
        throw new Error(`Offline replica natural identity is required for "${schema.sourceKey}".`);
      }
      const current = canonicalOfflineRemoteIdentity(schema, { naturalKey: existing.identity.naturalKey });
      const next = canonicalOfflineRemoteIdentity(schema, { naturalKey: incoming.identity.naturalKey });
      if (current !== next) throw new Error(`Offline replica naturalKey is immutable for "${schema.sourceKey}".`);
    }
  }

  #assertValidReleaseRemoteId(remoteId: OfflineGeneratedRemoteId): void {
    if (typeof remoteId === 'number') {
      if (!Number.isSafeInteger(remoteId) || remoteId <= 0) {
        throw new Error(`Offline replica release has invalid remoteId ${String(remoteId)}.`);
      }
      return;
    }
    if (typeof remoteId !== 'string' || remoteId.length === 0) {
      throw new Error(`Offline replica release has invalid remoteId ${String(remoteId)}.`);
    }
  }

  #resolveReplicaEntitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }
}

function compareUtf8Binary(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! < rightBytes[index]! ? -1 : 1;
  }
  return leftBytes.length < rightBytes.length ? -1 : leftBytes.length > rightBytes.length ? 1 : 0;
}
