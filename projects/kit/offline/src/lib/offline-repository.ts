import { inject, Injectable, InjectionToken } from '@angular/core';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  encodeOfflineReplicaValues,
  projectOfflineReplicaValues,
  sha256OfflineReplicaSchema,
  type OfflineReplicaEntitySchema,
  type OfflineReplicaWebMigrationRow,
} from './offline-replica-schema';

/** Current durable storage schema used by both web and native repositories. */
export const OFFLINE_SCHEMA_VERSION = 4;

/** User and group partition of all local offline data. */
export interface OfflineScope {
  userId: number;
  groupId: number;
}

/** Synchronization state of a locally materialized product replica row. */
export type OfflineReplicaSyncState = 'confirmed' | 'pending' | 'blocked_auth' | 'rejected' | 'conflict';

/** Durable processing state of an outbox command. */
export type OfflineCommandState = 'pending' | 'sending' | 'retry_wait' | 'blocked_auth' | 'rejected' | 'conflict';

/** Product-agnostic mutation persisted in the outbox by local id. */
export interface OfflineCommand<T = unknown> extends OfflineScope {
  commandId: string;
  aggregateType: string;
  /** Immutable local id of the target. The outbox never persists a server id. */
  aggregateLocalId: string;
  operation: string;
  payload: T;
  /** Full optimistic entity value displayed while this command is pending. */
  optimisticValue: unknown;
  payloadHash: string;
  baseRevision: string | number | null;
  state: OfflineCommandState;
  attempts: number;
  retryAt: number | null;
  createdAt: number;
  lastErrorCode: string | null;
}

/** Product replica row materialized from a versioned schema entity. */
export interface OfflineReplicaRow<TValues = unknown> extends OfflineScope {
  /** Stable source key matching {@link OfflineReplicaEntitySchema.sourceKey}. */
  sourceKey: string;
  /** Immutable client-generated UUID used as the SQLite primary key. */
  localId: string;
  /** Server-assigned identifier after a successful create, otherwise null. */
  serverId: number | null;
  /** Current optimistic domain values displayed locally. */
  values: TValues;
  /** Last server-confirmed domain values, or null while pending. */
  confirmedValues: TValues | null;
  serverRevision: string | number | null;
  fetchedAt: number;
  syncState: OfflineReplicaSyncState;
}

/** Stable address of a product replica row inside a user and group replica. */
export interface OfflineReplicaRowKey extends OfflineScope {
  sourceKey: string;
  localId: string;
}

/** Scope partition plus the durable replica pull cursor for that partition. */
export interface OfflineReplicaCursor extends OfflineScope {
  cursor: string;
}

/** Atomic changes applied to the local replica and durable outbox together. */
export interface OfflineReplicaTransaction {
  putRows?: readonly OfflineReplicaRow[];
  removeRows?: readonly OfflineReplicaRowKey[];
  putCommands?: readonly OfflineCommand[];
  removeCommandIds?: readonly string[];
  putCursors?: readonly OfflineReplicaCursor[];
}

/** Durable local replica and outbox persistence contract. */
export interface OfflineRepository {
  initialize(): Promise<void>;
  getLastUserId(): Promise<number | null>;
  setLastUserId(userId: number): Promise<void>;
  getSessionManifest<T>(userId: number): Promise<T | null>;
  putSessionManifest<T>(userId: number, value: T): Promise<void>;
  getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    localId: string,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  getReplicaRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]>;
  getReplicaRowByServerId<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    serverId: number,
  ): Promise<OfflineReplicaRow<TValues> | null>;
  getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null>;
  getCommands(scope: OfflineScope): Promise<OfflineCommand[]>;
  putCommand(command: OfflineCommand): Promise<void>;
  replaceCommand(command: OfflineCommand): Promise<void>;
  removeCommand(commandId: string): Promise<void>;
  clearUser(userId: number): Promise<void>;
  clearGroup(scope: OfflineScope): Promise<void>;
  transactReplica(transaction: OfflineReplicaTransaction): Promise<void>;
}

/** DI token for the selected platform repository. */
export const OFFLINE_REPOSITORY = new InjectionToken<OfflineRepository>('OFFLINE_REPOSITORY');

