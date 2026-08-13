import { inject, Injectable, InjectionToken } from '@angular/core';
import {
  canonicalOfflineReplicaIdentity,
  canonicalOfflinePrincipalId,
  commandIdentityFromReplicaIdentity,
  offlineGeneratedReplicaIdentity,
  offlineNaturalReplicaIdentity,
  parseOfflineCommandIdentity,
  parseOfflinePrincipalId,
  replicaAddressFromIdentity,
  serializeOfflineCommandIdentity,
} from './offline-identity';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import {
  assertOfflineReplicaGeneratedRemoteId,
  assertOfflineReplicaNaturalKeyBaseline,
  canonicalOfflineRemoteIdentity,
  decodeOfflineReplicaValues,
  encodeOfflineReplicaValues,
  normalizeOfflineNaturalKey,
  offlineNaturalKeyFromValues,
  projectOfflineReplicaValues,
  type OfflineGeneratedRemoteId,
  type OfflineReplicaEntitySchema,
  type OfflineReplicaRemoteIdentity,
  type OfflineReplicaSchemaBundle,
  sha256OfflineReplicaSchema,
} from './offline-replica-schema';
import {
  OFFLINE_SCHEMA_VERSION,
  canonicalOfflineReplicaRowKey,
  type OfflineCommand,
  type OfflineCommandIdentity,
  type OfflinePrincipalId,
  type OfflinePullAttention,
  type OfflinePullAttentionReason,
  type OfflineReplicaAddress,
  type OfflineReplicaCursor,
  type OfflineReplicaIdentity,
  type OfflineReplicaRow,
  type OfflineReplicaRowKey,
  type OfflineReplicaRemoteIdRelease,
  type OfflineRepository,
  type OfflineRepositoryReader,
  type OfflineReplicaTransaction,
  type OfflineScope,
} from './offline-repository';
import { OFFLINE_REPOSITORY_ATOMIC_MUTATION } from './offline-repository-concurrency';
import { OfflineStorageUnavailableError } from './offline-storage';

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
export const COMMUNITY_SQLITE = new InjectionToken<CommunitySqliteDriver | null>('COMMUNITY_SQLITE', {
  factory: () => null,
});

/**
 * Create a cryptographically random 256-bit key for a first-install offline SQLite database.
 *
 * The returned lower-case hexadecimal value is suitable for
 * `OfflineKitOptions.createEncryptionKey` and contains no device or user identifiers.
 */
