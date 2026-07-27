/** SQLite storage affinity for a replicated entity column. */
export type OfflineReplicaSqliteAffinity = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * Logical storage kind for a replicated column, independent of SQLite affinity.
 *
 * For example, {@link booleanColumn} and {@link datetime} both use INTEGER/TEXT affinity
 * but remain distinguishable at runtime through this marker.
 */
export type OfflineReplicaStorageKind = 'text' | 'integer' | 'real' | 'booleanColumn' | 'json' | 'datetime';

/** Scope partition persisted on every replica table row. */
export type OfflineReplicaEntityScope = 'user' | 'partition';

/** Field projection policy for a source-model property. */
export type OfflineReplicaFieldPolicy = 'column' | 'remoteId' | 'ignored';

/** Canonical value types accepted in a composite server-side natural key. */
export type OfflineNaturalKeyValue = string | number;
const MAX_OFFLINE_NATURAL_KEY_TEXT_BYTES = 1024;

/** Ordered natural-key values keyed by source-model field name. */
export type OfflineNaturalKey = Readonly<Record<string, OfflineNaturalKeyValue>>;

/** Server-assigned remote identifier for a generated-identity entity. */
export type OfflineGeneratedRemoteId = number | string;

/** Remote row identity. Exactly one variant is valid for a replicated entity. */
export type OfflineReplicaRemoteIdentity =
  | { readonly remoteId: OfflineGeneratedRemoteId; readonly naturalKey?: never }
  | { readonly remoteId?: never; readonly naturalKey: OfflineNaturalKey };

/** Runtime identity policy materialized into an entity schema. */
export type OfflineReplicaIdentityDescriptor =
  | { readonly kind: 'localOnly'; readonly sourceKeys: readonly [] }
  | { readonly kind: 'generated'; readonly sourceKeys: readonly [string]; readonly affinity: OfflineReplicaSqliteAffinity }
  | { readonly kind: 'naturalKey'; readonly sourceKeys: readonly string[] };

/** Runtime descriptor for one mapped source property. */
export interface OfflineReplicaFieldDescriptor {
  /** Source-model property name from the select shape. */
  readonly sourceKey: string;
  /** How the property is projected into SQLite. */
  readonly policy: OfflineReplicaFieldPolicy;
  /** Physical SQLite column name, or null when {@link policy} is `ignored`. */
  readonly sqliteColumnName: string | null;
  /** SQLite affinity for column policies, otherwise null. */
  readonly affinity: OfflineReplicaSqliteAffinity | null;
  /** Logical storage kind for column policies, otherwise null. */
  readonly storageKind: OfflineReplicaStorageKind | null;
  /** Whether the SQLite column accepts NULL. */
  readonly nullable: boolean;
  /** Human-readable reason when {@link policy} is `ignored`. */
  readonly ignoredReason: string | null;
}

/** Materialized replica entity schema used to create and fingerprint SQLite tables. */
export interface OfflineReplicaEntitySchema<TSelect extends Record<string, unknown>> {
  /** Validated SQLite table name. */
  readonly tableName: string;
  /** Stable source key used by sync and repository layers. */
  readonly sourceKey: string;
  /** Whether rows are partitioned by user only or user plus scope partition. */
  readonly scope: OfflineReplicaEntityScope;
  /** Remote identity policy used by repository and pull reconciliation. */
  readonly identity: OfflineReplicaIdentityDescriptor;
  /** Ordered field descriptors derived from the DSL definition. */
  readonly fields: readonly OfflineReplicaFieldDescriptor[];
  /** Deterministic DDL statements for the replica table and indexes. */
  readonly createTableSql: readonly string[];
  /** Canonical string input for schema fingerprinting; hashing is left to callers. */
  readonly schemaFingerprintInput: string;
  /** Phantom marker tying the schema to its select shape. */
  readonly __select?: TSelect;
}

declare const replicaNullableBrand: unique symbol;

/** Phantom nullability brand carried by column builders. */
interface ReplicaNullableBrand {
  readonly [replicaNullableBrand]: 'nullable' | 'required';
}

/** Column builder definition with compile-time nullability tracking. */
export interface OfflineReplicaColumnDef<
  TValue = unknown,
  TNullable extends ReplicaNullableBrand = { readonly [replicaNullableBrand]: 'required' },
> {
  readonly kind: 'column';
  readonly affinity: OfflineReplicaSqliteAffinity;
  readonly storageKind: OfflineReplicaStorageKind;
  readonly columnName?: string;
  readonly nullable?: boolean;
  readonly __types?: { readonly value: TValue; readonly nullable: TNullable[typeof replicaNullableBrand] };
}

/** Builder marking a source property as the server-assigned generated identifier. */
export interface OfflineReplicaRemoteIdDef<TAffinity extends OfflineReplicaSqliteAffinity = OfflineReplicaSqliteAffinity> {
  readonly kind: 'remoteId';
  readonly affinity: TAffinity;
  readonly __types?: TAffinity extends 'INTEGER' ? { readonly value: number } : { readonly value: string };
}

