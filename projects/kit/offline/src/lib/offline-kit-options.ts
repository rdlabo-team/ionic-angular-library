import { InjectionToken } from '@angular/core';
import type { OfflineReplicaSchemaBundle } from './offline-replica-schema';

/** Product-independent native offline persistence settings. */
export interface OfflineKitOptions {
  /** Encrypted SQLite database name used on iOS and Android. */
  databaseName: string;
  /** Creates the native database encryption key on first install. Required on iOS and Android. */
  createEncryptionKey?: () => Promise<string>;
  /** Versioned product replica schema applied to native SQLite during initialization. */
  replicaSchema: OfflineReplicaSchemaBundle;
}

/** DI token for product-independent offline persistence settings. */
export const OFFLINE_KIT_OPTIONS = new InjectionToken<OfflineKitOptions>('OFFLINE_KIT_OPTIONS');