/** Selects encrypted SQLite on native platforms and Ionic Storage on web. */
export function selectOfflineRepository(
  platform: string,
  webRepository: OfflineRepository,
  nativeRepository: OfflineRepository,
): OfflineRepository {
  return platform === 'ios' || platform === 'android' ? nativeRepository : webRepository;
}

interface OfflineMetadata {
  schemaVersion: number;
  lastUserId: number | null;
  replicaSchemaVersion: number | null;
  replicaSchemaHash: string | null;
}

/** Crash-recoverable journal for an in-flight web replica schema migration. */
interface OfflineReplicaSchemaMigrationJournal {
  originalRows: Record<string, OfflineReplicaRow>;
  fromVersion: number;
  targetVersion: number;
  targetHash: string;
}

const METADATA_KEY = 'offline:metadata';
const SESSION_MANIFESTS_KEY = 'offline:session:manifests';
const ROWS_KEY = 'offline:replica:rows';
const CURSORS_KEY = 'offline:replica:cursors';
const LEGACY_ENTITIES_KEY = 'offline:business_cache:entities';
const LEGACY_QUERIES_KEY = 'offline:business_cache:queries';
const OUTBOX_KEY = 'offline:outbox:commands';
const REPLICA_TRANSACTION_KEY = 'offline:replica:transaction';
const REPLICA_SCHEMA_MIGRATION_KEY = 'offline:replica:schema-migration';

/** WebはIonic StorageのIndexedDB driverを利用する。 */
@Injectable({ providedIn: 'root' })
export class IonicOfflineRepository implements OfflineRepository {
  readonly #storage = inject(KitStorageService);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  #initialization: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();