/** Builder excluding a source property from SQLite projection. */
export interface OfflineReplicaIgnoredDef {
  readonly kind: 'ignored';
  readonly reason: string;
}

/** Builder selecting non-null source columns as a composite remote identity. */
export interface OfflineReplicaNaturalKeyDef<TKey extends string = string> {
  readonly kind: 'naturalKey';
  readonly sourceKeys: readonly TKey[];
}

/** Explicit identity for a projection that is never synchronized to a remote row. */
export interface OfflineReplicaLocalOnlyDef {
  readonly kind: 'localOnly';
}

type OfflineReplicaFieldDef = OfflineReplicaColumnDef | OfflineReplicaRemoteIdDef | OfflineReplicaIgnoredDef;

type StripNullish<T> = Exclude<T, null | undefined>;

type NormalizeReplicaColumnValue<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends Date
        ? string | Date
        : T;

type StrictNullChecksEnabled = undefined extends null ? false : true;

type ReplicaColumnNullabilityForSelect<T> = StrictNullChecksEnabled extends true
  ? null extends T
    ? ReplicaNullableBrand & { readonly [replicaNullableBrand]: 'nullable' }
    : undefined extends T
      ? ReplicaNullableBrand & { readonly [replicaNullableBrand]: 'nullable' }
      : ReplicaNullableBrand & { readonly [replicaNullableBrand]: 'required' }
  : ReplicaNullableBrand;

type OfflineReplicaColumnDefForValue<T> = OfflineReplicaColumnDef<
  NormalizeReplicaColumnValue<StripNullish<T>>,
  ReplicaColumnNullabilityForSelect<T>
>;

type OfflineReplicaRemoteIdDefForValue<T> =
  StripNullish<T> extends number
    ? OfflineReplicaRemoteIdDef<'INTEGER'>
    : StripNullish<T> extends string
      ? OfflineReplicaRemoteIdDef<'TEXT'>
      : never;

type OfflineReplicaFieldDefForKey<TSelect extends Record<string, unknown>, K extends keyof TSelect> =
  | OfflineReplicaRemoteIdDefForValue<TSelect[K]>
  | OfflineReplicaIgnoredDef
  | OfflineReplicaColumnDefForValue<TSelect[K]>;

type ExactSelectKeys<TSelect extends Record<string, unknown>, TFields> =
  Exclude<keyof TFields, keyof TSelect> extends never ? (Exclude<keyof TSelect, keyof TFields> extends never ? TFields : never) : never;

/** Configuration accepted by {@link defineReplicaEntity}. */
export interface OfflineReplicaEntityDefinition<
  TSelect extends Record<string, unknown>,
  TFields extends { readonly [K in keyof TSelect]: OfflineReplicaFieldDefForKey<TSelect, K> },
