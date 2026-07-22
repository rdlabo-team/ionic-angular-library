import { inject, Injectable, InjectionToken } from '@angular/core';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  OFFLINE_SCHEMA_VERSION,
  type OfflineCommand,
  type OfflineEntity,
  type OfflineQuery,
  type OfflineRepository,
  type OfflineScope,
} from './offline-repository';

export interface CapawesomeSqlitePlugin {
  open(options: { path: string; encryptionKey: string; readOnly: false }): Promise<{ databaseId: string }>;
  execute(options: { databaseId: string; statement: string; values?: SQLiteValue[] }): Promise<unknown>;
  query(options: { databaseId: string; statement: string; values?: SQLiteValue[] }): Promise<{
    columns?: string[];
    rows?: unknown[];
  }>;
  beginTransaction(options: { databaseId: string }): Promise<void>;
  commitTransaction(options: { databaseId: string }): Promise<void>;
  rollbackTransaction(options: { databaseId: string }): Promise<void>;
}

export const CAPAWESOME_SQLITE = new InjectionToken<CapawesomeSqlitePlugin | null>('CAPAWESOME_SQLITE', {
  factory: () => null,
});

type SQLiteValue = string | number | null;
type SQLiteRow = Record<string, unknown>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS offline_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  last_user_id INTEGER,
  next_local_id INTEGER NOT NULL DEFAULT 2000000000000
)`,
  `CREATE TABLE IF NOT EXISTS offline_entities (
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  server_revision_json TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id, entity_type, entity_id)
)`,
  `CREATE TABLE IF NOT EXISTS offline_queries (
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  query_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  ordered_ids_json TEXT NOT NULL,
  cursor TEXT,
  etag TEXT,
  fetched_at INTEGER NOT NULL,
  is_complete INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id, query_key)
)`,
  `CREATE TABLE IF NOT EXISTS offline_sync_commands (
  command_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
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
];

/** Native iOS/Android uses the encrypted Capawesome SQLite plugin supplied by the application. */
@Injectable({ providedIn: 'root' })
export class SqliteOfflineRepository implements OfflineRepository {
  readonly #sqlite = inject(CAPAWESOME_SQLITE);
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