  initialize(): Promise<void> {
    if (!this.#initialization) {
      this.#initialization = this.#migrate().catch((error: unknown) => {
        this.#initialization = null;
        throw error;
      });
    }
    return this.#initialization;
  }

  async getLastUserId(): Promise<number | null> {
    await this.initialize();
    return (await this.#metadata()).lastUserId;
  }

  async setLastUserId(userId: number): Promise<void> {
    await this.initialize();
    await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...(await this.#metadata()), lastUserId: userId });
  }

  async getSessionManifest<T>(userId: number): Promise<T | null> {
    await this.initialize();
    await this.#writes;
    const manifests = await this.#readRecord<T>(SESSION_MANIFESTS_KEY);
    return manifests[String(userId)] ?? null;
  }

  async putSessionManifest<T>(userId: number, value: T): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<T>(SESSION_MANIFESTS_KEY, (manifests) => {
      manifests[String(userId)] = value;
      return manifests;
    });
  }

  async getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    localId: string,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    await this.initialize();
    await this.#writes;
    const rows = await this.#readRecord<OfflineReplicaRow<TValues>>(ROWS_KEY);
    return rows[this.#rowKey(scope, sourceKey, localId)] ?? null;
  }

  async getReplicaRows<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
  ): Promise<OfflineReplicaRow<TValues>[]> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const rows = await this.#readRecord<OfflineReplicaRow<TValues>>(ROWS_KEY);
    return Object.values(rows)
      .filter((row) => {
        if (row.sourceKey !== sourceKey || row.userId !== scope.userId) return false;
        return schema.scope === 'group' ? row.groupId === scope.groupId : true;
      })
      .sort((left, right) => left.localId.localeCompare(right.localId));
  }

  async getReplicaRowByServerId<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    serverId: number,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    await this.initialize();
    await this.#writes;
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    if (!this.#schemaHasServerId(schema)) return null;
    const rows = await this.#readRecord<OfflineReplicaRow<TValues>>(ROWS_KEY);
    return (
      Object.values(rows).find((row) => {
        if (row.sourceKey !== sourceKey || row.userId !== scope.userId || row.serverId !== serverId) return false;
        return schema.scope === 'group' ? row.groupId === scope.groupId : true;
      }) ?? null
    );
  }

  async getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null> {
    await this.initialize();
    await this.#writes;
    const cursors = await this.#readRecord<string>(CURSORS_KEY);
    const cursor = cursors[this.#cursorKey(scope)];
    return cursor === undefined ? null : { ...scope, cursor };
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    await this.initialize();
    await this.#writes;
    const commands = await this.#readRecord<OfflineCommand>(OUTBOX_KEY);
    return Object.values(commands)
      .filter((command) => command.userId === scope.userId && command.groupId === scope.groupId)
      .sort((left, right) => left.createdAt - right.createdAt);
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

  async clearUser(userId: number): Promise<void> {
    await this.initialize();
    await Promise.all([
      this.#mutateRecord(SESSION_MANIFESTS_KEY, (manifests) => {
        delete manifests[String(userId)];
        return manifests;
      }),
      this.#filterRecord<OfflineReplicaRow>(ROWS_KEY, (value) => value.userId !== userId),
      this.#filterRecord<OfflineCommand>(OUTBOX_KEY, (value) => value.userId !== userId),
      this.#filterRecord<string>(CURSORS_KEY, (_value, key) => !key.startsWith(`${userId}:`)),
    ]);
    const metadata = await this.#metadata();
    if (metadata.lastUserId === userId) {
      await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...metadata, lastUserId: null });
    }
  }

  async clearGroup(scope: OfflineScope): Promise<void> {
    await this.initialize();
    const belongsToGroup = (value: OfflineScope) => value.userId === scope.userId && value.groupId === scope.groupId;
    await Promise.all([
      this.#filterRecord<OfflineReplicaRow>(ROWS_KEY, (value) => !belongsToGroup(value)),
      this.#filterRecord<OfflineCommand>(OUTBOX_KEY, (value) => !belongsToGroup(value)),
      this.#filterRecord<string>(CURSORS_KEY, (_value, key) => key !== this.#cursorKey(scope)),
    ]);
  }

  async transactReplica(transaction: OfflineReplicaTransaction): Promise<void> {
    await this.initialize();
    const write = this.#writes.then(() => this.#applyReplicaTransaction(transaction, true));
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  async #migrate(): Promise<void> {
    const metadata = await this.#storage.get<Partial<OfflineMetadata>>(METADATA_KEY);
    if (metadata?.schemaVersion !== undefined && metadata.schemaVersion !== OFFLINE_SCHEMA_VERSION) {
      await Promise.all([
        this.#storage.remove(SESSION_MANIFESTS_KEY),
        this.#storage.remove(ROWS_KEY),
        this.#storage.remove(CURSORS_KEY),
        this.#storage.remove(LEGACY_ENTITIES_KEY),
        this.#storage.remove(LEGACY_QUERIES_KEY),
        this.#storage.remove(OUTBOX_KEY),
        this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY),
      ]);
      await this.#storage.set<OfflineMetadata>(METADATA_KEY, {
        schemaVersion: OFFLINE_SCHEMA_VERSION,
        lastUserId: metadata.lastUserId ?? null,
        replicaSchemaVersion: null,
        replicaSchemaHash: null,
      });
      await this.#storage.remove(REPLICA_TRANSACTION_KEY);
      await this.#initializeReplicaSchema(null, null);
      return;
    }

    const interruptedSchemaMigration = await this.#storage.get<OfflineReplicaSchemaMigrationJournal>(
      REPLICA_SCHEMA_MIGRATION_KEY,
    );
    if (interruptedSchemaMigration) {
      await this.#recoverReplicaSchemaMigration(interruptedSchemaMigration);
    }

    const currentMetadata = await this.#metadata();
    await this.#initializeReplicaSchema(
      currentMetadata.replicaSchemaVersion,
      currentMetadata.replicaSchemaHash,
    );

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

    await this.#runReplicaSchemaMigration(storedVersion, targetVersion, targetHash);
  }

  async #recoverReplicaSchemaMigration(journal: OfflineReplicaSchemaMigrationJournal): Promise<void> {
    const metadata = await this.#metadata();
    if (
      metadata.replicaSchemaVersion === journal.targetVersion &&
      metadata.replicaSchemaHash === journal.targetHash
    ) {
      await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
      return;
    }

    await this.#storage.set(ROWS_KEY, journal.originalRows);
    await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
  }

  async #runReplicaSchemaMigration(
    fromVersion: number,
    targetVersion: number,
    targetHash: string,
  ): Promise<void> {
    const bundle = this.#options.replicaSchema;
    for (let version = fromVersion; version < targetVersion; version++) {
      if (!bundle.migrations.some((migration) => migration.fromVersion === version)) {
        throw new Error(`Missing offline replica schema migration from version ${version} to ${version + 1}.`);
      }
    }

    const write = this.#writes.then(async (): Promise<void> => {
      const rows = await this.#readRecord<OfflineReplicaRow>(ROWS_KEY);
      const originalRows = structuredClone(rows);
      await this.#storage.set<OfflineReplicaSchemaMigrationJournal>(REPLICA_SCHEMA_MIGRATION_KEY, {
        originalRows,
        fromVersion,
        targetVersion,
        targetHash,
      });

      try {
        const transformedRows: Record<string, OfflineReplicaRow> = {};
        for (const [key, row] of Object.entries(rows)) {
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

          transformedRows[key] = {
            ...row,
            sourceKey: current!.sourceKey,
            values: projectOfflineReplicaValues(entitySchema, current!.values),
            confirmedValues:
              current!.confirmedValues === null
                ? null
                : projectOfflineReplicaValues(entitySchema, current!.confirmedValues),
          };
        }

        const metadata = await this.#metadata();
        await Promise.all([
          this.#storage.set(ROWS_KEY, transformedRows),
          this.#storage.set<OfflineMetadata>(METADATA_KEY, {
            ...metadata,
            replicaSchemaVersion: targetVersion,
            replicaSchemaHash: targetHash,
          }),
        ]);
        await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
      } catch (error) {
        await this.#storage.remove(REPLICA_SCHEMA_MIGRATION_KEY);
        throw error;
      }
    });
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #toWebMigrationRow(row: OfflineReplicaRow): OfflineReplicaWebMigrationRow {
    return {
      sourceKey: row.sourceKey,
      values: structuredClone(row.values as Record<string, unknown>),
      confirmedValues:
        row.confirmedValues === null ? null : structuredClone(row.confirmedValues as Record<string, unknown>),
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
    if (journal) await this.#storage.set(REPLICA_TRANSACTION_KEY, transaction);
    const [rows, commands, cursors] = await Promise.all([
      this.#readRecord<OfflineReplicaRow>(ROWS_KEY),
      this.#readRecord<OfflineCommand>(OUTBOX_KEY),
      this.#readRecord<string>(CURSORS_KEY),
    ]);
    for (const row of transaction.putRows ?? []) {
      const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
      rows[this.#rowKey(row, row.sourceKey, row.localId)] = {
        ...row,
        values: projectOfflineReplicaValues(schema, row.values),
        confirmedValues:
          row.confirmedValues === null ? null : projectOfflineReplicaValues(schema, row.confirmedValues),
      };
    }
    for (const row of transaction.removeRows ?? []) {
      delete rows[this.#rowKey(row, row.sourceKey, row.localId)];
    }
    for (const command of transaction.putCommands ?? []) commands[command.commandId] = command;
    for (const commandId of transaction.removeCommandIds ?? []) delete commands[commandId];
    for (const cursor of transaction.putCursors ?? []) {
      cursors[this.#cursorKey(cursor)] = cursor.cursor;
    }
    await Promise.all([
      this.#storage.set(ROWS_KEY, rows),
      this.#storage.set(OUTBOX_KEY, commands),
      this.#storage.set(CURSORS_KEY, cursors),
    ]);
    await this.#storage.remove(REPLICA_TRANSACTION_KEY);
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

  async #filterRecord<T>(key: string, predicate: (value: T, recordKey: string) => boolean): Promise<void> {
    await this.#mutateRecord<T>(key, (record) =>
      Object.fromEntries(Object.entries(record).filter(([recordKey, value]) => predicate(value, recordKey))),
    );
  }

  #mutateRecord<T>(key: string, mutate: (record: Record<string, T>) => Record<string, T>): Promise<void> {
    const write = this.#writes.then(async (): Promise<void> => {
      const record = await this.#readRecord<T>(key);
      await this.#storage.set(key, mutate(record));
    });
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #rowKey(scope: OfflineScope, sourceKey: string, localId: string): string {
    return `${scope.userId}:${scope.groupId}:${sourceKey}:${localId}`;
  }

  #cursorKey(scope: OfflineScope): string {
    return `${scope.userId}:${scope.groupId}`;
  }

  #schemaHasServerId(schema: OfflineReplicaEntitySchema<Record<string, unknown>>): boolean {
    return schema.fields.some((field) => field.policy === 'serverId');
  }

  #validateReplicaRow(row: OfflineReplicaRow): void {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    encodeOfflineReplicaValues(schema, row.values);
    if (row.confirmedValues !== null) encodeOfflineReplicaValues(schema, row.confirmedValues);
  }

  #resolveReplicaEntitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }
}
