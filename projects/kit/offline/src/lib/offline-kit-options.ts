import { InjectionToken } from '@angular/core';

/** Product-independent native offline persistence settings. */
export interface OfflineKitOptions {
  /** Encrypted SQLite database name used on iOS and Android. */
  databaseName: string;
  /** Resolves the native database key from secure device storage. Required on iOS and Android. */
  encryptionKey?: () => Promise<string>;
}

/** DI token for product-independent offline persistence settings. */
export const OFFLINE_KIT_OPTIONS = new InjectionToken<OfflineKitOptions>('OFFLINE_KIT_OPTIONS');