> {
  readonly table: string;
  readonly sourceKey: string;
  readonly scope: OfflineReplicaEntityScope;
  readonly identity?: OfflineReplicaNaturalKeyDef<Extract<keyof TSelect, string>> | OfflineReplicaLocalOnlyDef;
  readonly fields: ExactSelectKeys<TSelect, TFields> & TFields;
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_COLUMN_NAMES = new Set([
  'local_id',
  '_offline_user_id',
  '_offline_scope_id',
  'server_id',
  '_offline_confirmed_json',
  '_offline_server_revision_json',
  '_offline_sync_state',
  '_offline_fetched_at',
]);

/**
 * Begins a type-safe replica entity schema definition for the given select shape.
 *
 * Every key in `TSelect` must appear exactly once in `fields`, and column nullability
 * must match the select property nullability. An entity may map at most one field with
 * {@link generatedId}; omit it for local-only projections that have no remote row identity.
 */
export function defineReplicaEntity<TSelect extends Record<string, unknown>>() {
  return function defineReplicaEntityConfig<
    const TFields extends { readonly [K in keyof TSelect]: OfflineReplicaFieldDefForKey<TSelect, K> },
  >(definition: OfflineReplicaEntityDefinition<TSelect, TFields>): OfflineReplicaEntitySchema<TSelect> {
    return buildOfflineReplicaEntitySchema<TSelect>({
      table: definition.table,
      sourceKey: definition.sourceKey,
      scope: definition.scope,
      identity: definition.identity,
      fields: definition.fields as Record<string, OfflineReplicaFieldDef>,
    });
  };
}

function requiredColumn<TValue>(
  affinity: OfflineReplicaSqliteAffinity,
  storageKind: OfflineReplicaStorageKind,
): OfflineReplicaColumnDef<TValue> {
  return { kind: 'column', affinity, storageKind, nullable: false };
}

/** Maps a non-null string source property to a TEXT column. */
export function text(): OfflineReplicaColumnDef<string> {
  return requiredColumn<string>('TEXT', 'text');
}

/** Maps a non-null integer source property to an INTEGER column. */
export function integer(): OfflineReplicaColumnDef<number> {
  return requiredColumn<number>('INTEGER', 'integer');
}

/** Maps a non-null floating-point source property to a REAL column. */
export function real(): OfflineReplicaColumnDef<number> {
  return requiredColumn<number>('REAL', 'real');
}

/** Maps a non-null boolean source property to an INTEGER column. */
export function booleanColumn(): OfflineReplicaColumnDef<boolean> {
  return requiredColumn<boolean>('INTEGER', 'booleanColumn');
}

/** Maps a non-null JSON-serializable source property to a TEXT column. */
export function json<T>(): OfflineReplicaColumnDef<T> {
  return requiredColumn<T>('TEXT', 'json');
}

/** Maps a non-null datetime source property to a canonical ISO-8601 TEXT column. */
export function datetime(): OfflineReplicaColumnDef<string | Date> {
  return requiredColumn<string | Date>('TEXT', 'datetime');
}

/** Marks a column builder as nullable for nullable select properties. */
export function nullable<TValue>(
  column: OfflineReplicaColumnDef<TValue, { readonly [replicaNullableBrand]: 'required' }>,
): OfflineReplicaColumnDef<TValue, { readonly [replicaNullableBrand]: 'nullable' }> {
  return {
    kind: 'column',
    affinity: column.affinity,
    storageKind: column.storageKind,
    nullable: true,
    ...(column.columnName !== undefined ? { columnName: column.columnName } : {}),
  };
}

/** Maps a source property to the nullable generated remote-id column. */
export function generatedId(kind: 'integer'): OfflineReplicaRemoteIdDef<'INTEGER'>;
export function generatedId(kind: 'text'): OfflineReplicaRemoteIdDef<'TEXT'>;
export function generatedId(kind: 'integer' | 'text'): OfflineReplicaRemoteIdDef {
  return { kind: 'remoteId', affinity: kind === 'integer' ? 'INTEGER' : 'TEXT' };
}

/** Declares an ordered remote natural key used directly as the scoped SQLite primary key. */
export function naturalKey<const TKey extends string>(sourceKeys: readonly TKey[]): OfflineReplicaNaturalKeyDef<TKey> {
  return { kind: 'naturalKey', sourceKeys };
}

/** Declares a projection with a local UUID address and no Outbox identity. */
export function localOnly(): OfflineReplicaLocalOnlyDef {
  return { kind: 'localOnly' };
}
/** Rejects a generated remote id on a local-only or natural-key projection before it reaches platform storage. */
export function assertOfflineReplicaGeneratedRemoteId(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  value: OfflineGeneratedRemoteId | null,
): void {
  if (schema.identity.kind !== 'generated' && value !== null) {
    throw new Error(`Offline replica source "${schema.sourceKey}" does not define a generated remote id field.`);
  }
  if (value === null) return;
  assertValidGeneratedRemoteId(schema, value);
}

/** Extracts and validates an entity's natural key in declared component order. */
export function offlineNaturalKeyFromValues(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  values: unknown,
): OfflineNaturalKey | null {
  if (schema.identity.kind !== 'naturalKey') return null;
  if (!isPlainObject(values)) {
    throw new Error(`Offline replica values for "${schema.sourceKey}" must be a plain object.`);
  }
  return Object.fromEntries(
    schema.identity.sourceKeys.map((sourceKey) => {
      const value = values[sourceKey];
      const field = schema.fields.find((candidate) => candidate.sourceKey === sourceKey)!;
      if (
        (field.storageKind === 'text' && typeof value !== 'string') ||
        (field.storageKind === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(value)))
      ) {
        throw new Error(`Offline replica naturalKey field "${sourceKey}" has an invalid value.`);
      }
      if (typeof value === 'string') assertNaturalKeyText(sourceKey, value);
      return [sourceKey, value as OfflineNaturalKeyValue];
    }),
  );
}

/** Validates a supplied natural key and returns it in schema-declared order. */
export function normalizeOfflineNaturalKey(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  naturalKey: OfflineNaturalKey,
): OfflineNaturalKey {
  if (schema.identity.kind !== 'naturalKey') {
    throw new Error(`Offline replica source "${schema.sourceKey}" does not define a naturalKey identity.`);
  }
  if (!isPlainObject(naturalKey)) {
    throw new Error(`Offline replica naturalKey for "${schema.sourceKey}" must be a plain object.`);
  }
  const actualKeys = Object.keys(naturalKey);
  if (
    actualKeys.length !== schema.identity.sourceKeys.length ||
    actualKeys.some((key) => !(schema.identity.sourceKeys as readonly string[]).includes(key))
  ) {
    throw new Error(`Offline replica naturalKey for "${schema.sourceKey}" must contain exactly its declared fields.`);
  }
  return offlineNaturalKeyFromValues(schema, naturalKey)!;
}

