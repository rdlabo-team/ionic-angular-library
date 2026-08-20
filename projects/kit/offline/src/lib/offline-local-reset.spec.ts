import { describe, expect, it, vi } from 'vitest';
import {
  migrateOfflineDatabaseEncryption,
  recoverOfflineLocalReset,
  requestOfflineLocalReset,
  type OfflineLocalResetMarkerStore,
  type OfflineLocalResetSqliteConnection,
} from './offline-local-reset';

describe('offline local reset', () => {
  it('persists the marker before reloading', async () => {
    const events: string[] = [];
    const markerStore = store({
      set: vi.fn(async () => {
        events.push('marker');
      }),
    });

    await requestOfflineLocalReset({
      markerStore,
      markerKey: 'product:offline-reset',
      reloadTarget: { reload: () => events.push('reload') },
    });

    expect(events).toEqual(['marker', 'reload']);
    expect(markerStore.set).toHaveBeenCalledWith({ key: 'product:offline-reset', value: 'requested' });
  });

  it('deletes the Kit database and product data before removing the marker', async () => {
    const events: string[] = [];
    const markerStore = store({
      get: vi.fn(async () => ({ value: 'requested' })),
      remove: vi.fn(async () => {
        events.push('remove-marker');
      }),
    });
    const sqlite = connection(events);

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline', 'product-media'],
        nativePlatform: true,
        additionalCleanup: async () => {
          events.push('product-cleanup');
        },
      }),
    ).resolves.toBe(true);

    expect(events).toEqual([
      'consistency',
      'is-database',
      'create',
      'delete',
      'close',
      'is-database',
      'create',
      'delete',
      'close',
      'product-cleanup',
      'remove-marker',
    ]);
    expect(sqlite.createConnection).toHaveBeenNthCalledWith(1, 'product-offline', true, 'secret', 1, false);
    expect(sqlite.createConnection).toHaveBeenNthCalledWith(2, 'product-media', true, 'secret', 1, false);
  });

  it('uses plaintext connections when databaseEncryption is disabled', async () => {
    const events: string[] = [];
    const markerStore = store({
      get: vi.fn(async () => ({ value: 'requested' })),
      remove: vi.fn(async () => {
        events.push('remove-marker');
      }),
    });
    const sqlite = connection(events);

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        databaseEncryption: false,
        nativePlatform: true,
      }),
    ).resolves.toBe(true);

    expect(sqlite.createConnection).toHaveBeenCalledWith('product-offline', false, 'no-encryption', 1, false);
  });

  it('does nothing outside native or without a requested marker', async () => {
    const markerStore = store();
    const sqlite = connection([]);

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        nativePlatform: false,
      }),
    ).resolves.toBe(false);
    expect(markerStore.get).not.toHaveBeenCalled();

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        nativePlatform: true,
      }),
    ).resolves.toBe(false);
    expect(sqlite.checkConnectionsConsistency).not.toHaveBeenCalled();
  });

  it('retains the marker when database deletion fails and still closes the connection', async () => {
    const markerStore = store({ get: vi.fn(async () => ({ value: 'requested' })) });
    const sqlite = connection([]);
    const failure = new Error('delete failed');
    vi.mocked(await sqlite.createConnection('unused', true, 'secret', 1, false)).delete.mockRejectedValueOnce(failure);
    vi.mocked(sqlite.createConnection).mockClear();

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        nativePlatform: true,
      }),
    ).rejects.toBe(failure);

    expect(sqlite.closeConnection).toHaveBeenCalledWith('product-offline', false);
    expect(markerStore.remove).not.toHaveBeenCalled();
  });

  it('retains the marker and reports close failure after successful deletion', async () => {
    const markerStore = store({ get: vi.fn(async () => ({ value: 'requested' })) });
    const sqlite = connection([]);
    const failure = new Error('close failed');
    vi.mocked(sqlite.closeConnection).mockRejectedValueOnce(failure);

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        nativePlatform: true,
      }),
    ).rejects.toBe(failure);

    expect(markerStore.remove).not.toHaveBeenCalled();
  });

  it('preserves both delete and close failures for diagnosis', async () => {
    const markerStore = store({ get: vi.fn(async () => ({ value: 'requested' })) });
    const sqlite = connection([]);
    const deleteFailure = new Error('delete failed');
    const closeFailure = new Error('close failed');
    vi.mocked(await sqlite.createConnection('unused', true, 'secret', 1, false)).delete.mockRejectedValueOnce(deleteFailure);
    vi.mocked(sqlite.createConnection).mockClear();
    vi.mocked(sqlite.closeConnection).mockRejectedValueOnce(closeFailure);

    const reset = recoverOfflineLocalReset({
      markerStore,
      markerKey: 'product:offline-reset',
      sqliteConnection: sqlite,
      kitCompatibleDatabaseNames: ['product-offline'],
      nativePlatform: true,
    });

    await expect(reset).rejects.toEqual(expect.objectContaining({ errors: expect.arrayContaining([deleteFailure, closeFailure]) }));
    expect(markerStore.remove).not.toHaveBeenCalled();
  });

  it('retains the marker when product cleanup fails', async () => {
    const markerStore = store({ get: vi.fn(async () => ({ value: 'requested' })) });
    const sqlite = connection([]);
    const failure = new Error('media cleanup failed');

    await expect(
      recoverOfflineLocalReset({
        markerStore,
        markerKey: 'product:offline-reset',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        nativePlatform: true,
        additionalCleanup: async () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);

    expect(markerStore.remove).not.toHaveBeenCalled();
  });

  describe('migrateOfflineDatabaseEncryption', () => {
    it('deletes databases with plaintext connections when the source mode is plaintext', async () => {
      const markerStore = store({
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(async () => undefined),
      });
      const sqlite = connection([]);

      await expect(
        migrateOfflineDatabaseEncryption({
          markerStore,
          markerKey: 'product:encryption-migration',
          migrationVersion: 'plaintext-v1',
          sqliteConnection: sqlite,
          kitCompatibleDatabaseNames: ['product-offline', 'product-media'],
          sourceDatabaseEncryption: false,
          nativePlatform: true,
        }),
      ).resolves.toBe(true);

      expect(sqlite.createConnection).toHaveBeenNthCalledWith(1, 'product-offline', false, 'no-encryption', 1, false);
      expect(sqlite.createConnection).toHaveBeenNthCalledWith(2, 'product-media', false, 'no-encryption', 1, false);
      expect(markerStore.set).toHaveBeenCalledWith({ key: 'product:encryption-migration', value: 'plaintext-v1' });
    });

    it('detects legacy encrypted databases before deleting them', async () => {
      const markerStore = store({
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(async () => undefined),
      });
      const sqlite = {
        ...connection([]),
        isDatabaseEncrypted: vi.fn(async () => ({ result: true })),
      };

      await migrateOfflineDatabaseEncryption({
        markerStore,
        markerKey: 'product:encryption-migration',
        migrationVersion: 'plaintext-v1',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        sourceDatabaseEncryption: 'detect',
        nativePlatform: true,
      });

      expect(sqlite.isDatabaseEncrypted).toHaveBeenCalledWith('product-offline');
      expect(sqlite.createConnection).toHaveBeenCalledWith('product-offline', true, 'secret', 1, false);
    });

    it('writes the completion marker only after all deletions, cleanup, and secret clearing', async () => {
      const events: string[] = [];
      const markerStore = store({
        get: vi.fn(async () => ({ value: null })),
        set: vi.fn(async () => {
          events.push('marker');
        }),
      });
      const sqlite = {
        ...connection(events),
        clearEncryptionSecret: vi.fn(async () => {
          events.push('clear-secret');
        }),
      };

      await migrateOfflineDatabaseEncryption({
        markerStore,
        markerKey: 'product:encryption-migration',
        migrationVersion: 'plaintext-v1',
        sqliteConnection: sqlite,
        kitCompatibleDatabaseNames: ['product-offline'],
        sourceDatabaseEncryption: false,
        clearEncryptionSecret: true,
        nativePlatform: true,
        additionalCleanup: async () => {
          events.push('product-cleanup');
        },
      });

      expect(events).toEqual(['consistency', 'is-database', 'create', 'delete', 'close', 'product-cleanup', 'clear-secret', 'marker']);
    });

    it('skips migration when the completion marker matches the target version', async () => {
      const markerStore = store({
        get: vi.fn(async () => ({ value: 'plaintext-v1' })),
      });
      const sqlite = connection([]);

      await expect(
        migrateOfflineDatabaseEncryption({
          markerStore,
          markerKey: 'product:encryption-migration',
          migrationVersion: 'plaintext-v1',
          sqliteConnection: sqlite,
          kitCompatibleDatabaseNames: ['product-offline'],
          sourceDatabaseEncryption: false,
          nativePlatform: true,
        }),
      ).resolves.toBe(false);

      expect(sqlite.checkConnectionsConsistency).not.toHaveBeenCalled();
      expect(markerStore.set).not.toHaveBeenCalled();
    });

    it('retains incomplete state when deletion fails before writing the completion marker', async () => {
      const markerStore = store({
        get: vi.fn(async () => ({ value: null })),
      });
      const sqlite = connection([]);
      const failure = new Error('delete failed');
      vi.mocked(await sqlite.createConnection('unused', false, 'no-encryption', 1, false)).delete.mockRejectedValueOnce(failure);
      vi.mocked(sqlite.createConnection).mockClear();

      await expect(
        migrateOfflineDatabaseEncryption({
          markerStore,
          markerKey: 'product:encryption-migration',
          migrationVersion: 'plaintext-v1',
          sqliteConnection: sqlite,
          kitCompatibleDatabaseNames: ['product-offline'],
          sourceDatabaseEncryption: false,
          nativePlatform: true,
        }),
      ).rejects.toBe(failure);

      expect(markerStore.set).not.toHaveBeenCalled();
    });
  });

  function store(overrides: Partial<OfflineLocalResetMarkerStore> = {}): OfflineLocalResetMarkerStore {
    return {
      get: vi.fn(async () => ({ value: null })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function connection(events: string[]): OfflineLocalResetSqliteConnection {
    const database = {
      delete: vi.fn(async () => {
        events.push('delete');
      }),
    };
    return {
      checkConnectionsConsistency: vi.fn(async () => {
        events.push('consistency');
        return { result: true };
      }),
      isDatabase: vi.fn(async () => {
        events.push('is-database');
        return { result: true };
      }),
      createConnection: vi.fn(async () => {
        events.push('create');
        return database;
      }),
      closeConnection: vi.fn(async () => {
        events.push('close');
      }),
    };
  }
});
