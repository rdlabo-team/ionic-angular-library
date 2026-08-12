import { describe, expect, it } from 'vitest';
import { requirePositiveOfflineInteger } from './offline-identity';
import { provideOffline } from './offline-provider';
import { normalizeOfflineReplicaPullPage } from './offline-replica-puller';
import { defineOfflineReplicaSchema } from './offline-replica-schema';
import { offlineSessionManifestAllows } from './offline-session.service';

describe('shared offline boundary contracts', () => {
  it('normalizes database serverId exactly once at the pull transport boundary', () => {
    expect(
      normalizeOfflineReplicaPullPage({
        schemaVersion: 1,
        schemaHash: 'hash',
        changes: [
          {
            sourceKey: 'items',
            serverId: 42,
            serverRevision: 3,
            values: { id: 42 },
            deleted: false,
          },
          {
            sourceKey: 'favorites',
            naturalKey: { from: 7, to: 21 },
            serverRevision: 4,
            values: null,
            deleted: true,
          },
        ],
        nextCursor: '2',
        hasMore: false,
      }).changes,
    ).toEqual([
      {
        sourceKey: 'items',
        remoteId: 42,
        serverRevision: 3,
        values: { id: 42 },
        deleted: false,
      },
      {
        sourceKey: 'favorites',
        naturalKey: { from: 7, to: 21 },
        serverRevision: 4,
        values: null,
        deleted: true,
      },
    ]);
  });

  it('narrows positive database ids without accepting coercion or zero', () => {
    expect(requirePositiveOfflineInteger(7, 'User id')).toBe(7);
    expect(() => requirePositiveOfflineInteger('7', 'User id')).toThrow('User id must be a positive safe integer.');
    expect(() => requirePositiveOfflineInteger(0, 'User id')).toThrow('User id must be a positive safe integer.');
  });

  it('authorizes a manifest only for the same subject and requested scope', () => {
    const manifest = { userId: 7, scopeIds: ['10'], authSubject: 'uid-7', updatedAt: 1 };
    expect(offlineSessionManifestAllows(manifest, 'uid-7', '10')).toBe(true);
    expect(offlineSessionManifestAllows(manifest, 'uid-7', '11')).toBe(false);
    expect(offlineSessionManifestAllows(manifest, 'uid-other', '10')).toBe(false);
  });

  it('supports a read cache without product dummy transport adapters', () => {
    const compileOnly = (): void => {
      provideOffline({
        mode: 'readCacheOnly',
        databaseName: 'read-cache',
        createEncryptionKey: async () => 'native-cache-key',
        replicaSchema: defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] }),
        requestPolicies: [],
      });
    };
    void compileOnly;
  });

  it('requires an encryption key factory for synchronized providers at compile time', () => {
    type Options = import('./offline-provider').ProvideSynchronizedOfflineOptions;
    type IsRequired = Record<string, never> extends Pick<Options, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = true;
    expect(createEncryptionKeyIsRequired).toBe(true);
  });

  it('requires an encryption key factory for native read-cache persistence too', () => {
    type Options = import('./offline-provider').ProvideReadCacheOfflineOptions;
    type IsRequired = Record<string, never> extends Pick<Options, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = true;
    expect(createEncryptionKeyIsRequired).toBe(true);
  });
});
