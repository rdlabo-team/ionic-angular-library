/**
 * Clear a key/value store while restoring selected keys afterward.
 *
 * @remarks
 * Fleet apps often call `storage.clear()` on sign-out to drop session/token state. Values that
 * should survive logout (for example {@link KIT_LAST_AUTH_EMAIL_KEY}) are passed in `keys`.
 * Missing keys are skipped — only non-null values are written back.
 */

/** Minimal clearable store — structurally satisfied by {@link KitStorageService}. */
export interface KitClearableStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Wipe the store, then restore the given keys to their pre-clear values (when present).
 *
 * @param store - the app's storage (e.g. `KitStorageService`)
 * @param keys - keys whose values should survive the clear
 *
 * @example
 * ```ts
 * import { KIT_LAST_AUTH_EMAIL_KEY, KIT_THEME_STORAGE_KEY, kitClearStoragePreservingKeys } from '@rdlabo/ionic-angular-kit';
 *
 * await kitSignOut(auth, {
 *   success: () =>
 *     kitClearStoragePreservingKeys(this.storage, [KIT_LAST_AUTH_EMAIL_KEY, KIT_THEME_STORAGE_KEY]),
 * });
 * ```
 */
export const kitClearStoragePreservingKeys = async (
  store: KitClearableStore,
  keys: readonly string[],
): Promise<void> => {
  const preserved = await Promise.all(keys.map(async (key) => ({ key, value: await store.get<unknown>(key) })));
  await store.clear();
  for (const { key, value } of preserved) {
    if (value !== null) {
      await store.set(key, value);
    }
  }
};
