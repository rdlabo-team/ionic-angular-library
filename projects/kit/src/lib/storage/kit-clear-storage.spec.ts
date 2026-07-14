import { kitClearStoragePreservingKeys, type KitClearableStore } from './kit-clear-storage';

const fakeStore = (): KitClearableStore & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve((map.get(key) ?? null) as T | null),
    set: <T>(key: string, value: T) => {
      map.set(key, value);
      return Promise.resolve();
    },
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
  };
};

describe('kitClearStoragePreservingKeys', () => {
  it('clears other keys but restores the listed ones', async () => {
    const store = fakeStore();
    await store.set('token', 'secret');
    await store.set('email', 'kept@example.com');
    await store.set('theme', 'dark');
    await kitClearStoragePreservingKeys(store, ['email', 'theme']);
    expect(store.map.has('token')).toBe(false);
    expect(store.map.get('email')).toBe('kept@example.com');
    expect(store.map.get('theme')).toBe('dark');
  });

  it('skips keys that were absent before clear', async () => {
    const store = fakeStore();
    await store.set('token', 'secret');
    await kitClearStoragePreservingKeys(store, ['missing', 'also-missing']);
    expect(store.map.size).toBe(0);
  });

  it('with an empty keys list, behaves like a full clear', async () => {
    const store = fakeStore();
    await store.set('token', 'secret');
    await kitClearStoragePreservingKeys(store, []);
    expect(store.map.size).toBe(0);
  });
});