/** Stable, type-tagged identity key used by web uniqueness and pull collapse. */
export function canonicalOfflineRemoteIdentity(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  identity: OfflineReplicaRemoteIdentity,
): string {
  if (schema.identity.kind === 'generated') {
    if (!('remoteId' in identity) || 'naturalKey' in identity) {
      throw new Error(`Offline replica source "${schema.sourceKey}" requires generated remote id identity.`);
    }
    assertValidGeneratedRemoteId(schema, identity.remoteId);
    return typeof identity.remoteId === 'string' ? `remoteId:s:${identity.remoteId}` : `remoteId:n:${identity.remoteId}`;
  }
  if (schema.identity.kind === 'naturalKey') {
    if (!('naturalKey' in identity) || 'remoteId' in identity) {
      throw new Error(`Offline replica source "${schema.sourceKey}" requires naturalKey identity.`);
    }
    const key = normalizeOfflineNaturalKey(schema, identity.naturalKey);
    return `naturalKey:${JSON.stringify(
      schema.identity.sourceKeys.map((sourceKey) => {
        const value = key[sourceKey]!;
        return [sourceKey, typeof value === 'number' ? 'n' : 's', value];
      }),
    )}`;
  }
  throw new Error(`Offline replica source "${schema.sourceKey}" is local-only.`);
}

/** Enforces one immutable natural identity across optimistic and confirmed row values. */
export function assertOfflineReplicaNaturalKeyBaseline(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  values: unknown,
  confirmedValues: unknown | null,
): void {
  if (schema.identity.kind !== 'naturalKey' || confirmedValues === null) return;
  const current = canonicalOfflineRemoteIdentity(schema, { naturalKey: offlineNaturalKeyFromValues(schema, values)! });
  const confirmed = canonicalOfflineRemoteIdentity(schema, {
    naturalKey: offlineNaturalKeyFromValues(schema, confirmedValues)!,
  });
  if (current !== confirmed) {
    throw new Error(`Offline replica confirmedValues naturalKey must match values for "${schema.sourceKey}".`);
  }
}

function assertValidGeneratedRemoteId(schema: OfflineReplicaEntitySchema<Record<string, unknown>>, value: OfflineGeneratedRemoteId): void {
  if (schema.identity.kind !== 'generated') {
    throw new Error(`Offline replica source "${schema.sourceKey}" does not define a generated remote id field.`);
  }
  if (schema.identity.affinity === 'INTEGER') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Offline replica generated remote id must be a positive integer.');
    }
    return;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Offline replica generated remote id must be a non-empty string.');
  }
  assertNaturalKeyText('remoteId', value);
}

function assertNaturalKeyText(sourceKey: string, value: string): void {
  if (value.includes('\0')) {
    throw new Error(`Offline replica naturalKey field "${sourceKey}" must not contain NUL.`);
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`Offline replica naturalKey field "${sourceKey}" must contain well-formed Unicode.`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_OFFLINE_NATURAL_KEY_TEXT_BYTES) {
    throw new Error(`Offline replica naturalKey field "${sourceKey}" must not exceed ${MAX_OFFLINE_NATURAL_KEY_TEXT_BYTES} UTF-8 bytes.`);
  }
}

/** Excludes a source property from SQLite while retaining it in the select shape. */
export function ignored(reason: string): OfflineReplicaIgnoredDef {
  return { kind: 'ignored', reason };
}

function buildOfflineReplicaEntitySchema<TSelect extends Record<string, unknown>>(definition: {
  readonly table: string;
  readonly sourceKey: string;
  readonly scope: OfflineReplicaEntityScope;
  readonly identity?: OfflineReplicaNaturalKeyDef | OfflineReplicaLocalOnlyDef;
  readonly fields: Record<string, OfflineReplicaFieldDef>;
}): OfflineReplicaEntitySchema<TSelect> {
  validateIdentifier(definition.table, 'table');
  validateIdentifier(definition.sourceKey, 'source key');

  const sourceKeys = Object.keys(definition.fields).sort();
  const remoteIdCount = sourceKeys.filter((sourceKey) => definition.fields[sourceKey]?.kind === 'remoteId').length;
  if (remoteIdCount > 1) throw new Error('Replica entity must define at most one remoteId field.');
  const fields: OfflineReplicaFieldDescriptor[] = sourceKeys.map((sourceKey) => {
    const fieldDef = definition.fields[sourceKey as keyof TSelect] as OfflineReplicaFieldDef;
    return materializeFieldDescriptor(sourceKey, fieldDef);
  });
  const identity = materializeIdentity(definition.identity, fields);

  const createTableSql = buildCreateTableSql(definition.table, definition.scope, fields, identity);
  const schemaFingerprintInput = buildSchemaFingerprintInput(definition.table, definition.sourceKey, definition.scope, fields, identity);

  return {
    tableName: definition.table,
    sourceKey: definition.sourceKey,
    scope: definition.scope,
    identity,
    fields,
    createTableSql,
    schemaFingerprintInput,
  };
}

