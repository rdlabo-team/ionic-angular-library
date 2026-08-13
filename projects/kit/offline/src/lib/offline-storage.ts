/**
 * Closed set of reasons local offline storage failed to become ready.
 *
 * Product policy should branch on this discriminant rather than English message text.
 */
export type OfflineStorageUnavailableReason =
  | 'encryption_key_unavailable'
  | 'core_schema_incompatible'
  | 'replica_schema_mismatch'
  | 'migration_missing'
  | 'storage_unavailable';

/**
 * Local offline storage could not be opened or migrated without risking data loss.
 *
 * Prefer `instanceof` / {@link OfflineStorageUnavailableError.reason} over message text.
 * The original failure is preserved on {@link Error.cause}. Kit never deletes Outbox or
 * replica rows in response to this error; recovery is product-owned and explicit.
 */
export class OfflineStorageUnavailableError extends Error {
  /** Stable machine-readable discriminator for storage initialization failures. */
  static readonly code = 'OFFLINE_STORAGE_UNAVAILABLE' as const;

  readonly code = OfflineStorageUnavailableError.code;

  constructor(
    readonly reason: OfflineStorageUnavailableReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OfflineStorageUnavailableError';
  }
}

/**
 * Coordinator view of encrypted local storage after app initialization.
 *
 * `unavailable` is reached only when the product opted into online-only startup via
 * `onStorageUnavailable` (or when inspecting state after a thrown failure).
 */
export type OfflineStorageState =
  | { readonly status: 'initializing' }
  | { readonly status: 'ready' }
  | { readonly status: 'unavailable'; readonly error: OfflineStorageUnavailableError };

/** Narrows an unknown failure to {@link OfflineStorageUnavailableError}. */
export function isOfflineStorageUnavailableError(error: unknown): error is OfflineStorageUnavailableError {
  return error instanceof OfflineStorageUnavailableError;
}
