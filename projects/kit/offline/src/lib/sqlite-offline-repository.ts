import { inject, Injectable, InjectionToken } from '@angular/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  decodeOfflineReplicaValues,
  encodeOfflineReplicaValues,
  projectOfflineReplicaValues,
  type OfflineReplicaEntitySchema,
  type OfflineReplicaSchemaBundle,
  sha256OfflineReplicaSchema,
} from './offline-replica-schema';
import {
  OFFLINE_SCHEMA_VERSION,
  type OfflineCommand,
  type OfflineReplicaCursor,
  type OfflineReplicaRow,
  type OfflineReplicaRowKey,
  type OfflineRepository,
  type OfflineReplicaTransaction,
  type OfflineScope,
} from './offline-repository';

/** Minimal native SQLite driver surface required by the offline repository. */
export interface CommunitySqliteDriver {
  open(options: { databaseName: string; createEncryptionKey?: () => Promise<string> }): Promise<{ databaseId: string }>;
  execute(options: { databaseId: string; statement: string; values?: SQLiteValue[] }): Promise<unknown>;
  query(options: { databaseId: string; statement: string; values?: SQLiteValue[] }): Promise<{
    columns?: string[];
    rows?: unknown[];
  }>;
  beginTransaction(options: { databaseId: string }): Promise<void>;
  commitTransaction(options: { databaseId: string }): Promise<void>;
  rollbackTransaction(options: { databaseId: string }): Promise<void>;
}

/** Open community SQLite database surface used by the standard driver. */
export interface CommunitySqliteDatabase {
  open(): Promise<void>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  query(statement: string, values?: unknown[]): Promise<{ values?: unknown[] }>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
}

/** Community SQLite connection surface used to provision encrypted databases. */
export interface CommunitySqliteConnection {
  isSecretStored(): Promise<{ result?: boolean }>;
  setEncryptionSecret(passphrase: string): Promise<void>;
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<CommunitySqliteDatabase>;
}

/** DI token for the native community SQLite driver. */
export const COMMUNITY_SQLITE = new InjectionToken<CommunitySqliteDriver>('COMMUNITY_SQLITE', {
  factory: createCommunitySqliteDriver,
});

/** Create the standard encrypted `@capacitor-community/sqlite` driver. */
export function createCommunitySqliteDriver(
  connection: CommunitySqliteConnection = new SQLiteConnection(CapacitorSQLite),
): CommunitySqliteDriver {
  const databases = new Map<string, CommunitySqliteDatabase>();
  const database = (databaseId: string): CommunitySqliteDatabase => {
    const value = databases.get(databaseId);
    if (!value) throw new Error(`Offline SQLite database "${databaseId}" is not open`);
    return value;
  };
  return {
    async open({ databaseName, createEncryptionKey }) {
      const stored = await connection.isSecretStored();
      if (!stored.result) {
        const encryptionKey = await createEncryptionKey?.();
        if (!encryptionKey) throw new Error('Native offline storage requires a non-empty encryption key on first open');
        await connection.setEncryptionSecret(encryptionKey);
      }
      const value = await connection.createConnection(databaseName, true, 'secret', 1, false);
      await value.open();
      databases.set(databaseName, value);
      return { databaseId: databaseName };
    },
    async execute({ databaseId, statement, values = [] }) {
      await database(databaseId).run(statement, values, false);
    },
    async query({ databaseId, statement, values = [] }) {
      const result = await database(databaseId).query(statement, values);
      return { rows: result.values ?? [] };
    },
    async beginTransaction({ databaseId }) {
      await database(databaseId).beginTransaction();
    },
    async commitTransaction({ databaseId }) {
      await database(databaseId).commitTransaction();
    },
    async rollbackTransaction({ databaseId }) {
      await database(databaseId).rollbackTransaction();
    },
  };
}