function materializeIdentity(
  definition: OfflineReplicaNaturalKeyDef | OfflineReplicaLocalOnlyDef | undefined,
  fields: readonly OfflineReplicaFieldDescriptor[],
): OfflineReplicaIdentityDescriptor {
  const serverField = fields.find((field) => field.policy === 'remoteId');
  if (definition && serverField) throw new Error('Replica entity cannot combine a generated id field with another identity.');
  if (serverField) return { kind: 'generated', sourceKeys: [serverField.sourceKey], affinity: serverField.affinity! };
  if (!definition) throw new Error('Replica entity without a generated id field must declare identity explicitly.');
  if (definition.kind === 'localOnly') return { kind: 'localOnly', sourceKeys: [] };
  if (definition.sourceKeys.length === 0) throw new Error('Replica naturalKey must contain at least one source field.');
  if (new Set(definition.sourceKeys).size !== definition.sourceKeys.length) {
    throw new Error('Replica naturalKey source fields must be unique.');
  }
  for (const sourceKey of definition.sourceKeys) {
    const field = fields.find((candidate) => candidate.sourceKey === sourceKey);
    if (!field) throw new Error(`Replica naturalKey field "${sourceKey}" is not defined.`);
    if (field.policy !== 'column' || field.nullable || !['text', 'integer'].includes(field.storageKind ?? '')) {
      throw new Error(`Replica naturalKey field "${sourceKey}" must be a required text or integer column.`);
    }
  }
  return { kind: 'naturalKey', sourceKeys: [...definition.sourceKeys] };
}

function materializeFieldDescriptor(sourceKey: string, fieldDef: OfflineReplicaFieldDef): OfflineReplicaFieldDescriptor {
  if (fieldDef.kind === 'ignored') {
    if (!fieldDef.reason.trim()) throw new Error(`Replica ignored field "${sourceKey}" requires a reason.`);
    return {
      sourceKey,
      policy: 'ignored',
      sqliteColumnName: null,
      affinity: null,
      storageKind: null,
      nullable: false,
      ignoredReason: fieldDef.reason,
    };
  }

  if (fieldDef.kind === 'remoteId') {
    return {
      sourceKey,
      policy: 'remoteId',
      sqliteColumnName: 'server_id',
      affinity: fieldDef.affinity,
      storageKind: null,
      nullable: true,
      ignoredReason: null,
    };
  }

  const sqliteColumnName = fieldDef.columnName ?? toSnakeCase(sourceKey);
  validateIdentifier(sqliteColumnName, 'column');
  if (RESERVED_COLUMN_NAMES.has(sqliteColumnName)) {
    throw new Error(`Replica column "${sqliteColumnName}" is reserved.`);
  }

  return {
    sourceKey,
    policy: 'column',
    sqliteColumnName,
    affinity: fieldDef.affinity,
    storageKind: fieldDef.storageKind,
    nullable: fieldDef.nullable === true,
    ignoredReason: null,
  };
}

function buildCreateTableSql(
  tableName: string,
  scope: OfflineReplicaEntityScope,
  fields: readonly OfflineReplicaFieldDescriptor[],
  identity: OfflineReplicaIdentityDescriptor,
): readonly string[] {
  const columnLines = ['_offline_user_id TEXT NOT NULL'];
  if (scope === 'partition') {
    columnLines.push('_offline_scope_id TEXT NOT NULL');
  }
  if (identity.kind === 'generated') {
    columnLines.push('local_id TEXT NOT NULL', `server_id ${identity.affinity}`);
  } else if (identity.kind === 'localOnly') {
    columnLines.push('local_id TEXT NOT NULL');
  }
  columnLines.push(
    '_offline_confirmed_json TEXT',
    '_offline_server_revision_json TEXT',
    '_offline_sync_state TEXT NOT NULL',
    "_offline_visibility TEXT NOT NULL DEFAULT 'present'",
    '_offline_fetched_at INTEGER NOT NULL',
  );

  for (const field of fields) {
    if (field.policy !== 'column') {
      continue;
    }
    const nullability = field.nullable ? '' : ' NOT NULL';
    columnLines.push(`${field.sqliteColumnName} ${field.affinity}${nullability}`);
  }

  const pkColumns = [
    '_offline_user_id',
    ...(scope === 'partition' ? ['_offline_scope_id'] : []),
    ...(identity.kind === 'naturalKey'
      ? identity.sourceKeys.map((sourceKey) => fields.find((field) => field.sourceKey === sourceKey)!.sqliteColumnName!)
      : ['local_id']),
  ];

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${columnLines.join(',\n  ')},\n  PRIMARY KEY (${pkColumns.join(', ')})\n)`,
  ];

  if (identity.kind === 'generated') {
    const indexColumns = scope === 'partition' ? '_offline_user_id, _offline_scope_id, server_id' : '_offline_user_id, server_id';
    statements.push(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_${tableName}_server_id ON ${tableName} (${indexColumns}) WHERE server_id IS NOT NULL`,
    );
  }

  return statements;
}

function buildSchemaFingerprintInput(
  tableName: string,
  sourceKey: string,
  scope: OfflineReplicaEntityScope,
  fields: readonly OfflineReplicaFieldDescriptor[],
  identity: OfflineReplicaIdentityDescriptor,
): string {
  const fieldParts = fields.map((field) => {
    if (field.policy === 'ignored') {
      return `${field.sourceKey}:ignored:${field.ignoredReason ?? ''}`;
    }
    if (field.policy === 'remoteId') {
      return `${field.sourceKey}:remoteId:server_id:${field.affinity}:nullable`;
    }
    return `${field.sourceKey}:column:${field.sqliteColumnName}:${field.affinity}:${field.storageKind}:${field.nullable ? 'nullable' : 'required'}`;
  });

  return [
    `table=${tableName}`,
    `source=${sourceKey}`,
    `scope=${scope}`,
    ...(identity.kind === 'naturalKey'
      ? [`identity=naturalKey:${identity.sourceKeys.join(',')}`, 'identityCodec=v2']
      : identity.kind === 'generated'
        ? [`identity=generated:${identity.sourceKeys[0]}:${identity.affinity}`, 'identityCodec=v2']
        : ['identity=localOnly', 'identityCodec=v2']),
    `fields=${fieldParts.join(';')}`,
  ].join('|');
}

