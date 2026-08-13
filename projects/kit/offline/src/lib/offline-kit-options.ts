import { InjectionToken } from '@angular/core';
import type { OfflineReplicaSchemaBundle } from './offline-replica-schema';
import type { OfflineStorageUnavailableError } from './offline-storage';

/** Backpressure limits for durable commands. Pending commands are never evicted automatically. */
export interface OfflineOutboxLimits {
  /** Maximum number of commands retained for one user. Defaults to 1,000. */
  maxCommandsPerUser?: number;
  /** Maximum serialized size retained for one user. Defaults to 10 MiB. */
  maxBytesPerUser?: number;
}

/** Product-independent native offline persistence settings. */
export interface OfflineKitOptions {
  /** Runtime transport mode. Defaults to full synchronized replica/outbox behavior. */
  mode?: 'synchronized' | 'readCacheOnly';
  /** Encrypted SQLite database name used on iOS and Android. */
  databaseName: string;
  /** Creates the native database encryption key on first install. Required on iOS and Android. */
  createEncryptionKey?: () => Promise<string>;
  /** Versioned product replica schema applied to native SQLite during initialization. */
  replicaSchema: OfflineReplicaSchemaBundle;
  /**
   * Product wire protocol fingerprint exchanged with the synchronization server.
   *
   * Keep this independent from {@link replicaSchema}: local-only tables and
   * storage migrations must not force a server rollout. When omitted, Kit uses
   * the replica schema fingerprint for backward compatibility.
   */
  wireProtocol?: OfflineWireProtocolFingerprint;
  /** Optional durable Outbox backpressure policy. */
  outboxLimits?: OfflineOutboxLimits;
  /**
   * Optional product callback invoked when local storage initialization fails.
   *
   * Providing this callback opts the application into online-only startup degradation:
   * after the callback settles successfully, the app initializer completes with
   * {@link OfflineCoordinatorService.storageState} `unavailable` and session/sync are not started.
   * When omitted, initialization throws {@link OfflineStorageUnavailableError} as before.
   * If the callback throws or rejects, initialization still fails.
   *
   * Kit never deletes Outbox or replica data in response to storage failure; any reset is product-owned.
   */
  onStorageUnavailable?: (error: OfflineStorageUnavailableError) => void | Promise<void>;
}

/** Exact versioned wire contract exchanged by pull transport. */
export interface OfflineWireProtocolFingerprint {
  /** Monotonic product wire protocol version. */
  readonly version: number;
  /** Deterministic fingerprint of the pull/push wire contract. */
  readonly hash: string;
}

/** DI token for product-independent offline persistence settings. */
export const OFFLINE_KIT_OPTIONS = new InjectionToken<OfflineKitOptions>('OFFLINE_KIT_OPTIONS');
