import {
  canonicalOfflineRemoteIdentity,
  normalizeOfflineNaturalKey,
  offlineNaturalKeyFromValues,
  type OfflineGeneratedRemoteId,
  type OfflineNaturalKey,
  type OfflineReplicaEntitySchema,
  type OfflineReplicaRemoteIdentity,
} from './offline-replica-schema';

/** Product-agnostic authenticated principal identifier. */
export type OfflinePrincipalId = string | number;

/** Type-tagged SQLite/web key; numeric 7 and text "7" never share a boundary. */
export function canonicalOfflinePrincipalId(value: OfflinePrincipalId): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || !Number.isFinite(value)) {
      throw new Error('Offline principal id number must be a finite safe integer.');
    }
    return `n:${value}`;
  }
  if (value.length === 0) throw new Error('Offline principal id string must not be empty.');
  return `s:${JSON.stringify(value)}`;
}

/** Decodes a principal previously persisted by {@link canonicalOfflinePrincipalId}. */
export function parseOfflinePrincipalId(value: string): OfflinePrincipalId {
  if (value.startsWith('n:')) {
    const numberValue = Number(value.slice(2));
    if (!Number.isSafeInteger(numberValue)) throw new Error('Stored offline principal id is invalid.');
    return numberValue;
  }
  if (value.startsWith('s:')) {
    const stringValue: unknown = JSON.parse(value.slice(2));
    if (typeof stringValue !== 'string' || stringValue.length === 0) throw new Error('Stored offline principal id is invalid.');
    return stringValue;
  }
  throw new Error('Stored offline principal id has an unknown codec.');
}

/** Durable address of a generated or natural-key replica row. */
export type OfflineReplicaIdentity =
  | { readonly kind: 'generated'; readonly localId: string; readonly remoteId: OfflineGeneratedRemoteId | null }
  | { readonly kind: 'natural'; readonly naturalKey: OfflineNaturalKey }
  | { readonly kind: 'local'; readonly localId: string };

/** Outbox address. Generated ids are resolved to the latest server id immediately before transport. */
export type OfflineCommandIdentity =
  | { readonly kind: 'generated'; readonly localId: string }
  | { readonly kind: 'natural'; readonly naturalKey: OfflineNaturalKey };

/** Stable lookup address for every replica row, including local-only projections. */
export type OfflineReplicaAddress = OfflineCommandIdentity | { readonly kind: 'local'; readonly localId: string };

/** Stable storage key for one outbox or replica row identity. */
export function canonicalOfflineCommandIdentity(identity: OfflineCommandIdentity): string {
  if (identity.kind === 'generated') {
    assertOfflineLocalId(identity.localId);
    return `generated:${identity.localId}`;
  }
  return `natural:${canonicalOfflineNaturalKeyIdentity(identity.naturalKey)}`;
}

/** Stable storage key for one materialized replica row identity. */
export function canonicalOfflineReplicaIdentity(identity: OfflineReplicaIdentity): string {
  if (identity.kind === 'generated') {
    assertOfflineLocalId(identity.localId);
    return `generated:${identity.localId}`;
  }
  if (identity.kind === 'local') {
    assertOfflineLocalId(identity.localId);
    return `local:${identity.localId}`;
  }
  return `natural:${canonicalOfflineNaturalKeyIdentity(identity.naturalKey)}`;
}

/** JSON persisted in SQLite/web outbox rows. */
export function serializeOfflineCommandIdentity(identity: OfflineCommandIdentity): string {
  canonicalOfflineCommandIdentity(identity);
  return JSON.stringify(identity);
}

/** Parses durable outbox identity JSON. */
export function parseOfflineCommandIdentity(value: unknown): OfflineCommandIdentity {
  if (!isPlainObject(value)) throw new Error('Offline command identity must be a plain object.');
  if (value['kind'] === 'generated') {
    assertOfflineLocalId(value['localId']);
    return { kind: 'generated', localId: value['localId'] };
  }
  if (value['kind'] === 'natural') {
    if (!isPlainObject(value['naturalKey'])) throw new Error('Offline natural command identity requires naturalKey.');
    return { kind: 'natural', naturalKey: value['naturalKey'] as OfflineNaturalKey };
  }
  throw new Error('Offline command identity must be generated or natural.');
}

/** Builds a generated replica identity. */
export function offlineGeneratedReplicaIdentity(localId: string, remoteId: OfflineGeneratedRemoteId | null): OfflineReplicaIdentity {
  assertOfflineLocalId(localId);
  return { kind: 'generated', localId, remoteId };
}

/** Validates a durable local row id before it can enter either storage backend. */
export function assertOfflineLocalId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value !== value.normalize('NFC') ||
    new TextEncoder().encode(value).byteLength > 255
  ) {
    throw new Error('Offline localId must be a non-empty normalized string of at most 255 UTF-8 bytes without NUL.');
  }
}

/** Builds a natural replica identity from current domain values. */
export function offlineNaturalReplicaIdentity(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  values: unknown,
): OfflineReplicaIdentity {
  return { kind: 'natural', naturalKey: offlineNaturalKeyFromValues(schema, values)! };
}

/** Converts a materialized replica identity into an outbox address. */
export function commandIdentityFromReplicaIdentity(identity: OfflineReplicaIdentity): OfflineCommandIdentity {
  if (identity.kind === 'generated') return { kind: 'generated', localId: identity.localId };
  if (identity.kind === 'local') {
    throw new Error('Local-only replica rows cannot be added to the Outbox.');
  }
  return { kind: 'natural', naturalKey: identity.naturalKey };
}

/** Converts a materialized row identity into its immutable repository address. */
export function replicaAddressFromIdentity(identity: OfflineReplicaIdentity): OfflineReplicaAddress {
  if (identity.kind === 'natural') return { kind: 'natural', naturalKey: identity.naturalKey };
  return { kind: identity.kind, localId: identity.localId };
}

/** Whether a command identity addresses the given replica row. */
export function commandIdentityMatchesReplicaRow(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  row: { readonly identity: OfflineReplicaIdentity },
  commandIdentity: OfflineCommandIdentity,
): boolean {
  if (commandIdentity.kind === 'generated') {
    return row.identity.kind === 'generated' && row.identity.localId === commandIdentity.localId;
  }
  if (row.identity.kind !== 'natural') return false;
  return (
    canonicalOfflineRemoteIdentity(schema, { naturalKey: row.identity.naturalKey }) ===
    canonicalOfflineRemoteIdentity(schema, { naturalKey: normalizeOfflineNaturalKey(schema, commandIdentity.naturalKey) })
  );
}

/** Remote identity used by pull reconciliation and uniqueness checks. */
export function offlineReplicaRemoteIdentity(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  identity: OfflineReplicaIdentity,
): OfflineReplicaRemoteIdentity | null {
  if (schema.identity.kind === 'generated') {
    return identity.kind === 'generated' && identity.remoteId !== null ? { remoteId: identity.remoteId } : null;
  }
  if (schema.identity.kind === 'naturalKey') {
    return identity.kind === 'natural' ? { naturalKey: identity.naturalKey } : null;
  }
  return null;
}

function canonicalOfflineNaturalKeyIdentity(naturalKey: OfflineNaturalKey): string {
  return JSON.stringify(
    Object.keys(naturalKey)
      .sort()
      .map((key) => {
        const value = naturalKey[key]!;
        return [key, typeof value === 'number' ? 'n' : 's', value];
      }),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