function validateIdentifier(value: string, kind: 'table' | 'column' | 'source key'): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Replica ${kind} "${value}" must match ${IDENTIFIER_PATTERN.source}.`);
  }
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_/, '')
    .toLowerCase();
}

/**
 * Validates and encodes a source-model row into SQLite-bound column values.
 *
 * Only {@link OfflineReplicaFieldPolicy} `column` fields are emitted, keyed by
 * {@link OfflineReplicaFieldDescriptor.sqliteColumnName} in descriptor order.
 * Source properties mapped as `remoteId` or `ignored` may be present but are not encoded.
 */
export function encodeOfflineReplicaValues(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  values: unknown,
): Readonly<Record<string, string | number | null>> {
  if (!isPlainObject(values)) {
    throw new Error('Replica row values must be a plain object.');
  }

  const sourceValues = values;
  const allowedSourceKeys = new Set(schema.fields.map((field) => field.sourceKey));

  for (const sourceKey of Object.keys(sourceValues)) {
    if (!allowedSourceKeys.has(sourceKey)) {
      throw new Error(`Replica row contains unknown source key "${sourceKey}".`);
    }
  }

  const encoded: Record<string, string | number | null> = {};

  for (const field of schema.fields) {
    if (field.policy !== 'column') {
      continue;
    }

    const sqliteColumnName = field.sqliteColumnName;
    if (sqliteColumnName === null) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(sourceValues, field.sourceKey)) {
      throw new Error(`Replica row is missing required source key "${field.sourceKey}".`);
    }

    const rawValue = sourceValues[field.sourceKey];
    if (rawValue === null) {
      if (!field.nullable) {
        throw new Error(`Replica row source key "${field.sourceKey}" must not be null.`);
      }
      encoded[sqliteColumnName] = null;
      continue;
    }

    if (rawValue === undefined) {
      throw new Error(`Replica row source key "${field.sourceKey}" must not be undefined.`);
    }

    encoded[sqliteColumnName] = encodeReplicaColumnValue(field, rawValue);
  }

  return encoded;
}

/**
 * Validates and decodes SQLite column values into a source-model row.
 *
 * Only {@link OfflineReplicaFieldPolicy} `column` fields are emitted, keyed by
 * {@link OfflineReplicaFieldDescriptor.sourceKey} in descriptor order.
 * Physical columns such as `server_id`, sync metadata, and scope keys may be
 * present in `row` but are not decoded.
 */
export function decodeOfflineReplicaValues(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  row: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainObject(row)) {
    throw new Error('Replica SQLite row must be a plain object.');
  }

  const decoded: Record<string, unknown> = {};

  for (const field of schema.fields) {
    if (field.policy !== 'column') {
      continue;
    }

    const sqliteColumnName = field.sqliteColumnName;
    if (sqliteColumnName === null) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(row, sqliteColumnName)) {
      throw new Error(`Replica SQLite row is missing required column "${sqliteColumnName}".`);
    }

    const rawValue = row[sqliteColumnName];
    if (rawValue === null) {
      if (!field.nullable) {
        throw new Error(`Replica SQLite column "${sqliteColumnName}" must not be null.`);
      }
      decoded[field.sourceKey] = null;
      continue;
    }

    if (rawValue === undefined) {
      throw new Error(`Replica SQLite column "${sqliteColumnName}" must not be undefined.`);
    }

    decoded[field.sourceKey] = decodeReplicaColumnValue(field, rawValue);
  }

  return decoded;
}

/**
 * Validates a source-model row and returns the canonical domain projection persisted by every repository.
 *
 * Fields mapped as `remoteId` or `ignored` are intentionally omitted. This keeps web and native row shapes
 * identical; the server identifier remains available through the replica row's dedicated `remoteId` field.
 */
export function projectOfflineReplicaValues(
  schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
  values: unknown,
): Readonly<Record<string, unknown>> {
  return decodeOfflineReplicaValues(schema, encodeOfflineReplicaValues(schema, values));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeReplicaColumnValue(field: OfflineReplicaFieldDescriptor, value: unknown): string | number {
  switch (field.storageKind) {
    case 'text':
      return encodeReplicaTextValue(field.sourceKey, value);
    case 'integer':
      return encodeReplicaIntegerValue(field.sourceKey, value);
    case 'real':
      return encodeReplicaRealValue(field.sourceKey, value);
    case 'booleanColumn':
      return encodeReplicaBooleanValue(field.sourceKey, value);
    case 'json':
      return encodeReplicaJsonValue(field.sourceKey, value);
    case 'datetime':
      return encodeReplicaDatetimeValue(field.sourceKey, value);
    default:
      throw new Error(`Replica row source key "${field.sourceKey}" has no storage kind.`);
  }
}

function decodeReplicaColumnValue(field: OfflineReplicaFieldDescriptor, value: unknown): unknown {
  switch (field.storageKind) {
    case 'text':
      return decodeReplicaTextValue(field.sourceKey, value);
    case 'integer':
      return decodeReplicaIntegerValue(field.sourceKey, value);
    case 'real':
      return decodeReplicaRealValue(field.sourceKey, value);
    case 'booleanColumn':
      return decodeReplicaBooleanValue(field.sourceKey, value);
    case 'json':
      return decodeReplicaJsonValue(field.sourceKey, value);
    case 'datetime':
      return decodeReplicaDatetimeValue(field.sourceKey, value);
    default:
      throw new Error(`Replica row source key "${field.sourceKey}" has no storage kind.`);
  }
}

function encodeReplicaTextValue(sourceKey: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Replica row source key "${sourceKey}" must be a string.`);
  }
  return value;
}

