import { Capacitor } from '@capacitor/core';
import {
  COMMUNITY_SQLITE_ENCRYPTED,
  COMMUNITY_SQLITE_MODE,
  COMMUNITY_SQLITE_READONLY,
  COMMUNITY_SQLITE_VERSION,
} from './offline-community-sqlite-config';

/** Durable marker store used to request a cold-start local reset. */
export interface OfflineLocalResetMarkerStore {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** Minimal page reload surface used after a reset request is persisted. */
export interface OfflineLocalResetReloadTarget {
  reload(): void;
}

/** Native SQLite connection lifecycle required to delete Kit's database safely. */
export interface OfflineLocalResetSqliteConnection {
  checkConnectionsConsistency(): Promise<{ result?: boolean }>;
  isDatabase(database: string): Promise<{ result?: boolean }>;
  isDatabaseEncrypted?(database: string): Promise<{ result?: boolean }>;
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<{ delete(): Promise<void> }>;
  closeConnection(database: string, readonly: boolean): Promise<void>;
  clearEncryptionSecret?(): Promise<void>;
}

/** Options for {@link requestOfflineLocalReset}. */
export interface RequestOfflineLocalResetOptions {
  markerStore: OfflineLocalResetMarkerStore;
  markerKey: string;
  reloadTarget?: OfflineLocalResetReloadTarget;
}

/** Options for {@link recoverOfflineLocalReset}. */
export interface RecoverOfflineLocalResetOptions {
  markerStore: OfflineLocalResetMarkerStore;
  markerKey: string;
  sqliteConnection: OfflineLocalResetSqliteConnection;
  /**
   * Kit database followed only by product databases using Kit's same encryption
   * mode, connection-version-1, read/write lifecycle.
   * Delete databases with other connection settings in {@link additionalCleanup}.
   */
  kitCompatibleDatabaseNames: readonly [string, ...string[]];
  /** Connection mode used only to obtain the public `delete()` handle. Defaults to encrypted for compatibility. */
  databaseEncryption?: boolean;
  nativePlatform?: boolean;
  /** Product-owned cleanup, such as a media database or files, run before the marker is removed. */
  additionalCleanup?: () => Promise<void>;
}

/** Options for a versioned destructive encryption-mode migration. */
export interface MigrateOfflineDatabaseEncryptionOptions {
  markerStore: OfflineLocalResetMarkerStore;
  markerKey: string;
  migrationVersion: string;
  sqliteConnection: OfflineLocalResetSqliteConnection;
  kitCompatibleDatabaseNames: readonly [string, ...string[]];
  /** Existing database mode used only to obtain a valid public `delete()` handle. */
  sourceDatabaseEncryption: boolean | 'detect';
  /** Removes the obsolete plugin secret after every database and product cleanup succeeds. */
  clearEncryptionSecret?: boolean;
  nativePlatform?: boolean;
  additionalCleanup?: () => Promise<void>;
}

const OFFLINE_LOCAL_RESET_REQUESTED = 'requested';

/** Persists an explicit destructive reset request, then reloads into a cold bootstrap. */
export async function requestOfflineLocalReset(options: RequestOfflineLocalResetOptions): Promise<void> {
  await options.markerStore.set({ key: options.markerKey, value: OFFLINE_LOCAL_RESET_REQUESTED });
  const reloadTarget = options.reloadTarget ?? globalThis.location;
  reloadTarget.reload();
}

/**
 * Recovers an explicit reset request before Angular and Kit open native SQLite.
 *
 * The marker is removed only after the Kit database and every product cleanup succeed.
 * Kit never invokes this helper automatically in response to a storage failure.
 */
export async function recoverOfflineLocalReset(options: RecoverOfflineLocalResetOptions): Promise<boolean> {
  if (!(options.nativePlatform ?? Capacitor.isNativePlatform())) return false;
  const marker = await options.markerStore.get({ key: options.markerKey });
  if (marker.value !== OFFLINE_LOCAL_RESET_REQUESTED) return false;

  await resetOfflineDatabases({
    sqliteConnection: options.sqliteConnection,
    databaseNames: options.kitCompatibleDatabaseNames,
    databaseEncryption: options.databaseEncryption ?? COMMUNITY_SQLITE_ENCRYPTED,
    additionalCleanup: options.additionalCleanup,
  });
  await options.markerStore.remove({ key: options.markerKey });
  return true;
}

/**
 * Deletes native databases once when changing their encryption mode.
 *
 * Products with a remote source of truth can use this before Angular bootstrap instead of
 * decrypting local replicas. The completion marker is written only after every deletion and
 * product cleanup succeeds, so interruption retries safely on the next cold start.
 */
export async function migrateOfflineDatabaseEncryption(options: MigrateOfflineDatabaseEncryptionOptions): Promise<boolean> {
  if (!(options.nativePlatform ?? Capacitor.isNativePlatform())) return false;
  const marker = await options.markerStore.get({ key: options.markerKey });
  if (marker.value === options.migrationVersion) return false;

  await resetOfflineDatabases({
    sqliteConnection: options.sqliteConnection,
    databaseNames: options.kitCompatibleDatabaseNames,
    databaseEncryption: options.sourceDatabaseEncryption,
    additionalCleanup: options.additionalCleanup,
  });
  if (options.clearEncryptionSecret) {
    if (!options.sqliteConnection.clearEncryptionSecret) {
      throw new Error('SQLite connection does not support clearing the obsolete encryption secret.');
    }
    await options.sqliteConnection.clearEncryptionSecret();
  }
  await options.markerStore.set({ key: options.markerKey, value: options.migrationVersion });
  return true;
}

async function resetOfflineDatabases(options: {
  sqliteConnection: OfflineLocalResetSqliteConnection;
  databaseNames: readonly [string, ...string[]];
  databaseEncryption: boolean | 'detect';
  additionalCleanup?: () => Promise<void>;
}): Promise<void> {
  await options.sqliteConnection.checkConnectionsConsistency();
  for (const databaseName of new Set(options.databaseNames)) {
    const exists = await options.sqliteConnection.isDatabase(databaseName);
    if (!exists.result) continue;
    const databaseEncryption = await resolveOfflineDatabaseEncryption(options.sqliteConnection, databaseName, options.databaseEncryption);
    const connection = await options.sqliteConnection.createConnection(
      databaseName,
      databaseEncryption,
      databaseEncryption ? COMMUNITY_SQLITE_MODE : 'no-encryption',
      COMMUNITY_SQLITE_VERSION,
      COMMUNITY_SQLITE_READONLY,
    );
    await deleteAndCloseOfflineDatabase(options.sqliteConnection, databaseName, connection);
  }
  await options.additionalCleanup?.();
}

async function resolveOfflineDatabaseEncryption(
  sqliteConnection: OfflineLocalResetSqliteConnection,
  databaseName: string,
  configured: boolean | 'detect',
): Promise<boolean> {
  if (configured !== 'detect') return configured;
  if (!sqliteConnection.isDatabaseEncrypted) {
    throw new Error('SQLite connection does not support detecting the existing database encryption mode.');
  }
  const result = await sqliteConnection.isDatabaseEncrypted(databaseName);
  return result.result === true;
}

type OfflineResetOperationResult = { ok: true } | { ok: false; error: unknown };

async function settleOfflineResetOperation(operation: () => Promise<void>): Promise<OfflineResetOperationResult> {
  return new Promise<void>((resolve) => resolve(operation())).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
}

async function deleteAndCloseOfflineDatabase(
  sqliteConnection: OfflineLocalResetSqliteConnection,
  databaseName: string,
  connection: { delete(): Promise<void> },
): Promise<void> {
  const deletion = await settleOfflineResetOperation(() => connection.delete());
  const closing = await settleOfflineResetOperation(() => sqliteConnection.closeConnection(databaseName, COMMUNITY_SQLITE_READONLY));
  if (!deletion.ok && !closing.ok) {
    throw new AggregateError([deletion.error, closing.error], `Offline database ${databaseName} delete and close both failed.`);
  }
  if (!deletion.ok) throw deletion.error;
  if (!closing.ok) throw closing.error;
}
