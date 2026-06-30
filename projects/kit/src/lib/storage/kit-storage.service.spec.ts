import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { KitStorageService } from './kit-storage.service';

// ---------------------------------------------------------------------------
// Fake storage engine (in-memory Map)
// ---------------------------------------------------------------------------
class FakeStorageEngine {
  private readonly store = new Map<string, unknown>();
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async get(key: string): Promise<unknown | null> {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

// Fake @ionic/storage-angular Storage class — create() resolves to FakeStorageEngine.
// We do NOT vi.mock the module; instead we provide this value directly as the DI token
// to avoid ESM/transform issues with the real package.
class FakeStorage {
  create() {
    return Promise.resolve(new FakeStorageEngine());
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('KitStorageService', () => {
  let service: KitStorageService;

  // We need the real Storage class as the DI token.  Import it lazily to
  // avoid hard-wiring an ESM import at module-top level where Vitest might
  // not have transformed it yet.  Using vi.mock avoids the issue entirely.
  beforeEach(async () => {
    // Dynamically import so the vi.mock below (hoisted) takes effect first.
    const { Storage } = await import('@ionic/storage-angular');

    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KitStorageService, { provide: Storage, useValue: new FakeStorage() }],
    });
    service = TestBed.inject(KitStorageService);
  });

  it('set → get round-trip for string', async () => {
    await service.set<string>('key', 'hello');
    const result = await service.get<string>('key');
    expect(result).toBe('hello');
  });

  it('set → get round-trip for object', async () => {
    const obj = { a: 1, b: true };
    await service.set('obj', obj);
    const result = await service.get<typeof obj>('obj');
    expect(result).toEqual(obj);
  });

  it('get returns null for a missing key', async () => {
    const result = await service.get<string>('does-not-exist');
    expect(result).toBeNull();
  });

  it('remove deletes the key so get returns null', async () => {
    await service.set('x', 42);
    await service.remove('x');
    const result = await service.get<number>('x');
    expect(result).toBeNull();
  });

  it('clear removes all keys', async () => {
    await service.set('a', 1);
    await service.set('b', 2);
    await service.clear();
    expect(await service.get('a')).toBeNull();
    expect(await service.get('b')).toBeNull();
    expect(await service.keys()).toEqual([]);
  });

  it('keys returns every stored key', async () => {
    await service.set('p', 1);
    await service.set('q', 2);
    const result = await service.keys();
    expect(result).toContain('p');
    expect(result).toContain('q');
    expect(result).toHaveLength(2);
  });

  it('set called without separate init is not lost (readiness guarantee)', async () => {
    // Create a fresh service in a fresh TestBed for this isolation test.
    // The key contract: the service never requires the caller to separately
    // "await storage.create()" before using it — #ready handles that internally.
    const { Storage } = await import('@ionic/storage-angular');
    let resolveCreate!: (engine: FakeStorageEngine) => void;
    const engine = new FakeStorageEngine();
    const delayedStorage = {
      // create() returns a promise that we control manually
      create: () => new Promise<FakeStorageEngine>((r) => (resolveCreate = r)),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KitStorageService, { provide: Storage, useValue: delayedStorage }],
    });
    const svc = TestBed.inject(KitStorageService);

    // Issue a set before storage is ready
    const setPromise = svc.set('early', 'value');
    // Now resolve the storage creation
    resolveCreate(engine);
    await setPromise;

    // Verify the set was not lost
    const result = await svc.get<string>('early');
    expect(result).toBe('value');
  });
});