function encodeReplicaIntegerValue(sourceKey: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`Replica row source key "${sourceKey}" must be a finite safe integer.`);
  }
  return value;
}

function encodeReplicaRealValue(sourceKey: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Replica row source key "${sourceKey}" must be a finite number.`);
  }
  return value;
}

function encodeReplicaBooleanValue(sourceKey: string, value: unknown): 0 | 1 {
  if (typeof value !== 'boolean') {
    throw new Error(`Replica row source key "${sourceKey}" must be a boolean.`);
  }
  return value ? 1 : 0;
}

function encodeReplicaJsonValue(sourceKey: string, value: unknown): string {
  assertJsonSerializable(sourceKey, value);
  return JSON.stringify(value);
}

function encodeReplicaDatetimeValue(sourceKey: string, value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`Replica row source key "${sourceKey}" must be a valid Date.`);
    }
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Replica row source key "${sourceKey}" must be a Date or string.`);
}

function decodeReplicaTextValue(sourceKey: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Replica row source key "${sourceKey}" must be a string.`);
  }
  return value;
}

function decodeReplicaIntegerValue(sourceKey: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error(`Replica row source key "${sourceKey}" must be a finite safe integer.`);
  }
  return value;
}

function decodeReplicaRealValue(sourceKey: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Replica row source key "${sourceKey}" must be a finite number.`);
  }
  return value;
}

function decodeReplicaBooleanValue(sourceKey: string, value: unknown): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`Replica row source key "${sourceKey}" must be boolean integer 0 or 1.`);
  }
  return value === 1;
}

function decodeReplicaJsonValue(sourceKey: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error(`Replica row source key "${sourceKey}" must be a JSON string.`);
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Replica row source key "${sourceKey}" must be valid JSON.`);
  }
}

function decodeReplicaDatetimeValue(sourceKey: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`Replica row source key "${sourceKey}" must be a string.`);
  }
  return value;
}

function assertJsonSerializable(sourceKey: string, value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return;
  }

  if (typeof value === 'undefined') {
    throw new Error(`Replica row source key "${sourceKey}" must be JSON-serializable without undefined.`);
  }

  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Replica row source key "${sourceKey}" must be JSON-serializable without functions.`);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonSerializable(sourceKey, item, seen);
    }
    return;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(`Replica row source key "${sourceKey}" must be JSON-serializable without cycles.`);
    }
    seen.add(value);
    for (const key of Object.keys(value)) {
      assertJsonSerializable(sourceKey, (value as Record<string, unknown>)[key], seen);
    }
  }
}

/** Domain payload transformed during web replica schema migration. Identity and sync metadata stay outside this shape. */
export interface OfflineReplicaWebMigrationRow {
  readonly sourceKey: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly confirmedValues: Readonly<Record<string, unknown>> | null;
}

/** Result of {@link OfflineReplicaMigration.migrateWebRow}; `null` deletes the stored row. */
export type OfflineReplicaWebMigrationResult = OfflineReplicaWebMigrationRow | null;

/** Transforms one replica row's domain projection during a web schema migration step. */
export type OfflineReplicaWebMigrationCallback = (
  row: OfflineReplicaWebMigrationRow,
) => OfflineReplicaWebMigrationResult | Promise<OfflineReplicaWebMigrationResult>;

/** One explicit schema-version step applied during offline SQLite and web replica migrations. */
export interface OfflineReplicaMigration {
  /** Source schema version; the migration advances to {@link fromVersion} + 1. */
  readonly fromVersion: number;
  /** Non-empty DDL/DML statements executed in order on native SQLite for this step. Web ignores these. */
  readonly statements: readonly string[];
  /**
   * Transforms one row's domain projection for web storage during this step.
   * The callback receives only {@link OfflineReplicaWebMigrationRow}; it must not read or mutate
   * `localId`, `remoteId`, scope, revision, or `syncState`. Return `null` to delete the row.
   */
  readonly migrateWebRow: OfflineReplicaWebMigrationCallback;
}

