/**
 * Internal repository capability used to detect commits made through another
 * native SQLite connection during a local read/derive/write operation.
 *
 * This symbol is intentionally not re-exported from the package entry point.
 */
export const OFFLINE_REPOSITORY_ATOMIC_MUTATION: unique symbol = Symbol('OFFLINE_REPOSITORY_ATOMIC_MUTATION');