type SQLiteValue = string | number | null;
type SQLiteRow = Record<string, unknown>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS offline_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  last_user_id INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS offline_session_manifests (
  user_id INTEGER PRIMARY KEY,
  value_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS offline_sync_commands (
  command_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_local_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  optimistic_value_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  base_revision_json TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  retry_at INTEGER,
  created_at INTEGER NOT NULL,
  last_error_code TEXT
)`,
  `CREATE INDEX IF NOT EXISTS offline_sync_commands_scope_created
  ON offline_sync_commands (user_id, group_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS offline_replica_schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64)
)`,
  `CREATE TABLE IF NOT EXISTS offline_replica_cursors (
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  cursor TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
)`,
];

/** Native iOS/Android repository backed by encrypted `@capacitor-community/sqlite`. */
@Injectable({ providedIn: 'root' })
export class SqliteOfflineRepository implements OfflineRepository {
  readonly #sqlite = inject(COMMUNITY_SQLITE);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  #databaseId: string | null = null;
  #initialization: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();

  initialize(): Promise<void> {
    this.#initialization ??= this.#open();
    return this.#initialization;
  }

  async getLastUserId(): Promise<number | null> {
    const rows = await this.#query('SELECT last_user_id FROM offline_metadata WHERE id = 1');
    return this.#numberOrNull(rows[0]?.['last_user_id']);
  }

  async setLastUserId(userId: number): Promise<void> {
    await this.#write(
      `INSERT INTO offline_metadata (id, schema_version, last_user_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, last_user_id = excluded.last_user_id`,
      [OFFLINE_SCHEMA_VERSION, userId],
    );
  }

  async getSessionManifest<T>(userId: number): Promise<T | null> {
    const rows = await this.#query('SELECT value_json FROM offline_session_manifests WHERE user_id = ?', [userId]);
    const row = rows[0];
    return row ? this.#parse<T>(row['value_json']) : null;
  }

  async putSessionManifest<T>(userId: number, value: T): Promise<void> {
    await this.#write(
      `INSERT INTO offline_session_manifests (user_id, value_json) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET value_json = excluded.value_json`,
      [userId, JSON.stringify(value)],
    );
  }

  async getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    localId: string,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const predicates = ['local_id = ?', '_offline_user_id = ?'];
    const values: SQLiteValue[] = [localId, scope.userId];
    if (schema.scope === 'group') {
      predicates.push('_offline_group_id = ?');
      values.push(scope.groupId);
    }
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
    const row = rows[0];
    if (!row) return null;
    return this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, localId, row);
  }

  async getReplicaRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const predicates = ['_offline_user_id = ?'];
    const values: SQLiteValue[] = [scope.userId];
    if (schema.scope === 'group') {
      predicates.push('_offline_group_id = ?');
      values.push(scope.groupId);
    }
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')} ORDER BY local_id ASC`, values);
    return rows.map((row) => this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, this.#string(row['local_id']), row));
  }

  async getReplicaRowByServerId<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    serverId: number,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    if (!this.#schemaHasServerId(schema)) return null;
    const predicates = ['server_id = ?', '_offline_user_id = ?'];
    const values: SQLiteValue[] = [serverId, scope.userId];
    if (schema.scope === 'group') {
      predicates.push('_offline_group_id = ?');
      values.push(scope.groupId);
    }
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
    const row = rows[0];
    if (!row) return null;
    return this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, this.#string(row['local_id']), row);
  }

  async getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null> {
    const rows = await this.#query('SELECT cursor FROM offline_replica_cursors WHERE user_id = ? AND group_id = ?', [
      scope.userId,
      scope.groupId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return { ...scope, cursor: this.#string(row['cursor']) };
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    const rows = await this.#query(
      'SELECT * FROM offline_sync_commands WHERE user_id = ? AND group_id = ? ORDER BY created_at ASC, command_id ASC',
      [scope.userId, scope.groupId],
    );
    return rows.map((row) => this.#command(row));
  }

  async getCommandsForUser(userId: number): Promise<OfflineCommand[]> {
    const rows = await this.#query('SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC', [
      userId,
    ]);
    return rows.map((row) => this.#command(row));
  }

  async putCommand(command: OfflineCommand): Promise<void> {
    await this.#queueWrite((databaseId) => this.#putCommand(databaseId, command));
  }

  replaceCommand(command: OfflineCommand): Promise<void> {
    return this.putCommand(command);
  }

  async removeCommand(commandId: string): Promise<void> {
    await this.#write('DELETE FROM offline_sync_commands WHERE command_id = ?', [commandId]);
  }

  async clearUser(userId: number): Promise<void> {
    await this.#transaction(async (database) => {
      await this.#execute(database, 'DELETE FROM offline_session_manifests WHERE user_id = ?', [userId]);
      await this.#execute(database, 'DELETE FROM offline_sync_commands WHERE user_id = ?', [userId]);
      await this.#execute(database, 'DELETE FROM offline_replica_cursors WHERE user_id = ?', [userId]);
      for (const entity of this.#options.replicaSchema.entities) {
        await this.#execute(database, `DELETE FROM ${entity.tableName} WHERE _offline_user_id = ?`, [userId]);
      }
      await this.#execute(database, 'UPDATE offline_metadata SET last_user_id = NULL WHERE id = 1 AND last_user_id = ?', [userId]);
    });
  }

  async clearGroup(scope: OfflineScope): Promise<void> {
    await this.#transaction(async (database) => {
      const values = [scope.userId, scope.groupId];
      await this.#execute(database, 'DELETE FROM offline_sync_commands WHERE user_id = ? AND group_id = ?', values);
      await this.#execute(database, 'DELETE FROM offline_replica_cursors WHERE user_id = ? AND group_id = ?', values);
      for (const entity of this.#options.replicaSchema.entities) {
        if (entity.scope !== 'group') continue;
        await this.#execute(database, `DELETE FROM ${entity.tableName} WHERE _offline_user_id = ? AND _offline_group_id = ?`, values);
      }
    });
  }

  async transactReplica(transaction: OfflineReplicaTransaction): Promise<void> {
    await this.#transaction(async (databaseId) => {
      for (const row of transaction.putRows ?? []) await this.#putReplicaRow(databaseId, row);
      for (const row of transaction.removeRows ?? []) await this.#removeReplicaRow(databaseId, row);
      for (const command of transaction.putCommands ?? []) await this.#putCommand(databaseId, command);
      for (const commandId of transaction.removeCommandIds ?? []) {
        await this.#execute(databaseId, 'DELETE FROM offline_sync_commands WHERE command_id = ?', [commandId]);
      }
      for (const cursor of transaction.putCursors ?? []) await this.#putReplicaCursor(databaseId, cursor);
    });
  }

  async #open(): Promise<void> {
    const { databaseId } = await this.#sqlite.open({
      databaseName: this.#options.databaseName,
      createEncryptionKey: this.#options.encryptionKey,
    });
    this.#databaseId = databaseId;
    for (const statement of SCHEMA) await this.#execute(databaseId, statement);
    let commandColumns = await this.#queryDatabase(databaseId, 'PRAGMA table_info(offline_sync_commands)');
    if (commandColumns.some((column) => column['name'] === 'aggregate_id')) {
      await this.#execute(databaseId, 'ALTER TABLE offline_sync_commands RENAME COLUMN aggregate_id TO aggregate_local_id');
      commandColumns = await this.#queryDatabase(databaseId, 'PRAGMA table_info(offline_sync_commands)');
    }
    if (!commandColumns.some((column) => column['name'] === 'optimistic_value_json')) {
      await this.#execute(databaseId, 'ALTER TABLE offline_sync_commands ADD COLUMN optimistic_value_json TEXT');
      await this.#execute(databaseId, 'UPDATE offline_sync_commands SET optimistic_value_json = payload_json');
    }
    await this.#execute(
      databaseId,
      `INSERT INTO offline_metadata (id, schema_version, last_user_id) VALUES (1, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version`,
      [OFFLINE_SCHEMA_VERSION],
    );
    await this.#initializeReplicaSchema(databaseId);
  }

  async #initializeReplicaSchema(databaseId: string): Promise<void> {
    const bundle = this.#options.replicaSchema;
    const targetVersion = bundle.version;
    const targetHash = await sha256OfflineReplicaSchema(bundle);
    const rows = await this.#queryDatabase(databaseId, 'SELECT version, schema_hash FROM offline_replica_schema_metadata WHERE id = 1');
    const storedVersion = rows[0] ? this.#number(rows[0]['version']) : null;
    const storedHash = rows[0] ? this.#string(rows[0]['schema_hash']) : null;

    if (storedVersion === null) {
      await this.#nativeTransaction(databaseId, async () => {
        await this.#executeReplicaCreateStatements(databaseId, bundle);
        await this.#upsertReplicaSchemaMetadata(databaseId, targetVersion, targetHash);
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

    await this.#nativeTransaction(databaseId, async () => {
      for (let version = storedVersion; version < targetVersion; version++) {
        const migration = bundle.migrations.find((candidate) => candidate.fromVersion === version);
        if (!migration) {
          throw new Error(`Missing offline replica schema migration from version ${version} to ${version + 1}.`);
        }
        for (const statement of migration.statements) {
          await this.#execute(databaseId, statement);
        }
      }
      await this.#executeReplicaCreateStatements(databaseId, bundle);
      await this.#upsertReplicaSchemaMetadata(databaseId, targetVersion, targetHash);
    });
  }

  async #executeReplicaCreateStatements(databaseId: string, bundle: OfflineReplicaSchemaBundle): Promise<void> {
    for (const entity of bundle.entities) {
      for (const statement of entity.createTableSql) {
        await this.#execute(databaseId, statement);
      }
    }
  }

  async #upsertReplicaSchemaMetadata(databaseId: string, version: number, schemaHash: string): Promise<void> {
    await this.#execute(
      databaseId,
      `INSERT INTO offline_replica_schema_metadata (id, version, schema_hash) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, schema_hash = excluded.schema_hash`,
      [version, schemaHash],
    );
  }

  async #nativeTransaction(databaseId: string, run: () => Promise<void>): Promise<void> {
    await this.#sqlite!.beginTransaction({ databaseId });
    try {
      await run();
      await this.#sqlite!.commitTransaction({ databaseId });
    } catch (error) {
      await this.#sqlite!.rollbackTransaction({ databaseId });
      throw error;
    }
  }

  async #databaseConnection(): Promise<string> {
    await this.initialize();
    if (!this.#databaseId) throw new Error('Offline SQLite database is not initialized');
    return this.#databaseId;
  }

  async #query(statement: string, values: SQLiteValue[] = []): Promise<SQLiteRow[]> {
    return this.#queryDatabase(await this.#databaseConnection(), statement, values);
  }

  #write(statement: string, values: SQLiteValue[]): Promise<void> {
    return this.#queueWrite((databaseId) => this.#execute(databaseId, statement, values));
  }

  #queueWrite(run: (databaseId: string) => Promise<void>): Promise<void> {
    const write = this.#writes.then(async (): Promise<void> => run(await this.#databaseConnection()));
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #transaction(run: (databaseId: string) => Promise<void>): Promise<void> {
    const write = this.#writes.then(async (): Promise<void> => {
      const databaseId = await this.#databaseConnection();
      await this.#sqlite!.beginTransaction({ databaseId });
      try {
        await run(databaseId);
        await this.#sqlite!.commitTransaction({ databaseId });
      } catch (error) {
        await this.#sqlite!.rollbackTransaction({ databaseId });
        throw error;
      }
    });
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #command(row: SQLiteRow): OfflineCommand {
    return {
      commandId: this.#string(row['command_id']),
      userId: this.#number(row['user_id']),
      groupId: this.#number(row['group_id']),
      aggregateType: this.#string(row['aggregate_type']),
      aggregateLocalId: this.#string(row['aggregate_local_id']),
      operation: this.#string(row['operation']),
      payload: this.#parse(row['payload_json']),
      optimisticValue: this.#parse(row['optimistic_value_json']),
      payloadHash: this.#string(row['payload_hash']),
      baseRevision: this.#parseNullable(row['base_revision_json']),
      state: this.#string(row['state']) as OfflineCommand['state'],
      attempts: this.#number(row['attempts']),
      retryAt: this.#numberOrNull(row['retry_at']),
      createdAt: this.#number(row['created_at']),
      lastErrorCode: this.#stringOrNull(row['last_error_code']),
    };
  }

  #putCommand(databaseId: string, command: OfflineCommand): Promise<void> {
    return this.#execute(
      databaseId,
      `INSERT INTO offline_sync_commands
        (command_id, user_id, group_id, aggregate_type, aggregate_local_id, operation, payload_json, optimistic_value_json,
         payload_hash, base_revision_json, state, attempts, retry_at, created_at, last_error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(command_id) DO UPDATE SET
        user_id = excluded.user_id, group_id = excluded.group_id, aggregate_type = excluded.aggregate_type,
        aggregate_local_id = excluded.aggregate_local_id, operation = excluded.operation, payload_json = excluded.payload_json,
        optimistic_value_json = excluded.optimistic_value_json, payload_hash = excluded.payload_hash,
        base_revision_json = excluded.base_revision_json, state = excluded.state, attempts = excluded.attempts,
        retry_at = excluded.retry_at, created_at = excluded.created_at, last_error_code = excluded.last_error_code`,
      [
        command.commandId,
        command.userId,
        command.groupId,
        command.aggregateType,
        command.aggregateLocalId,
        command.operation,
        JSON.stringify(command.payload),
        JSON.stringify(command.optimisticValue),
        command.payloadHash,
        this.#stringifyNullable(command.baseRevision),
        command.state,
        command.attempts,
        command.retryAt,
        command.createdAt,
        command.lastErrorCode,
      ],
    );
  }

  #putReplicaRow(databaseId: string, row: OfflineReplicaRow): Promise<void> {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    const encoded = encodeOfflineReplicaValues(schema, row.values);
    const confirmedValues = row.confirmedValues === null ? null : projectOfflineReplicaValues(schema, row.confirmedValues);
    const { sql, domainColumns } = this.#buildReplicaUpsertStatement(schema);
    const values: SQLiteValue[] = [
      row.localId,
      row.userId,
      ...(schema.scope === 'group' ? [row.groupId] : []),
      ...(this.#schemaHasServerId(schema) ? [row.serverId] : []),
      confirmedValues === null ? null : JSON.stringify(confirmedValues),
      row.serverRevision == null ? null : JSON.stringify(row.serverRevision),
      row.syncState,
      row.fetchedAt,
      ...domainColumns.map((column) => encoded[column] ?? null),
    ];
    return this.#execute(databaseId, sql, values);
  }

  #removeReplicaRow(databaseId: string, key: OfflineReplicaRowKey): Promise<void> {
    const schema = this.#resolveReplicaEntitySchema(key.sourceKey);
    const predicates = ['local_id = ?', '_offline_user_id = ?'];
    const values: SQLiteValue[] = [key.localId, key.userId];
    if (schema.scope === 'group') {
      predicates.push('_offline_group_id = ?');
      values.push(key.groupId);
    }
    return this.#execute(databaseId, `DELETE FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
  }

  #putReplicaCursor(databaseId: string, cursor: OfflineReplicaCursor): Promise<void> {
    return this.#execute(
      databaseId,
      `INSERT INTO offline_replica_cursors (user_id, group_id, cursor) VALUES (?, ?, ?)
       ON CONFLICT(user_id, group_id) DO UPDATE SET cursor = excluded.cursor`,
      [cursor.userId, cursor.groupId, cursor.cursor],
    );
  }

  #buildReplicaUpsertStatement(schema: OfflineReplicaEntitySchema<Record<string, unknown>>): {
    sql: string;
    domainColumns: readonly string[];
  } {
    const insertColumns = ['local_id', '_offline_user_id'];
    const updateSets = ['_offline_user_id = excluded._offline_user_id'];
    if (schema.scope === 'group') {
      insertColumns.push('_offline_group_id');
      updateSets.push('_offline_group_id = excluded._offline_group_id');
    }
    if (this.#schemaHasServerId(schema)) {
      insertColumns.push('server_id');
      updateSets.push('server_id = excluded.server_id');
    }
    insertColumns.push('_offline_confirmed_json', '_offline_server_revision_json', '_offline_sync_state', '_offline_fetched_at');
    updateSets.push(
      '_offline_confirmed_json = excluded._offline_confirmed_json',
      '_offline_server_revision_json = excluded._offline_server_revision_json',
      '_offline_sync_state = excluded._offline_sync_state',
      '_offline_fetched_at = excluded._offline_fetched_at',
    );
    const domainColumns: string[] = [];
    for (const field of schema.fields) {
      if (field.policy !== 'column' || field.sqliteColumnName === null) continue;
      insertColumns.push(field.sqliteColumnName);
      updateSets.push(`${field.sqliteColumnName} = excluded.${field.sqliteColumnName}`);
      domainColumns.push(field.sqliteColumnName);
    }
    const placeholders = insertColumns.map(() => '?').join(', ');
    return {
      sql: `INSERT INTO ${schema.tableName} (${insertColumns.join(', ')})
       VALUES (${placeholders})
       ON CONFLICT(local_id) DO UPDATE SET ${updateSets.join(', ')}`,
      domainColumns,
    };
  }

  #replicaRowFromSqliteRow<TValues>(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    scope: OfflineScope,
    sourceKey: string,
    localId: string,
    row: SQLiteRow,
  ): OfflineReplicaRow<TValues> {
    return {
      ...scope,
      sourceKey,
      localId,
      serverId: this.#schemaHasServerId(schema) ? this.#numberOrNull(row['server_id']) : null,
      values: decodeOfflineReplicaValues(schema, row) as TValues,
      confirmedValues: this.#parseNullable<TValues>(row['_offline_confirmed_json']),
      serverRevision: this.#parseNullable<string | number>(row['_offline_server_revision_json']),
      fetchedAt: this.#number(row['_offline_fetched_at']),
      syncState: this.#string(row['_offline_sync_state']) as OfflineReplicaRow['syncState'],
    };
  }

  #resolveReplicaEntitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }

  #schemaHasServerId(schema: OfflineReplicaEntitySchema<Record<string, unknown>>): boolean {
    return schema.fields.some((field) => field.policy === 'serverId');
  }

  async #execute(databaseId: string, statement: string, values: SQLiteValue[] = []): Promise<void> {
    await this.#sqlite!.execute({ databaseId, statement, values });
  }

  async #queryDatabase(databaseId: string, statement: string, values: SQLiteValue[] = []): Promise<SQLiteRow[]> {
    const result = await this.#sqlite!.query({ databaseId, statement, values });
    return (result.rows ?? []).map((row) => {
      if (!Array.isArray(row)) return row as SQLiteRow;
      return Object.fromEntries(row.map((value, index) => [result.columns?.[index] ?? String(index), value]));
    });
  }

  #parse<T>(value: unknown): T {
    if (typeof value !== 'string') throw new Error('Invalid JSON value in offline SQLite database');
    return JSON.parse(value) as T;
  }

  #parseNullable<T>(value: unknown): T | null {
    return value == null ? null : this.#parse<T>(value);
  }

  #stringifyNullable(value: unknown): string | null {
    return value == null ? null : JSON.stringify(value);
  }

  #number(value: unknown): number {
    if (typeof value !== 'number') throw new Error('Invalid numeric value in offline SQLite database');
    return value;
  }

  #numberOrNull(value: unknown): number | null {
    return value == null ? null : this.#number(value);
  }

  #string(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid string value in offline SQLite database');
    return value;
  }

  #stringOrNull(value: unknown): string | null {
    return value == null ? null : this.#string(value);
  }
}