export function createRandomOfflineEncryptionKey(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Promise.resolve(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
}

/** Create the standard encrypted `@capacitor-community/sqlite` driver. */
export function createCommunitySqliteDriver(connection: CommunitySqliteConnection): CommunitySqliteDriver {
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
  last_user_id TEXT
)`,
  `CREATE TABLE IF NOT EXISTS offline_session_manifests (
  user_id TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS offline_sync_commands (
  command_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  local_only_footprint_json TEXT,
  replica_mutation TEXT NOT NULL DEFAULT 'upsert',
  payload_hash TEXT NOT NULL,
  base_revision_json TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  retry_at INTEGER,
  created_at INTEGER NOT NULL,
  last_error_code TEXT,
  server_commit_unknown INTEGER NOT NULL DEFAULT 0,
  reconciliation_identity_json TEXT
)`,
  `CREATE INDEX IF NOT EXISTS offline_sync_commands_scope_created
  ON offline_sync_commands (user_id, scope_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS offline_replica_schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL CHECK (length(schema_hash) = 64)
)`,
  `CREATE TABLE IF NOT EXISTS offline_replica_cursors (
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  PRIMARY KEY (user_id, scope_id)
  )`,
  `CREATE TABLE IF NOT EXISTS offline_reconciliation_scopes (
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  PRIMARY KEY (user_id, scope_id)
)`,
  `CREATE TABLE IF NOT EXISTS offline_pull_attentions (
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status INTEGER,
  PRIMARY KEY (user_id, scope_id)
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
  #activeReaders = 0;
  #readersIdle: Promise<void> = Promise.resolve();
  #resolveReadersIdle: (() => void) | null = null;
  #atomicMutationRevision: number | null = null;
  #atomicMutationCommitted = false;
  #atomicOperations: Promise<void> = Promise.resolve();
  #readSnapshotActive = false;
  #atomicIdle: Promise<void> = Promise.resolve();
  #resolveAtomicIdle: (() => void) | null = null;

  initialize(): Promise<void> {
    this.#initialization ??= this.#open();
    return this.#initialization;
  }

  async getLastUserId(): Promise<OfflinePrincipalId | null> {
    return this.#withCommittedRead(() => this.#readLastUserId());
  }

  async setLastUserId(userId: OfflinePrincipalId): Promise<void> {
    await this.#write(
      `INSERT INTO offline_metadata (id, schema_version, last_user_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, last_user_id = excluded.last_user_id`,
      [OFFLINE_SCHEMA_VERSION, canonicalOfflinePrincipalId(userId)],
    );
  }

  async getSessionManifest<T>(userId: OfflinePrincipalId): Promise<T | null> {
    return this.#withCommittedRead(() => this.#readSessionManifest<T>(userId));
  }

  async putSessionManifest<T>(userId: OfflinePrincipalId, value: T): Promise<void> {
    await this.#write(
      `INSERT INTO offline_session_manifests (user_id, value_json) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET value_json = excluded.value_json`,
      [canonicalOfflinePrincipalId(userId), JSON.stringify(value)],
    );
  }

  async getReplicaRow<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    return this.#withCommittedRead(async () => {
      const row = await this.#queryReplicaRow(scope, sourceKey, identity, false);
      return row as OfflineReplicaRow<TValues> | null;
    });
  }

  async getReplicaRowIncludingPendingDelete<TValues = unknown>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    return this.#withCommittedRead(async () => {
      const row = await this.#queryReplicaRow(scope, sourceKey, identity, true);
      return row as OfflineReplicaRow<TValues> | null;
    });
  }

  async getReplicaRows<TValues = unknown>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]> {
    return this.#withCommittedRead(() => this.#readReplicaRows(scope, sourceKey));
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
    return this.#withCommittedRead(() => this.#readReplicaRowByRemoteIdentity(scope, sourceKey, identity));
  }

  async getReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null> {
    return this.#withCommittedRead(() => this.#readReplicaCursor(scope));
  }

  async getPullAttentions(userId: OfflinePrincipalId): Promise<OfflinePullAttention[]> {
    return this.#withCommittedRead(() => this.#readPullAttentions(userId));
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    return this.#withCommittedRead(() => this.#readCommands(scope));
  }

  async getCommandsForUser(userId: OfflinePrincipalId): Promise<OfflineCommand[]> {
    return this.#withCommittedRead(() => this.#readCommandsForUser(userId));
  }

  async runReadSnapshot<T>(read: (reader: OfflineRepositoryReader) => Promise<T>): Promise<T> {
    if (this.#atomicMutationRevision !== null) {
      throw new Error('Use the repository passed to an atomic mutation for snapshot reads.');
    }
    return this.#transaction(async () => {
      this.#readSnapshotActive = true;
      try {
        return await read(this.#reader());
      } finally {
        this.#readSnapshotActive = false;
      }
    });
  }

  async [OFFLINE_REPOSITORY_ATOMIC_MUTATION]<T>(operation: (repository: OfflineRepository) => Promise<T>): Promise<T> {
    await this.initialize();
    await this.#writes;
    if (this.#atomicMutationRevision !== null) {
      throw new Error('Nested offline replica atomic mutations are not supported.');
    }
    this.#beginReaders();
    const databaseId = await this.#databaseConnection();
    this.#atomicOperations = Promise.resolve();
    this.#atomicMutationCommitted = false;
    this.#atomicIdle = new Promise<void>((resolve) => {
      this.#resolveAtomicIdle = resolve;
    });
    this.#atomicMutationRevision = await this.#nativeTransaction(databaseId, () => this.#dataVersion(databaseId));
    try {
      const result = await operation(this.#atomicRepository());
      await this.#atomicOperations;
      if (!this.#atomicMutationCommitted) {
        await this.#queueAtomicOperation(() => this.#atomicTransaction(databaseId, async () => undefined, false));
      }
      return result;
    } finally {
      this.#atomicMutationRevision = null;
      this.#endReaders();
      this.#resolveAtomicIdle?.();
      this.#resolveAtomicIdle = null;
      this.#atomicIdle = Promise.resolve();
    }
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

  async putPullAttention(attention: OfflinePullAttention): Promise<void> {
    await this.#write(
      `INSERT INTO offline_pull_attentions (user_id, scope_id, reason, status) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, scope_id) DO UPDATE SET reason = excluded.reason, status = excluded.status`,
      [
        canonicalOfflinePrincipalId(attention.userId),
        attention.scopeId,
        attention.reason,
        attention.status === undefined ? null : attention.status,
      ],
    );
  }

  async removePullAttention(scope: OfflineScope): Promise<void> {
    await this.#write('DELETE FROM offline_pull_attentions WHERE user_id = ? AND scope_id = ?', [
      canonicalOfflinePrincipalId(scope.userId),
      scope.scopeId,
    ]);
  }

  async clearUser(userId: OfflinePrincipalId): Promise<void> {
    await this.#transaction((database) => this.#clearUser(database, userId));
  }

  async #clearUser(database: string, userId: OfflinePrincipalId): Promise<void> {
    const principal = canonicalOfflinePrincipalId(userId);
    await this.#execute(database, 'DELETE FROM offline_session_manifests WHERE user_id = ?', [principal]);
    await this.#execute(database, 'DELETE FROM offline_sync_commands WHERE user_id = ?', [principal]);
    await this.#execute(database, 'DELETE FROM offline_replica_cursors WHERE user_id = ?', [principal]);
    await this.#execute(database, 'DELETE FROM offline_reconciliation_scopes WHERE user_id = ?', [principal]);
    await this.#execute(database, 'DELETE FROM offline_pull_attentions WHERE user_id = ?', [principal]);
    for (const entity of this.#options.replicaSchema.entities) {
      await this.#execute(database, `DELETE FROM ${entity.tableName} WHERE _offline_user_id = ?`, [principal]);
    }
    await this.#execute(database, 'UPDATE offline_metadata SET last_user_id = NULL WHERE id = 1 AND last_user_id = ?', [principal]);
  }

  async clearScope(scope: OfflineScope): Promise<void> {
    await this.#transaction((database) => this.#clearScope(database, scope));
  }

  async #clearScope(database: string, scope: OfflineScope): Promise<void> {
    const values = [canonicalOfflinePrincipalId(scope.userId), scope.scopeId];
    const partitionSourceKeys = this.#options.replicaSchema.entities
      .filter((entity) => entity.scope === 'partition')
      .map((entity) => entity.sourceKey);
    if (partitionSourceKeys.length > 0) {
      await this.#execute(
        database,
        `DELETE FROM offline_sync_commands
           WHERE user_id = ? AND scope_id = ? AND source_key IN (${partitionSourceKeys.map(() => '?').join(', ')})`,
        [...values, ...partitionSourceKeys],
      );
    }
    await this.#execute(database, 'DELETE FROM offline_replica_cursors WHERE user_id = ? AND scope_id = ?', values);
    await this.#execute(database, 'DELETE FROM offline_reconciliation_scopes WHERE user_id = ? AND scope_id = ?', values);
    await this.#execute(database, 'DELETE FROM offline_pull_attentions WHERE user_id = ? AND scope_id = ?', values);
    for (const entity of this.#options.replicaSchema.entities) {
      if (entity.scope !== 'partition') continue;
      await this.#execute(database, `DELETE FROM ${entity.tableName} WHERE _offline_user_id = ? AND _offline_scope_id = ?`, values);
    }
  }

  async transactReplica(transaction: OfflineReplicaTransaction): Promise<void> {
    for (const row of transaction.putRows ?? []) this.#validateReplicaRow(row);
    const apply = (databaseId: string): Promise<void> => this.#applyReplicaTransaction(databaseId, transaction);
    await this.#transaction(apply);
  }

  async #applyReplicaTransaction(databaseId: string, transaction: OfflineReplicaTransaction): Promise<void> {
    const releases = new Map<string, OfflineReplicaRemoteIdRelease>();
    for (const release of transaction.releaseRemoteIds ?? []) {
      this.#assertValidReleaseRemoteId(release.remoteId);
      const key = this.#replicaRowKey(release);
      if (releases.has(key)) {
        throw new Error(
          `Offline replica remoteId release is duplicated for ${release.sourceKey}/${canonicalOfflineReplicaIdentity(release.identity)}.`,
        );
      }
      releases.set(key, release);
    }
    const consumedReleases = new Set<string>();
    for (const row of transaction.putRows ?? []) {
      const key = this.#replicaRowKey(row);
      const release = releases.get(key);
      await this.#putReplicaRow(databaseId, row, release);
      if (release) consumedReleases.add(key);
    }
    if (consumedReleases.size !== releases.size) {
      throw new Error('Offline replica remoteId release must match an existing row in putRows.');
    }
    for (const row of transaction.removeRows ?? []) await this.#removeReplicaRow(databaseId, row);
    for (const command of transaction.putCommands ?? []) await this.#putCommand(databaseId, command);
    for (const commandId of transaction.removeCommandIds ?? []) {
      await this.#execute(databaseId, 'DELETE FROM offline_sync_commands WHERE command_id = ?', [commandId]);
    }
    for (const cursor of transaction.putCursors ?? []) await this.#putReplicaCursor(databaseId, cursor);
    for (const attention of transaction.putPullAttentions ?? []) {
      await this.#execute(
        databaseId,
        `INSERT INTO offline_pull_attentions (user_id, scope_id, reason, status) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, scope_id) DO UPDATE SET reason = excluded.reason, status = excluded.status`,
        [
          canonicalOfflinePrincipalId(attention.userId),
          attention.scopeId,
          attention.reason,
          attention.status === undefined ? null : attention.status,
        ],
      );
    }
    for (const scope of transaction.removePullAttentions ?? []) {
      await this.#execute(databaseId, 'DELETE FROM offline_pull_attentions WHERE user_id = ? AND scope_id = ?', [
        canonicalOfflinePrincipalId(scope.userId),
        scope.scopeId,
      ]);
    }
  }

  async #open(): Promise<void> {
    try {
      if (!this.#sqlite) {
        throw new OfflineStorageUnavailableError('storage_unavailable', 'Native offline storage requires a community SQLite connection');
      }
      const { databaseId } = await this.#sqlite.open({
        databaseName: this.#options.databaseName,
        createEncryptionKey: this.#wrapCreateEncryptionKey(this.#options.createEncryptionKey),
      });
      this.#databaseId = databaseId;
      for (const statement of SCHEMA) await this.#execute(databaseId, statement);
      const metadata = await this.#queryDatabase(databaseId, 'SELECT schema_version FROM offline_metadata WHERE id = 1');
      if (metadata.length === 0) {
        await this.#execute(databaseId, 'INSERT INTO offline_metadata (id, schema_version, last_user_id) VALUES (1, ?, NULL)', [
          OFFLINE_SCHEMA_VERSION,
        ]);
      } else {
        const storedVersion = this.#number(metadata[0]!['schema_version']);
        if (storedVersion !== OFFLINE_SCHEMA_VERSION) {
          throw new OfflineStorageUnavailableError(
            'core_schema_incompatible',
            `Unsupported offline storage schema version ${storedVersion}; expected ${OFFLINE_SCHEMA_VERSION}. ` +
              'A lossless core schema migration is required before this database can be opened.',
          );
        }
      }
      await this.#initializeReplicaSchema(databaseId);
    } catch (error) {
      throw this.#mapInitializationError(error);
    }
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
      throw new OfflineStorageUnavailableError(
        'replica_schema_mismatch',
        `Offline replica schema hash mismatch at version ${targetVersion}. Reinstall the application or bump replicaSchema.version after intentional schema changes.`,
      );
    }

    if (storedVersion > targetVersion) {
      throw new OfflineStorageUnavailableError(
        'replica_schema_mismatch',
        `Offline replica schema version ${storedVersion} is newer than application version ${targetVersion}. Upgrade the application before opening this database.`,
      );
    }

    await this.#nativeTransaction(databaseId, async () => {
      for (let version = storedVersion; version < targetVersion; version++) {
        const migration = bundle.migrations.find((candidate) => candidate.fromVersion === version);
        if (!migration) {
          throw new OfflineStorageUnavailableError(
            'migration_missing',
            `Missing offline replica schema migration from version ${version} to ${version + 1}.`,
          );
        }
        for (const statement of migration.statements) {
          await this.#execute(databaseId, statement);
        }
      }
      await this.#executeReplicaCreateStatements(databaseId, bundle);
      await this.#upsertReplicaSchemaMetadata(databaseId, targetVersion, targetHash);
    });
  }

  #wrapCreateEncryptionKey(createEncryptionKey: (() => Promise<string>) | undefined): (() => Promise<string>) | undefined {
    if (!createEncryptionKey) return undefined;
    return async () => {
      try {
        const encryptionKey = await createEncryptionKey();
        if (!encryptionKey) {
          throw new OfflineStorageUnavailableError(
            'encryption_key_unavailable',
            'Native offline storage requires a non-empty encryption key on first open',
          );
        }
        return encryptionKey;
      } catch (error) {
        if (error instanceof OfflineStorageUnavailableError) throw error;
        throw new OfflineStorageUnavailableError(
          'encryption_key_unavailable',
          error instanceof Error ? error.message : 'Offline encryption key is unavailable.',
          { cause: error },
        );
      }
    };
  }

  #mapInitializationError(error: unknown): OfflineStorageUnavailableError {
    if (error instanceof OfflineStorageUnavailableError) return error;
    const message = error instanceof Error ? error.message : 'Offline storage is unavailable.';
    if (message.includes('non-empty encryption key on first open')) {
      return new OfflineStorageUnavailableError('encryption_key_unavailable', message, { cause: error });
    }
    return new OfflineStorageUnavailableError('storage_unavailable', message || 'Offline storage is unavailable.', {
      cause: error,
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

  async #nativeTransaction<T>(databaseId: string, run: () => Promise<T>): Promise<T> {
    await this.#sqlite!.beginTransaction({ databaseId });
    try {
      const result = await run();
      await this.#sqlite!.commitTransaction({ databaseId });
      return result;
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

  async #readLastUserId(): Promise<OfflinePrincipalId | null> {
    const rows = await this.#query('SELECT last_user_id FROM offline_metadata WHERE id = 1');
    const value = this.#stringOrNull(rows[0]?.['last_user_id']);
    return value === null ? null : parseOfflinePrincipalId(value);
  }

  async #readSessionManifest<T>(userId: OfflinePrincipalId): Promise<T | null> {
    const rows = await this.#query('SELECT value_json FROM offline_session_manifests WHERE user_id = ?', [
      canonicalOfflinePrincipalId(userId),
    ]);
    const row = rows[0];
    return row ? this.#parse<T>(row['value_json']) : null;
  }

  async #readReplicaRows<TValues>(scope: OfflineScope, sourceKey: string): Promise<OfflineReplicaRow<TValues>[]> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const predicates = ['_offline_user_id = ?'];
    const values: SQLiteValue[] = [canonicalOfflinePrincipalId(scope.userId)];
    if (schema.scope === 'partition') {
      predicates.push('_offline_scope_id = ?');
      values.push(scope.scopeId);
    }
    const orderBy =
      schema.identity.kind === 'naturalKey'
        ? schema.identity.sourceKeys.map((key) => schema.fields.find((field) => field.sourceKey === key)!.sqliteColumnName!).join(', ')
        : 'local_id ASC';
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')} ORDER BY ${orderBy}`, values);
    return rows
      .filter((row) => (row['_offline_visibility'] ?? 'present') !== 'pending_delete')
      .map((row) => this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, row));
  }

  async #readReplicaRowByRemoteIdentity<TValues>(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaRemoteIdentity,
  ): Promise<OfflineReplicaRow<TValues> | null> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    canonicalOfflineRemoteIdentity(schema, identity);
    if (schema.identity.kind === 'generated') {
      const predicates = ['server_id = ?', '_offline_user_id = ?'];
      const values: SQLiteValue[] = [identity.remoteId!, canonicalOfflinePrincipalId(scope.userId)];
      if (schema.scope === 'partition') {
        predicates.push('_offline_scope_id = ?');
        values.push(scope.scopeId);
      }
      const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
      const row = rows[0];
      return row ? this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, row) : null;
    }
    const naturalKey = normalizeOfflineNaturalKey(schema, identity.naturalKey!);
    const predicates = ['_offline_user_id = ?'];
    const values: SQLiteValue[] = [canonicalOfflinePrincipalId(scope.userId)];
    if (schema.scope === 'partition') {
      predicates.push('_offline_scope_id = ?');
      values.push(scope.scopeId);
    }
    for (const sourceKeyPart of schema.identity.sourceKeys) {
      const field = schema.fields.find((candidate) => candidate.sourceKey === sourceKeyPart)!;
      predicates.push(`${field.sqliteColumnName!} = ?`);
      values.push(naturalKey[sourceKeyPart]!);
    }
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
    const row = rows[0];
    return row ? this.#replicaRowFromSqliteRow<TValues>(schema, scope, sourceKey, row) : null;
  }

  async #readReplicaCursor(scope: OfflineScope): Promise<OfflineReplicaCursor | null> {
    const rows = await this.#query('SELECT cursor FROM offline_replica_cursors WHERE user_id = ? AND scope_id = ?', [
      canonicalOfflinePrincipalId(scope.userId),
      scope.scopeId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return { ...scope, cursor: this.#string(row['cursor']) };
  }

  async #readPullAttentions(userId: OfflinePrincipalId): Promise<OfflinePullAttention[]> {
    const rows = await this.#query('SELECT scope_id, reason, status FROM offline_pull_attentions WHERE user_id = ? ORDER BY scope_id', [
      canonicalOfflinePrincipalId(userId),
    ]);
    return rows.map((row) => {
      const status = row['status'];
      const attention: OfflinePullAttention = {
        userId,
        scopeId: this.#string(row['scope_id']),
        reason: this.#string(row['reason']) as OfflinePullAttentionReason,
      };
      if (status !== null && status !== undefined) attention.status = this.#number(status);
      return attention;
    });
  }

  async #readCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    const rows = await this.#query(
      'SELECT * FROM offline_sync_commands WHERE user_id = ? AND scope_id = ? ORDER BY created_at ASC, command_id ASC',
      [canonicalOfflinePrincipalId(scope.userId), scope.scopeId],
    );
    return rows.map((row) => this.#command(row));
  }

  async #readCommandsForUser(userId: OfflinePrincipalId): Promise<OfflineCommand[]> {
    const rows = await this.#query('SELECT * FROM offline_sync_commands WHERE user_id = ? ORDER BY created_at ASC, command_id ASC', [
      canonicalOfflinePrincipalId(userId),
    ]);
    return rows.map((row) => this.#command(row));
  }

  #reader(): OfflineRepositoryReader {
    return {
      getLastUserId: () => this.#readLastUserId(),
      getSessionManifest: (userId) => this.#readSessionManifest(userId),
      getReplicaRow: async <TValues = unknown>(
        scope: OfflineScope,
        sourceKey: string,
        identity: OfflineReplicaAddress,
      ): Promise<OfflineReplicaRow<TValues> | null> =>
        (await this.#queryReplicaRow(scope, sourceKey, identity, false)) as OfflineReplicaRow<TValues> | null,
      getReplicaRowIncludingPendingDelete: async <TValues = unknown>(
        scope: OfflineScope,
        sourceKey: string,
        identity: OfflineReplicaAddress,
      ): Promise<OfflineReplicaRow<TValues> | null> =>
        (await this.#queryReplicaRow(scope, sourceKey, identity, true)) as OfflineReplicaRow<TValues> | null,
      getReplicaRows: (scope, sourceKey) => this.#readReplicaRows(scope, sourceKey),
      getReplicaRowByRemoteId: async (scope, sourceKey, remoteId) => {
        if (this.#resolveReplicaEntitySchema(sourceKey).identity.kind !== 'generated') return null;
        return this.#readReplicaRowByRemoteIdentity(scope, sourceKey, { remoteId });
      },
      getReplicaRowByRemoteIdentity: (scope, sourceKey, identity) => this.#readReplicaRowByRemoteIdentity(scope, sourceKey, identity),
      getReplicaCursor: (scope) => this.#readReplicaCursor(scope),
      getPullAttentions: (userId) => this.#readPullAttentions(userId),
      getCommands: (scope) => this.#readCommands(scope),
      getCommandsForUser: (userId) => this.#readCommandsForUser(userId),
    };
  }

  #atomicRepository(): OfflineRepository {
    const reader = this.#reader();
    const atomicTransaction = <T>(run: (databaseId: string) => Promise<T>, marksCommit = true): Promise<T> =>
      this.#queueAtomicOperation(() => this.#atomicTransaction(this.#databaseId!, run, marksCommit));
    return {
      initialize: () => Promise.resolve(),
      ...reader,
      runReadSnapshot: (read) =>
        this.#queueAtomicOperation(() =>
          this.#nativeTransaction(this.#databaseId!, async () => {
            this.#readSnapshotActive = true;
            try {
              return await read(reader);
            } finally {
              this.#readSnapshotActive = false;
            }
          }),
        ),
      putCommand: (command) => atomicTransaction((databaseId) => this.#putCommand(databaseId, command)),
      replaceCommand: (command) => atomicTransaction((databaseId) => this.#putCommand(databaseId, command)),
      removeCommand: (commandId) =>
        atomicTransaction((databaseId) => this.#execute(databaseId, 'DELETE FROM offline_sync_commands WHERE command_id = ?', [commandId])),
      putPullAttention: (attention) =>
        atomicTransaction((databaseId) => this.#applyReplicaTransaction(databaseId, { putPullAttentions: [attention] })),
      removePullAttention: (scope) =>
        atomicTransaction((databaseId) => this.#applyReplicaTransaction(databaseId, { removePullAttentions: [scope] })),
      setLastUserId: (userId) =>
        atomicTransaction((databaseId) =>
          this.#execute(
            databaseId,
            `INSERT INTO offline_metadata (id, schema_version, last_user_id) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, last_user_id = excluded.last_user_id`,
            [OFFLINE_SCHEMA_VERSION, canonicalOfflinePrincipalId(userId)],
          ),
        ),
      putSessionManifest: (userId, value) =>
        atomicTransaction((databaseId) =>
          this.#execute(
            databaseId,
            `INSERT INTO offline_session_manifests (user_id, value_json) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET value_json = excluded.value_json`,
            [canonicalOfflinePrincipalId(userId), JSON.stringify(value)],
          ),
        ),
      clearUser: (userId) => atomicTransaction((databaseId) => this.#clearUser(databaseId, userId)),
      clearScope: (scope) => atomicTransaction((databaseId) => this.#clearScope(databaseId, scope)),
      transactReplica: (transaction) => {
        for (const row of transaction.putRows ?? []) this.#validateReplicaRow(row);
        return atomicTransaction((databaseId) => this.#applyReplicaTransaction(databaseId, transaction));
      },
    };
  }

  async #withCommittedRead<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    if (this.#readSnapshotActive) {
      return operation();
    }
    if (this.#atomicMutationRevision !== null) {
      return this.#queueAtomicOperation(operation);
    }
    await this.#writes;
    this.#beginReaders();
    try {
      return await operation();
    } finally {
      this.#endReaders();
    }
  }

  #beginReaders(): void {
    if (this.#activeReaders === 0) {
      this.#readersIdle = new Promise<void>((resolve) => {
        this.#resolveReadersIdle = resolve;
      });
    }
    this.#activeReaders += 1;
  }

  #endReaders(): void {
    this.#activeReaders -= 1;
    if (this.#activeReaders === 0) {
      this.#resolveReadersIdle?.();
      this.#resolveReadersIdle = null;
      this.#readersIdle = Promise.resolve();
    }
  }

  async #query(statement: string, values: SQLiteValue[] = []): Promise<SQLiteRow[]> {
    return this.#queryDatabase(await this.#databaseConnection(), statement, values);
  }

  #write(statement: string, values: SQLiteValue[]): Promise<void> {
    return this.#queueWrite((databaseId) => this.#execute(databaseId, statement, values));
  }

  #queueWrite(run: (databaseId: string) => Promise<void>): Promise<void> {
    if (this.#atomicMutationRevision !== null) {
      return this.#atomicIdle.then(() => this.#queueWrite(run));
    }
    const write = this.#writes.then(async (): Promise<void> => {
      if (this.#activeReaders > 0) await this.#readersIdle;
      await run(await this.#databaseConnection());
    });
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #transaction<T>(run: (databaseId: string) => Promise<T>): Promise<T> {
    if (this.#atomicMutationRevision !== null) {
      return this.#atomicIdle.then(() => this.#transaction(run));
    }
    const transaction = this.#writes.then(async (): Promise<T> => {
      if (this.#activeReaders > 0) await this.#readersIdle;
      const databaseId = await this.#databaseConnection();
      return this.#nativeTransaction(databaseId, () => run(databaseId));
    });
    this.#writes = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  async #atomicTransaction<T>(databaseId: string, run: (databaseId: string) => Promise<T>, marksCommit = true): Promise<T> {
    const expected = this.#atomicMutationRevision;
    if (expected === null) throw new Error('Offline replica atomic mutation is not active.');
    const result = await this.#nativeTransaction(databaseId, async () => {
      // A write, even when it leaves the value unchanged, obtains SQLite's
      // RESERVED lock before the revision check. No second connection can
      // commit between this check and the transaction commit.
      await this.#execute(databaseId, 'UPDATE offline_metadata SET schema_version = schema_version WHERE id = 1');
      const actual = await this.#dataVersion(databaseId);
      if (actual !== expected) {
        throw new Error('Offline replica changed through another SQLite connection; retry the operation from fresh state.');
      }
      return run(databaseId);
    });
    if (marksCommit) this.#atomicMutationCommitted = true;
    return result;
  }

  #queueAtomicOperation<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.#atomicOperations.then(run);
    this.#atomicOperations = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #dataVersion(databaseId: string): Promise<number> {
    const rows = await this.#queryDatabase(databaseId, 'PRAGMA data_version');
    return this.#number(rows[0]?.['data_version']);
  }

  #command(row: SQLiteRow): OfflineCommand {
    return {
      commandId: this.#string(row['command_id']),
      userId: parseOfflinePrincipalId(this.#string(row['user_id'])),
      scopeId: this.#string(row['scope_id']),
      aggregateType: this.#string(row['aggregate_type']),
      sourceKey: this.#string(row['source_key']),
      identity: parseOfflineCommandIdentity(this.#parse(row['identity_json'])),
      operation: this.#string(row['operation']),
      payload: this.#parse(row['payload_json']),
      ...(row['local_only_footprint_json'] === null || row['local_only_footprint_json'] === undefined
        ? {}
        : { localOnlyFootprint: this.#parse(row['local_only_footprint_json']) }),
      replicaMutation: this.#string(row['replica_mutation']) as 'upsert' | 'delete',
      baseRevision: this.#parseNullable(row['base_revision_json']),
      state: this.#string(row['state']) as OfflineCommand['state'],
      attempts: this.#number(row['attempts']),
      retryAt: this.#numberOrNull(row['retry_at']),
      createdAt: this.#number(row['created_at']),
      lastErrorCode: this.#stringOrNull(row['last_error_code']),
      serverCommitUnknown: this.#numberOrNull(row['server_commit_unknown']) === 1,
      ...(row['reconciliation_identity_json'] === null || row['reconciliation_identity_json'] === undefined
        ? {}
        : { reconciliationIdentity: this.#parse(row['reconciliation_identity_json']) as OfflineCommand['reconciliationIdentity'] }),
    };
  }

  #putCommand(databaseId: string, command: OfflineCommand): Promise<void> {
    return this.#execute(
      databaseId,
      `INSERT INTO offline_sync_commands
        (command_id, user_id, scope_id, aggregate_type, source_key, identity_json, operation, payload_json,
         local_only_footprint_json, replica_mutation, payload_hash, base_revision_json, state, attempts, retry_at, created_at, last_error_code,
         server_commit_unknown, reconciliation_identity_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(command_id) DO UPDATE SET
        user_id = excluded.user_id, scope_id = excluded.scope_id, aggregate_type = excluded.aggregate_type,
        source_key = excluded.source_key,
        identity_json = excluded.identity_json, operation = excluded.operation, payload_json = excluded.payload_json,
        local_only_footprint_json = excluded.local_only_footprint_json,
        replica_mutation = excluded.replica_mutation,
        payload_hash = excluded.payload_hash,
        base_revision_json = excluded.base_revision_json, state = excluded.state, attempts = excluded.attempts,
        retry_at = excluded.retry_at, created_at = excluded.created_at, last_error_code = excluded.last_error_code,
        server_commit_unknown = excluded.server_commit_unknown,
        reconciliation_identity_json = excluded.reconciliation_identity_json`,
      [
        command.commandId,
        canonicalOfflinePrincipalId(command.userId),
        command.scopeId,
        command.aggregateType,
        command.sourceKey,
        serializeOfflineCommandIdentity(command.identity),
        command.operation,
        JSON.stringify(command.payload),
        command.localOnlyFootprint === undefined ? null : JSON.stringify(command.localOnlyFootprint),
        command.replicaMutation ?? 'upsert',
        '',
        this.#stringifyNullable(command.baseRevision),
        command.state,
        command.attempts,
        command.retryAt,
        command.createdAt,
        command.lastErrorCode,
        command.serverCommitUnknown === true ? 1 : 0,
        command.reconciliationIdentity === undefined ? null : JSON.stringify(command.reconciliationIdentity),
      ],
    );
  }

  async #queryReplicaRow(
    scope: OfflineScope,
    sourceKey: string,
    identity: OfflineReplicaAddress,
    includePendingDelete: boolean,
  ): Promise<OfflineReplicaRow | null> {
    const schema = this.#resolveReplicaEntitySchema(sourceKey);
    const predicates = ['_offline_user_id = ?'];
    const values: SQLiteValue[] = [canonicalOfflinePrincipalId(scope.userId)];
    if (schema.scope === 'partition') {
      predicates.push('_offline_scope_id = ?');
      values.push(scope.scopeId);
    }
    if (identity.kind === 'generated' || identity.kind === 'local') {
      if (
        (identity.kind === 'generated' && schema.identity.kind !== 'generated') ||
        (identity.kind === 'local' && schema.identity.kind !== 'localOnly')
      ) {
        return null;
      }
      predicates.push('local_id = ?');
      values.push(identity.localId);
    } else {
      const naturalKey = normalizeOfflineNaturalKey(schema, identity.naturalKey);
      for (const sourceKeyPart of schema.identity.sourceKeys) {
        const field = schema.fields.find((candidate) => candidate.sourceKey === sourceKeyPart)!;
        predicates.push(`${field.sqliteColumnName!} = ?`);
        values.push(naturalKey[sourceKeyPart]!);
      }
    }
    const rows = await this.#query(`SELECT * FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
    const row = rows[0];
    if (!row || (!includePendingDelete && (row['_offline_visibility'] ?? 'present') === 'pending_delete')) return null;
    return this.#replicaRowFromSqliteRow(schema, scope, sourceKey, row);
  }

  async #putReplicaRow(databaseId: string, row: OfflineReplicaRow, release: OfflineReplicaRemoteIdRelease | undefined): Promise<void> {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    if (row.identity.kind === 'generated') {
      assertOfflineReplicaGeneratedRemoteId(schema, row.identity.remoteId);
    }
    if (schema.identity.kind === 'naturalKey') {
      if (row.identity.kind !== 'natural') {
        throw new Error(`Offline replica source "${row.sourceKey}" requires natural identity.`);
      }
      const valuesIdentity = offlineNaturalKeyFromValues(schema, row.values)!;
      if (
        canonicalOfflineRemoteIdentity(schema, { naturalKey: row.identity.naturalKey }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: valuesIdentity })
      ) {
        throw new Error(`Offline replica identity naturalKey must match values for "${schema.sourceKey}".`);
      }
    }
    const encoded = encodeOfflineReplicaValues(schema, row.values);
    if (row.confirmedValues !== null) encodeOfflineReplicaValues(schema, row.confirmedValues);
    assertOfflineReplicaNaturalKeyBaseline(schema, row.values, row.confirmedValues);
    const existing = await this.#queryReplicaRow(row, row.sourceKey, replicaAddressFromIdentity(row.identity), true);
    if (!existing && release) {
      throw new Error(
        `Offline replica remoteId release requires an existing row for ${row.sourceKey}/${canonicalOfflineReplicaIdentity(row.identity)}.`,
      );
    }
    if (existing) this.#assertReplicaIdentityAssignment(schema, existing, row, release);
    const confirmedValues = row.confirmedValues === null ? null : projectOfflineReplicaValues(schema, row.confirmedValues);
    const { sql, domainColumns } = this.#buildReplicaUpsertStatement(schema);
    const values: SQLiteValue[] = [];
    if (schema.identity.kind === 'generated' || schema.identity.kind === 'localOnly') {
      const expectedKind = schema.identity.kind === 'generated' ? 'generated' : 'local';
      if (row.identity.kind !== expectedKind) {
        throw new Error(`Offline replica source "${row.sourceKey}" requires ${expectedKind} identity.`);
      }
      values.push(row.identity.localId);
    }
    values.push(canonicalOfflinePrincipalId(row.userId));
    if (schema.scope === 'partition') values.push(row.scopeId);
    if (schema.identity.kind === 'generated') {
      if (row.identity.kind !== 'generated') {
        throw new Error(`Offline replica source "${row.sourceKey}" requires generated identity.`);
      }
      values.push(row.identity.remoteId);
    }
    values.push(
      confirmedValues === null ? null : JSON.stringify(confirmedValues),
      row.serverRevision == null ? null : JSON.stringify(row.serverRevision),
      row.syncState,
      row.visibility ?? 'present',
      row.fetchedAt,
      ...domainColumns.map((column) => encoded[column] ?? null),
    );
    await this.#execute(databaseId, sql, values);
  }

  #removeReplicaRow(databaseId: string, key: OfflineReplicaRowKey): Promise<void> {
    const schema = this.#resolveReplicaEntitySchema(key.sourceKey);
    const predicates = ['_offline_user_id = ?'];
    const values: SQLiteValue[] = [canonicalOfflinePrincipalId(key.userId)];
    if (schema.scope === 'partition') {
      predicates.push('_offline_scope_id = ?');
      values.push(key.scopeId);
    }
    if (key.identity.kind === 'generated' || key.identity.kind === 'local') {
      predicates.push('local_id = ?');
      values.push(key.identity.localId);
    } else {
      for (const sourceKeyPart of schema.identity.sourceKeys) {
        const field = schema.fields.find((candidate) => candidate.sourceKey === sourceKeyPart)!;
        predicates.push(`${field.sqliteColumnName!} = ?`);
        values.push(key.identity.naturalKey[sourceKeyPart]!);
      }
    }
    return this.#execute(databaseId, `DELETE FROM ${schema.tableName} WHERE ${predicates.join(' AND ')}`, values);
  }

  #putReplicaCursor(databaseId: string, cursor: OfflineReplicaCursor): Promise<void> {
    return this.#execute(
      databaseId,
      `INSERT INTO offline_replica_cursors (user_id, scope_id, cursor) VALUES (?, ?, ?)
       ON CONFLICT(user_id, scope_id) DO UPDATE SET cursor = excluded.cursor`,
      [canonicalOfflinePrincipalId(cursor.userId), cursor.scopeId, cursor.cursor],
    );
  }

  #buildReplicaUpsertStatement(schema: OfflineReplicaEntitySchema<Record<string, unknown>>): {
    sql: string;
    domainColumns: readonly string[];
  } {
    const insertColumns = ['_offline_user_id'];
    const updateSets = ['_offline_user_id = excluded._offline_user_id'];
    const conflictTarget: string[] = ['_offline_user_id'];
    if (schema.scope === 'partition') {
      insertColumns.push('_offline_scope_id');
      updateSets.push('_offline_scope_id = excluded._offline_scope_id');
      conflictTarget.push('_offline_scope_id');
    }
    if (schema.identity.kind === 'generated') {
      insertColumns.unshift('local_id');
      insertColumns.push('server_id');
      updateSets.push('server_id = excluded.server_id');
      conflictTarget.push('local_id');
    } else if (schema.identity.kind === 'naturalKey') {
      for (const sourceKey of schema.identity.sourceKeys) {
        const field = schema.fields.find((candidate) => candidate.sourceKey === sourceKey)!;
        conflictTarget.push(field.sqliteColumnName!);
      }
    } else {
      insertColumns.unshift('local_id');
      conflictTarget.push('local_id');
    }
    insertColumns.push(
      '_offline_confirmed_json',
      '_offline_server_revision_json',
      '_offline_sync_state',
      '_offline_visibility',
      '_offline_fetched_at',
    );
    updateSets.push(
      '_offline_confirmed_json = excluded._offline_confirmed_json',
      '_offline_server_revision_json = excluded._offline_server_revision_json',
      '_offline_sync_state = excluded._offline_sync_state',
      '_offline_visibility = excluded._offline_visibility',
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
       ON CONFLICT(${conflictTarget.join(', ')}) DO UPDATE SET ${updateSets.join(', ')}`,
      domainColumns,
    };
  }

  #replicaRowFromSqliteRow<TValues>(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    scope: OfflineScope,
    sourceKey: string,
    row: SQLiteRow,
  ): OfflineReplicaRow<TValues> {
    const identity = this.#identityFromSqliteRow(schema, row);
    return {
      ...scope,
      sourceKey,
      identity,
      values: decodeOfflineReplicaValues(schema, row) as TValues,
      confirmedValues: this.#parseNullable<TValues>(row['_offline_confirmed_json']),
      serverRevision: this.#parseNullable<string | number>(row['_offline_server_revision_json']),
      fetchedAt: this.#number(row['_offline_fetched_at']),
      syncState: this.#string(row['_offline_sync_state']) as OfflineReplicaRow['syncState'],
      visibility: (row['_offline_visibility'] ?? 'present') as 'present' | 'pending_delete',
    };
  }

  #identityFromSqliteRow(schema: OfflineReplicaEntitySchema<Record<string, unknown>>, row: SQLiteRow): OfflineReplicaIdentity {
    if (schema.identity.kind === 'naturalKey') {
      return offlineNaturalReplicaIdentity(schema, decodeOfflineReplicaValues(schema, row));
    }
    const localId = this.#string(row['local_id']);
    if (schema.identity.kind === 'localOnly') return { kind: 'local', localId };
    const remoteId = row['server_id'];
    if (remoteId == null) return offlineGeneratedReplicaIdentity(localId, null);
    if (schema.identity.kind === 'generated' && schema.identity.affinity === 'TEXT') {
      return offlineGeneratedReplicaIdentity(localId, this.#string(remoteId));
    }
    return offlineGeneratedReplicaIdentity(localId, this.#number(remoteId));
  }

  #resolveReplicaEntitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }

  #validateReplicaRow(row: OfflineReplicaRow): void {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    if (schema.identity.kind === 'localOnly') {
      if (row.identity.kind !== 'local') {
        throw new Error(`Offline replica source "${schema.sourceKey}" requires local identity.`);
      }
    } else if (schema.identity.kind === 'generated') {
      if (row.identity.kind !== 'generated') {
        throw new Error(`Offline replica source "${schema.sourceKey}" requires generated identity.`);
      }
      assertOfflineReplicaGeneratedRemoteId(schema, row.identity.remoteId);
    } else {
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
    encodeOfflineReplicaValues(schema, row.values);
    if (row.confirmedValues !== null) encodeOfflineReplicaValues(schema, row.confirmedValues);
    assertOfflineReplicaNaturalKeyBaseline(schema, row.values, row.confirmedValues);
  }

  #replicaRowKey(row: OfflineReplicaRowKey): string {
    const schema = this.#resolveReplicaEntitySchema(row.sourceKey);
    return canonicalOfflineReplicaRowKey(schema, row);
  }

  #assertReplicaIdentityAssignment(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    existing: OfflineReplicaRow,
    incoming: OfflineReplicaRow,
    release: OfflineReplicaRemoteIdRelease | undefined,
  ): void {
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

  #assertValidReleaseRemoteId(remoteId: import('./offline-replica-schema').OfflineGeneratedRemoteId): void {
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