/** Versioned product replica schema bundle with entities and migration path. */
export interface OfflineReplicaSchemaBundle {
  /** Current bundle schema version. */
  readonly version: number;
  /** Entity schemas sorted by {@link OfflineReplicaEntitySchema.sourceKey}. */
  readonly entities: readonly OfflineReplicaEntitySchema<Record<string, unknown>>[];
  /** Migrations sorted by {@link OfflineReplicaMigration.fromVersion}. */
  readonly migrations: readonly OfflineReplicaMigration[];
  /** Canonical fingerprint input spanning version and every entity fingerprint. */
  readonly schemaFingerprintInput: string;
}

/** Input accepted by {@link defineOfflineReplicaSchema}. */
export interface OfflineReplicaSchemaDefinition {
  /** Current bundle schema version. */
  readonly version: number;
  /** Entity schemas for the bundle version. */
  readonly entities: readonly OfflineReplicaEntitySchema<Record<string, unknown>>[];
  /** Ordered one-step migrations from older bundle versions. */
  readonly migrations: readonly OfflineReplicaMigration[];
}

/**
 * Validates and materializes a versioned offline replica schema bundle.
 *
 * Entity `tableName` and `sourceKey` values must each be unique within the bundle.
 * Migrations must advance one version at a time without duplicates or gaps.
 */
export function defineOfflineReplicaSchema(definition: OfflineReplicaSchemaDefinition): OfflineReplicaSchemaBundle {
  assertPositiveInteger(definition.version, 'schema version');

  const entities = [...definition.entities].sort((left, right) =>
    left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0,
  );
  const tableNames = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const entity of entities) {
    if (tableNames.has(entity.tableName)) {
      throw new Error(`Duplicate replica entity table "${entity.tableName}".`);
    }
    tableNames.add(entity.tableName);

    if (sourceKeys.has(entity.sourceKey)) {
      throw new Error(`Duplicate replica entity source key "${entity.sourceKey}".`);
    }
    sourceKeys.add(entity.sourceKey);
  }

  const migrations = normalizeOfflineReplicaMigrations(definition.migrations, definition.version);
  const schemaFingerprintInput = buildBundleSchemaFingerprintInput(definition.version, entities, migrations);

  return {
    version: definition.version,
    entities,
    migrations,
    schemaFingerprintInput,
  };
}

/**
 * Computes a lowercase SHA-256 hex digest of {@link OfflineReplicaSchemaBundle.schemaFingerprintInput}.
 */
export async function sha256OfflineReplicaSchema(bundle: OfflineReplicaSchemaBundle): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle.schemaFingerprintInput));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeOfflineReplicaMigrations(
  migrations: readonly OfflineReplicaMigration[],
  bundleVersion: number,
): readonly OfflineReplicaMigration[] {
  const sorted = [...migrations].sort((left, right) => left.fromVersion - right.fromVersion);
  const seenFromVersions = new Set<number>();

  for (const migration of sorted) {
    assertPositiveInteger(migration.fromVersion, 'migration fromVersion');

    const targetVersion = migration.fromVersion + 1;
    if (targetVersion > bundleVersion) {
      throw new Error(
        `Replica migration from version ${migration.fromVersion} targets version ${targetVersion}, which exceeds bundle version ${bundleVersion}.`,
      );
    }

    if (seenFromVersions.has(migration.fromVersion)) {
      throw new Error(`Duplicate replica migration from version ${migration.fromVersion}.`);
    }
    seenFromVersions.add(migration.fromVersion);

    if (typeof migration.migrateWebRow !== 'function') {
      throw new Error(`Replica migration from version ${migration.fromVersion} requires migrateWebRow.`);
    }

    if (migration.statements.length === 0) {
      throw new Error(`Replica migration from version ${migration.fromVersion} requires at least one SQL statement.`);
    }

    for (const [index, statement] of migration.statements.entries()) {
      if (!statement.trim()) {
        throw new Error(`Replica migration from version ${migration.fromVersion} statement ${index + 1} must not be empty.`);
      }
    }
  }

  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.fromVersion !== previous.fromVersion + 1) {
      throw new Error(
        `Replica migrations must advance consecutive schema versions; expected fromVersion ${previous.fromVersion + 1}, received ${current.fromVersion}.`,
      );
    }
  }

  if (sorted.length > 0 && sorted[0]!.fromVersion !== 1) {
    throw new Error(
      `Replica migrations must advance consecutive schema versions; expected fromVersion 1, received ${sorted[0]!.fromVersion}.`,
    );
  }

  return sorted;
}

function buildBundleSchemaFingerprintInput(
  version: number,
  entities: readonly OfflineReplicaEntitySchema<Record<string, unknown>>[],
  migrations: readonly OfflineReplicaMigration[],
): string {
  const entityFingerprints = entities.map((entity) => entity.schemaFingerprintInput).join(';');
  const migrationFingerprints = migrations
    .map((migration) => `from=${migration.fromVersion}|statements=${migration.statements.join('\n')}`)
    .join(';');
  return `version=${version}|entities=${entityFingerprints}|migrations=${migrationFingerprints}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Replica ${label} must be a positive integer.`);
  }
}
