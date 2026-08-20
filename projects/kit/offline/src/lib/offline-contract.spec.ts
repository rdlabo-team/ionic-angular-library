import { describe, expect, it } from 'vitest';
import { requirePositiveOfflineInteger } from './offline-identity';
import { assertSupportedOfflineMode, provideOffline } from './offline-provider';
import { normalizeOfflineReplicaPullPage } from './offline-replica-puller';
import { defineOfflineReplicaSchema } from './offline-replica-schema';
import { offlineSessionManifestAllows } from './offline-session.service';

describe('shared offline boundary contracts', () => {
  it('normalizes database serverId exactly once at the pull transport boundary', () => {
    const normalized = normalizeOfflineReplicaPullPage({
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
      rebaselineRequired: true,
    });
    expect(normalized.changes).toEqual([
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
    expect(normalized.rebaselineRequired).toBe(true);
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

  it('requires an aggregate intent projector on the synchronized provider', () => {
    const compileOnly = (): void => {
      provideOffline({
        databaseName: 'intent-projector',
        createEncryptionKey: async () => 'native-key',
        replicaSchema: defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] }),
        requestPolicies: [],
        commandExecutor: class {} as never,
        replicaPuller: class {} as never,
        aggregateIntentProjector: class {
          project() {
            return { baseRow: null };
          }
        },
      });
    };
    void compileOnly;
  });

  it('keeps the aggregate intent projector off the read-cache provider', () => {
    type Options = import('./offline-provider').ProvideReadCacheOfflineOptions;
    type HasProjector = 'aggregateIntentProjector' extends keyof Options ? true : false;
    const readCacheOmitsProjector: HasProjector = false;
    expect(readCacheOmitsProjector).toBe(false);
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

  it('fails closed before enabling synchronized Outbox writes on Web', () => {
    expect(() => assertSupportedOfflineMode('web', 'synchronized')).toThrow(
      'Offline synchronized mode is supported only by native repositories.',
    );
    expect(() => assertSupportedOfflineMode('web', 'readCacheOnly')).not.toThrow();
    expect(() => assertSupportedOfflineMode('electron', 'synchronized')).toThrow(
      'Offline synchronized mode is supported only by native repositories.',
    );
    expect(() => assertSupportedOfflineMode('ios', 'synchronized')).not.toThrow();
    expect(() => assertSupportedOfflineMode('android', 'synchronized')).not.toThrow();
  });

  it('allows synchronized providers without an encryption key when databaseEncryption is disabled', () => {
    const compileOnly = (): void => {
      provideOffline({
        databaseName: 'plaintext-offline',
        databaseEncryption: false,
        replicaSchema: defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] }),
        requestPolicies: [],
        commandExecutor: class {} as never,
        replicaPuller: class {} as never,
        aggregateIntentProjector: class {
          project() {
            return { baseRow: null };
          }
        },
      });
    };
    void compileOnly;
  });

  it('allows a read cache without an encryption key when databaseEncryption is disabled', () => {
    const compileOnly = (): void => {
      provideOffline({
        mode: 'readCacheOnly',
        databaseName: 'plaintext-read-cache',
        databaseEncryption: false,
        replicaSchema: defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] }),
        requestPolicies: [],
      });
    };
    void compileOnly;
  });

  it('requires an encryption key factory for synchronized providers when encryption is enabled or omitted', () => {
    type Options = import('./offline-provider').ProvideSynchronizedOfflineOptions;
    type Encrypted = Exclude<Options, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Encrypted, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = true;
    expect(createEncryptionKeyIsRequired).toBe(true);
  });

  it('requires an encryption key factory for native read-cache persistence when encryption is enabled or omitted', () => {
    type Options = import('./offline-provider').ProvideReadCacheOfflineOptions;
    type Encrypted = Exclude<Options, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Encrypted, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = true;
    expect(createEncryptionKeyIsRequired).toBe(true);
  });

  it('treats createEncryptionKey as optional on synchronized providers only when encryption is disabled', () => {
    type Options = Extract<import('./offline-provider').ProvideSynchronizedOfflineOptions, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Options, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = false;
    expect(createEncryptionKeyIsRequired).toBe(false);
  });

  it('treats createEncryptionKey as optional on native read-cache persistence only when encryption is disabled', () => {
    type Options = Extract<import('./offline-provider').ProvideReadCacheOfflineOptions, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Options, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = false;
    expect(createEncryptionKeyIsRequired).toBe(false);
  });

  it('requires an encryption key factory on OfflineKitOptions when encryption is enabled or omitted', () => {
    type Options = import('./offline-kit-options').OfflineKitOptions;
    type Encrypted = Exclude<Options, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Encrypted, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = true;
    expect(createEncryptionKeyIsRequired).toBe(true);
  });

  it('treats createEncryptionKey as optional on OfflineKitOptions only when encryption is disabled', () => {
    type Options = Extract<import('./offline-kit-options').OfflineKitOptions, { databaseEncryption: false }>;
    type IsRequired = Record<string, never> extends Pick<Options, 'createEncryptionKey'> ? false : true;
    const createEncryptionKeyIsRequired: IsRequired = false;
    expect(createEncryptionKeyIsRequired).toBe(false);
  });
});
