import { inject, Injectable } from '@angular/core';
import { Storage } from '@ionic/storage-angular';

/**
 * Thin, typed wrapper around `@ionic/storage-angular`.
 *
 * Starts `create()` exactly once and stores the resulting ready Promise. Every operation awaits
 * that Promise before touching the underlying store, so calls made before initialization completes
 * are queued rather than dropped.
 *
 * @remarks
 * A naive wrapper that reads the store synchronously would silently no-op (or throw) when invoked
 * before `create()` resolves, losing early writes. Awaiting the one-time ready Promise on every
 * operation removes that race without forcing callers to coordinate initialization themselves.
 *
 * @example
 * ```ts
 * constructor(private readonly storage: KitStorageService) {}
 *
 * async ngOnInit(): Promise<void> {
 *   await this.storage.set('token', 'abc123');
 *   const token = await this.storage.get<string>('token');
 * }
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitStorageService {
  /** One-time `create()` ready Promise; awaited before every operation so early calls are not lost. */
  readonly #ready: Promise<Storage> = inject(Storage).create();

  /**
   * Persist a value under the given key.
   *
   * @typeParam T - type of the value being stored
   * @param key - key to store the value under
   * @param value - value to persist; overwrites any existing value for the key
   * @returns a Promise that resolves once the value has been written
   * @example
   * ```ts
   * await storage.set('user', { id: 1, name: 'Ada' });
   * ```
   */
  async set<T>(key: string, value: T): Promise<void> {
    await (await this.#ready).set(key, value);
  }

  /**
   * Read the value stored under the given key.
   *
   * @typeParam T - expected type of the stored value
   * @param key - key to read
   * @returns the stored value, or `null` when the key is absent
   * @example
   * ```ts
   * const user = await storage.get<{ id: number }>('user');
   * ```
   */
  async get<T>(key: string): Promise<T | null> {
    return (await (await this.#ready).get(key)) ?? null;
  }

  /**
   * Remove the value stored under the given key.
   *
   * @param key - key to remove; a no-op when the key is absent
   * @returns a Promise that resolves once the key has been removed
   */
  async remove(key: string): Promise<void> {
    await (await this.#ready).remove(key);
  }

  /**
   * Remove every key/value pair from the store.
   *
   * @returns a Promise that resolves once the store has been emptied
   */
  async clear(): Promise<void> {
    await (await this.#ready).clear();
  }

  /**
   * List every key currently present in the store.
   *
   * @returns an array of all stored keys
   */
  async keys(): Promise<string[]> {
    return (await this.#ready).keys();
  }
}
