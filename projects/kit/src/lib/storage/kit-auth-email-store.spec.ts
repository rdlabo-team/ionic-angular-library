import {
  KIT_LAST_AUTH_EMAIL_KEY,
  kitForgetEmail,
  kitIsValidEmail,
  kitRecallEmail,
  kitRememberEmail,
  type KitEmailStore,
} from './kit-auth-email-store';

/** In-memory store that structurally satisfies `KitEmailStore`. */
const fakeStore = (): KitEmailStore & { map: Map<string, unknown> } => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => Promise.resolve((map.get(key) ?? null) as T | null),
    set: <T>(key: string, value: T) => {
      map.set(key, value);
      return Promise.resolve();
    },
    remove: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
};

describe('kit-auth-email-store', () => {
  it('remembers then recalls a well-formed email', async () => {
    const store = fakeStore();
    await expect(kitRememberEmail(store, 'user@example.com')).resolves.toBe(true);
    expect(store.map.get(KIT_LAST_AUTH_EMAIL_KEY)).toBe('user@example.com');
    await expect(kitRecallEmail(store)).resolves.toBe('user@example.com');
  });

  it('recalls null when nothing has been remembered', async () => {
    await expect(kitRecallEmail(fakeStore())).resolves.toBeNull();
  });

  it('does NOT persist a malformed / partial address', async () => {
    const store = fakeStore();
    for (const bad of ['', 'not-an-email', 'user@', '@example.com', 'user @example.com', 'user@ex ample.com']) {
      await expect(kitRememberEmail(store, bad)).resolves.toBe(false);
    }
    expect(store.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    await expect(kitRecallEmail(store)).resolves.toBeNull();
  });

  it('keeps the previous valid value when a later save is invalid', async () => {
    const store = fakeStore();
    await kitRememberEmail(store, 'first@example.com');
    await kitRememberEmail(store, 'garbage');
    await expect(kitRecallEmail(store)).resolves.toBe('first@example.com');
  });

  it('forgets the remembered email', async () => {
    const store = fakeStore();
    await kitRememberEmail(store, 'user@example.com');
    await kitForgetEmail(store);
    expect(store.map.has(KIT_LAST_AUTH_EMAIL_KEY)).toBe(false);
    await expect(kitRecallEmail(store)).resolves.toBeNull();
  });

  it('kitIsValidEmail matches Validators.email semantics', () => {
    expect(kitIsValidEmail('a@b.co')).toBe(true);
    expect(kitIsValidEmail('a.b-c+d@sub.example.com')).toBe(true);
    // Angular's Validators.email is lenient: a single-label domain is accepted.
    expect(kitIsValidEmail('a@b')).toBe(true);
    expect(kitIsValidEmail('plainaddress')).toBe(false);
    expect(kitIsValidEmail('user@')).toBe(false);
  });
});