  async allocateLocalId(): Promise<number> {
    let allocated = 0;
    await this.#transaction(async (database) => {
      await this.#execute(database, 'UPDATE offline_metadata SET next_local_id = next_local_id + 1 WHERE id = 1');
      const rows = await this.#queryDatabase(database, 'SELECT next_local_id FROM offline_metadata WHERE id = 1');
      allocated = this.#number(rows[0]?.['next_local_id']);
    });
    return allocated;
  }

  async getEntity<T>(scope: OfflineScope, entityType: string, entityId: string): Promise<OfflineEntity<T> | null> {
    const rows = await this.#query(
      `SELECT value_json, server_revision_json, fetched_at FROM offline_entities
       WHERE user_id = ? AND group_id = ? AND entity_type = ? AND entity_id = ?`,
      [scope.userId, scope.groupId, entityType, entityId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...scope,
      entityType,
      entityId,
      value: this.#parse<T>(row['value_json']),
      serverRevision: this.#parseNullable<string | number>(row['server_revision_json']),
      fetchedAt: this.#number(row['fetched_at']),
    };
  }

  async putEntity<T>(entity: OfflineEntity<T>): Promise<void> {
    await this.#write(
      `INSERT INTO offline_entities
        (user_id, group_id, entity_type, entity_id, value_json, server_revision_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, group_id, entity_type, entity_id) DO UPDATE SET
        value_json = excluded.value_json, server_revision_json = excluded.server_revision_json,
        fetched_at = excluded.fetched_at`,
      [
        entity.userId,
        entity.groupId,
        entity.entityType,
        entity.entityId,
        JSON.stringify(entity.value),
        this.#stringifyNullable(entity.serverRevision),
        entity.fetchedAt,
      ],
    );
  }

  async getQuery<T>(scope: OfflineScope, queryKey: string): Promise<OfflineQuery<T> | null> {
    const rows = await this.#query(
      `SELECT value_json, ordered_ids_json, cursor, etag, fetched_at, is_complete FROM offline_queries
       WHERE user_id = ? AND group_id = ? AND query_key = ?`,
      [scope.userId, scope.groupId, queryKey],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...scope,
      queryKey,
      value: this.#parse<T>(row['value_json']),
      orderedIds: this.#parse<string[]>(row['ordered_ids_json']),
      cursor: this.#stringOrNull(row['cursor']),
      etag: this.#stringOrNull(row['etag']),
      fetchedAt: this.#number(row['fetched_at']),
      isComplete: this.#number(row['is_complete']) === 1,
    };
  }

  async putQuery<T>(query: OfflineQuery<T>): Promise<void> {
    await this.#write(
      `INSERT INTO offline_queries
        (user_id, group_id, query_key, value_json, ordered_ids_json, cursor, etag, fetched_at, is_complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, group_id, query_key) DO UPDATE SET
        value_json = excluded.value_json, ordered_ids_json = excluded.ordered_ids_json,
        cursor = excluded.cursor, etag = excluded.etag, fetched_at = excluded.fetched_at,
        is_complete = excluded.is_complete`,
      [
        query.userId,
        query.groupId,
        query.queryKey,
        JSON.stringify(query.value),
        JSON.stringify(query.orderedIds),
        query.cursor,
        query.etag,
        query.fetchedAt,
        query.isComplete ? 1 : 0,
      ],
    );
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    const rows = await this.#query('SELECT * FROM offline_sync_commands WHERE user_id = ? AND group_id = ? ORDER BY created_at ASC', [
      scope.userId,
      scope.groupId,
    ]);
    return rows.map((row) => this.#command(row));
  }

  async putCommand(command: OfflineCommand): Promise<void> {
    await this.#write(
      `INSERT INTO offline_sync_commands
        (command_id, user_id, group_id, aggregate_type, aggregate_id, operation, payload_json, payload_hash,
         base_revision_json, state, attempts, retry_at, created_at, last_error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(command_id) DO UPDATE SET
        user_id = excluded.user_id, group_id = excluded.group_id, aggregate_type = excluded.aggregate_type,
        aggregate_id = excluded.aggregate_id, operation = excluded.operation, payload_json = excluded.payload_json,
        payload_hash = excluded.payload_hash, base_revision_json = excluded.base_revision_json,
        state = excluded.state, attempts = excluded.attempts, retry_at = excluded.retry_at,
        created_at = excluded.created_at, last_error_code = excluded.last_error_code`,
      [
        command.commandId,
        command.userId,
        command.groupId,
        command.aggregateType,
        command.aggregateId,
        command.operation,
        JSON.stringify(command.payload),
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

  replaceCommand(command: OfflineCommand): Promise<void> {
    return this.putCommand(command);
  }

  async removeCommand(commandId: string): Promise<void> {
    await this.#write('DELETE FROM offline_sync_commands WHERE command_id = ?', [commandId]);
  }

  async clearUser(userId: number): Promise<void> {
    await this.#transaction(async (database) => {
      await this.#execute(database, 'DELETE FROM offline_entities WHERE user_id = ?', [userId]);
      await this.#execute(database, 'DELETE FROM offline_queries WHERE user_id = ?', [userId]);
      await this.#execute(database, 'DELETE FROM offline_sync_commands WHERE user_id = ?', [userId]);
      await this.#execute(database, 'UPDATE offline_metadata SET last_user_id = NULL WHERE id = 1 AND last_user_id = ?', [userId]);
    });
  }

  async clearGroup(scope: OfflineScope): Promise<void> {
    await this.#transaction(async (database) => {
      const values = [scope.userId, scope.groupId];
      await this.#execute(database, 'DELETE FROM offline_entities WHERE user_id = ? AND group_id = ?', values);
      await this.#execute(database, 'DELETE FROM offline_queries WHERE user_id = ? AND group_id = ?', values);
      await this.#execute(database, 'DELETE FROM offline_sync_commands WHERE user_id = ? AND group_id = ?', values);
    });
  }

  async #open(): Promise<void> {
    if (!this.#sqlite) throw new Error('Native offline storage requires the Capawesome Sqlite plugin');
    const encryptionKey = await this.#options.encryptionKey?.();
    if (!encryptionKey) throw new Error('Native offline storage requires a non-empty encryption key');
    const { databaseId } = await this.#sqlite.open({
      path: `${this.#options.databaseName}.sqlite3`,
      encryptionKey,
      readOnly: false,
    });
    this.#databaseId = databaseId;
    for (const statement of SCHEMA) await this.#execute(databaseId, statement);
    const metadataColumns = await this.#queryDatabase(databaseId, 'PRAGMA table_info(offline_metadata)');
    if (!metadataColumns.some((column) => column['name'] === 'next_local_id')) {
      await this.#execute(databaseId, 'ALTER TABLE offline_metadata ADD COLUMN next_local_id INTEGER NOT NULL DEFAULT 2000000000000');
    }
    await this.#execute(
      databaseId,
      `INSERT INTO offline_metadata (id, schema_version, last_user_id, next_local_id) VALUES (1, ?, NULL, 2000000000000)
       ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version`,
      [OFFLINE_SCHEMA_VERSION],
    );
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
    const write = this.#writes.then(async (): Promise<void> => {
      await this.#execute(await this.#databaseConnection(), statement, values);
    });
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
      aggregateId: this.#string(row['aggregate_id']),
      operation: this.#string(row['operation']),
      payload: this.#parse(row['payload_json']),
      payloadHash: this.#string(row['payload_hash']),
      baseRevision: this.#parseNullable(row['base_revision_json']),
      state: this.#string(row['state']) as OfflineCommand['state'],
      attempts: this.#number(row['attempts']),
      retryAt: this.#numberOrNull(row['retry_at']),
      createdAt: this.#number(row['created_at']),
      lastErrorCode: this.#stringOrNull(row['last_error_code']),
    };
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
