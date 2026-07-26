import { InjectionToken } from '@angular/core';
import type { OfflineReplicaSchemaBundle } from './offline-replica-schema';

/** Backpressure limits for durable commands. Pending commands are never evicted automatically. */
export interface OfflineOutboxLimits {
  /** Maximum number of commands retained for one user. Defaults to 1,000. */
  maxCommandsPerUser?: number;
  /** Maximum serialized size retained for one user. Defaults to 10 MiB. */
  maxBytesPerUser?: number;
}

/** Product-independent native offline persistence settings. */
export interface OfflineKitOptions {
  /** Encrypted SQLite database name used on iOS and Android. */
  databaseName: string;
  /** Creates the native database encryption key on first install. Required on iOS and Android. */
  createEncryptionKey?: () => Promise<string>;
  /** Versioned product replica schema applied to native SQLite during initialization. */
  replicaSchema: OfflineReplicaSchemaBundle;
  /** Optional durable Outbox backpressure policy. */
  outboxLimits?: OfflineOutboxLimits;
}

/** DI token for product-independent offline persistence settings. */
export const OFFLINE_KIT_OPTIONS = new InjectionToken<OfflineKitOptions>('OFFLINE_KIT_OPTIONS');
