/* eslint-disable @typescript-eslint/consistent-type-definitions */
import { describe, expect, it } from 'vitest';
import {
  booleanColumn,
  datetime,
  decodeOfflineReplicaValues,
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  encodeOfflineReplicaValues,
  ignored,
  integer,
  json,
  nullable,
  projectOfflineReplicaValues,
  real,
  serverId,
  sha256OfflineReplicaSchema,
  text,
} from './offline-replica-schema';

type SampleSelect = {
  id: number;
  title: string;
  notes: string | null;
  amount: number;
  active: boolean;
  payload: { version: number };
  updatedAt: string | Date;
  transientFlag: boolean;
};

const sampleSchema = defineReplicaEntity<SampleSelect>()({
  table: 'sample_items',
  sourceKey: 'sample_items',
  scope: 'group',
  fields: {
    id: serverId(),
    title: text(),
    notes: nullable(text()),
    amount: real(),
    active: booleanColumn(),
    payload: json<{ version: number }>(),
    updatedAt: datetime(),
    transientFlag: ignored('server-only cache flag'),
  },
});

describe('offline-replica-schema runtime', () => {
  it('materializes ordered field descriptors with table metadata', () => {
    expect(sampleSchema.tableName).toBe('sample_items');
    expect(sampleSchema.sourceKey).toBe('sample_items');
    expect(sampleSchema.scope).toBe('group');
    expect(sampleSchema.fields.map((field) => field.sourceKey)).toEqual([
      'active',
      'amount',
      'id',
      'notes',
      'payload',
      'title',
      'transientFlag',
      'updatedAt',
    ]);
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'id')).toEqual({
      sourceKey: 'id',
      policy: 'serverId',
      sqliteColumnName: 'server_id',
      affinity: 'INTEGER',
      storageKind: null,
      nullable: true,
      ignoredReason: null,
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'notes')).toMatchObject({
      policy: 'column',
      sqliteColumnName: 'notes',
      affinity: 'TEXT',
      storageKind: 'text',
      nullable: true,
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'updatedAt')).toMatchObject({
      policy: 'column',
      sqliteColumnName: 'updated_at',
      affinity: 'TEXT',
      storageKind: 'datetime',
      nullable: false,
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'active')).toMatchObject({
      storageKind: 'booleanColumn',
      affinity: 'INTEGER',
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'amount')).toMatchObject({
      storageKind: 'real',
      affinity: 'REAL',
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'payload')).toMatchObject({
      storageKind: 'json',
      affinity: 'TEXT',
    });
    expect(sampleSchema.fields.find((field) => field.sourceKey === 'transientFlag')).toMatchObject({
      policy: 'ignored',
      sqliteColumnName: null,
      ignoredReason: 'server-only cache flag',
    });
  });

  it('generates deterministic CREATE TABLE SQL and scoped server_id index', () => {
    expect(sampleSchema.createTableSql).toEqual([
      `CREATE TABLE IF NOT EXISTS sample_items (
  local_id TEXT NOT NULL,
  _offline_user_id INTEGER NOT NULL,
  _offline_group_id INTEGER NOT NULL,
  server_id INTEGER,
  _offline_confirmed_json TEXT,
  _offline_server_revision_json TEXT,
  _offline_sync_state TEXT NOT NULL,
  _offline_fetched_at INTEGER NOT NULL,
  active INTEGER NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  payload TEXT NOT NULL,
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_id)
)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_sample_items_server_id ON sample_items (_offline_user_id, _offline_group_id, server_id) WHERE server_id IS NOT NULL',
    ]);
  });

  it('omits _offline_group_id and scopes the partial index to _offline_user_id for user scope', () => {
    type UserScopedSelect = { id: number; title: string };
    const userScopedSchema = defineReplicaEntity<UserScopedSelect>()({
      table: 'user_notes',
      sourceKey: 'user_notes',
      scope: 'user',
      fields: {
        id: serverId(),
        title: text(),
      },
    });

    expect(userScopedSchema.createTableSql).toEqual([
      `CREATE TABLE IF NOT EXISTS user_notes (
  local_id TEXT NOT NULL,
  _offline_user_id INTEGER NOT NULL,
  server_id INTEGER,
  _offline_confirmed_json TEXT,
  _offline_server_revision_json TEXT,
  _offline_sync_state TEXT NOT NULL,
  _offline_fetched_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (local_id)
)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_user_notes_server_id ON user_notes (_offline_user_id, server_id) WHERE server_id IS NOT NULL',
    ]);
  });

  it('exposes a deterministic schema fingerprint input', () => {
    expect(sampleSchema.schemaFingerprintInput).toBe(
      'table=sample_items|source=sample_items|scope=group|hasServerId=1|fields=active:column:active:INTEGER:booleanColumn:required;amount:column:amount:REAL:real:required;id:serverId:server_id:INTEGER:nullable;notes:column:notes:TEXT:text:nullable;payload:column:payload:TEXT:json:required;title:column:title:TEXT:text:required;transientFlag:ignored:server-only cache flag;updatedAt:column:updated_at:TEXT:datetime:required',
    );
  });

  it('rejects invalid table and reserved column identifiers', () => {
    type MinimalSelect = { id: number; title: string };
    expect(() =>
      defineReplicaEntity<MinimalSelect>()({
        table: 'Bad-Table',
        sourceKey: 'items',
        scope: 'user',
        fields: { id: serverId(), title: text() },
      }),
    ).toThrow('Replica table "Bad-Table" must match ^[a-z][a-z0-9_]*$.');

    expect(() =>
      defineReplicaEntity<MinimalSelect>()({
        table: 'items',
        sourceKey: 'items',
        scope: 'user',
        fields: {
          id: serverId(),
          title: { kind: 'column', affinity: 'TEXT', storageKind: 'text', columnName: 'local_id', nullable: false },
        },
      }),
    ).toThrow('Replica column "local_id" is reserved.');
  });

  it('rejects ignored fields with an empty reason', () => {
    type Select = { id: number; flag: boolean };
    expect(() =>
      defineReplicaEntity<Select>()({
        table: 'items',
        sourceKey: 'items',
        scope: 'user',
        fields: { id: serverId(), flag: ignored('   ') },
      }),
    ).toThrow('Replica ignored field "flag" requires a reason.');
  });

  it('rejects more than one serverId field', () => {
    type Select = { id: number; altId: number };
    expect(() =>
      defineReplicaEntity<Select>()({
        table: 'items',
        sourceKey: 'items',
        scope: 'user',
        fields: { id: serverId(), altId: serverId() },
      }),
    ).toThrow('Replica entity must define at most one serverId field.');
  });

  it('supports a local-only projection without a serverId field', () => {
    type Select = { title: string };
    const schema = defineReplicaEntity<Select>()({
      table: 'items',
      sourceKey: 'items',
      scope: 'user',
      fields: { title: text() },
    });

    expect(schema.fields).toEqual([
      expect.objectContaining({
        sourceKey: 'title',
        policy: 'column',
        sqliteColumnName: 'title',
      }),
    ]);
    expect(schema.createTableSql[0]).not.toContain('server_id');
    expect(schema.schemaFingerprintInput).toContain('hasServerId=0');
  });
});

const sampleRowValues = {
  id: 42,
  title: 'Sample',
  notes: null,
  amount: 12.5,
  active: true,
  payload: { version: 3 },
  updatedAt: '2026-07-22T12:00:00.000Z',
  transientFlag: true,
};

describe('encodeOfflineReplicaValues', () => {
  it('encodes column fields in deterministic descriptor order and ignores serverId/ignored source keys', () => {
    const encoded = encodeOfflineReplicaValues(sampleSchema, sampleRowValues);

    expect(Object.keys(encoded)).toEqual(['active', 'amount', 'notes', 'payload', 'title', 'updated_at']);
    expect(encoded).toEqual({
      active: 1,
      amount: 12.5,
      notes: null,
      payload: '{"version":3}',
      title: 'Sample',
      updated_at: '2026-07-22T12:00:00.000Z',
    });
  });

  it('accepts nullable null, Date datetimes, and JSON-serializable payloads', () => {
    const encoded = encodeOfflineReplicaValues(sampleSchema, {
      ...sampleRowValues,
      notes: 'memo',
      updatedAt: new Date('2026-07-22T12:00:00.000Z'),
      active: false,
    });

    expect(encoded['notes']).toBe('memo');
    expect(encoded['updated_at']).toBe('2026-07-22T12:00:00.000Z');
    expect(encoded['active']).toBe(0);
  });

  it('rejects non-plain objects, unknown keys, and missing column fields', () => {
    expect(() => encodeOfflineReplicaValues(sampleSchema, null)).toThrow('Replica row values must be a plain object.');
    expect(() => encodeOfflineReplicaValues(sampleSchema, new Map())).toThrow('Replica row values must be a plain object.');

    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        surprise: 'schema drift',
      }),
    ).toThrow('Replica row contains unknown source key "surprise".');

    const { title: _title, ...missingTitle } = sampleRowValues;
    expect(() => encodeOfflineReplicaValues(sampleSchema, missingTitle)).toThrow('Replica row is missing required source key "title".');
  });

  it('rejects null for required columns and invalid typed values', () => {
    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        title: null,
      }),
    ).toThrow('Replica row source key "title" must not be null.');

    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        amount: Number.NaN,
      }),
    ).toThrow('Replica row source key "amount" must be a finite number.');

    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        active: 1,
      }),
    ).toThrow('Replica row source key "active" must be a boolean.');

    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        payload: { version: undefined },
      }),
    ).toThrow('Replica row source key "payload" must be JSON-serializable without undefined.');

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      encodeOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        payload: cyclic,
      }),
    ).toThrow('Replica row source key "payload" must be JSON-serializable without cycles.');
  });
});

const sampleColumnValues = {
  title: 'Sample',
  notes: null,
  amount: 12.5,
  active: true,
  payload: { version: 3 },
  updatedAt: '2026-07-22T12:00:00.000Z',
};

describe('decodeOfflineReplicaValues', () => {
  it('decodes column fields keyed by source property names and ignores serverId/ignored columns', () => {
    const encoded = encodeOfflineReplicaValues(sampleSchema, sampleRowValues);
    const decoded = decodeOfflineReplicaValues(sampleSchema, {
      ...encoded,
      server_id: 42,
      local_id: 'local-1',
      _offline_user_id: 7,
      _offline_group_id: 3,
      _offline_confirmed_json: null,
      _offline_server_revision_json: null,
      _offline_sync_state: 'synced',
      _offline_fetched_at: 1_720_000_000_000,
    });

    expect(Object.keys(decoded)).toEqual(['active', 'amount', 'notes', 'payload', 'title', 'updatedAt']);
    expect(decoded).toEqual(sampleColumnValues);
  });

  it('rejects non-plain objects, missing columns, and null for required columns', () => {
    const encoded = encodeOfflineReplicaValues(sampleSchema, sampleRowValues);

    expect(() => decodeOfflineReplicaValues(sampleSchema, null)).toThrow('Replica SQLite row must be a plain object.');
    expect(() => decodeOfflineReplicaValues(sampleSchema, new Map())).toThrow('Replica SQLite row must be a plain object.');

    const { title: _title, ...missingTitle } = encoded;
    expect(() => decodeOfflineReplicaValues(sampleSchema, missingTitle)).toThrow('Replica SQLite row is missing required column "title".');

    expect(() =>
      decodeOfflineReplicaValues(sampleSchema, {
        ...encoded,
        title: null,
      }),
    ).toThrow('Replica SQLite column "title" must not be null.');
  });

  it('rejects invalid SQLite column values', () => {
    const encoded = encodeOfflineReplicaValues(sampleSchema, sampleRowValues);

    expect(() =>
      decodeOfflineReplicaValues(sampleSchema, {
        ...encoded,
        amount: Number.NaN,
      }),
    ).toThrow('Replica row source key "amount" must be a finite number.');

    expect(() =>
      decodeOfflineReplicaValues(sampleSchema, {
        ...encoded,
        active: true,
      }),
    ).toThrow('Replica row source key "active" must be boolean integer 0 or 1.');

    expect(() =>
      decodeOfflineReplicaValues(sampleSchema, {
        ...encoded,
        payload: '{invalid',
      }),
    ).toThrow('Replica row source key "payload" must be valid JSON.');
  });
});

describe('encodeOfflineReplicaValues round-trip', () => {
  it('round-trips column values through encode and decode', () => {
    const sourceRows = [
      sampleRowValues,
      {
        ...sampleRowValues,
        notes: 'memo',
        updatedAt: new Date('2026-07-22T12:00:00.000Z'),
        active: false,
      },
    ];

    for (const sourceRow of sourceRows) {
      const encoded = encodeOfflineReplicaValues(sampleSchema, sourceRow);
      const decoded = decodeOfflineReplicaValues(sampleSchema, encoded);

      expect(decoded).toEqual({
        title: sourceRow.title,
        notes: sourceRow.notes,
        amount: sourceRow.amount,
        active: sourceRow.active,
        payload: sourceRow.payload,
        updatedAt: sourceRow.updatedAt instanceof Date ? sourceRow.updatedAt.toISOString() : sourceRow.updatedAt,
      });
    }
  });
});

describe('projectOfflineReplicaValues', () => {
  it('projects column fields and omits serverId and ignored source keys', () => {
    expect(projectOfflineReplicaValues(sampleSchema, sampleRowValues)).toEqual(sampleColumnValues);
    expect(Object.keys(projectOfflineReplicaValues(sampleSchema, sampleRowValues))).not.toContain('id');
    expect(Object.keys(projectOfflineReplicaValues(sampleSchema, sampleRowValues))).not.toContain('transientFlag');
  });

  it('validates values like encodeOfflineReplicaValues before projecting', () => {
    expect(() => projectOfflineReplicaValues(sampleSchema, null)).toThrow('Replica row values must be a plain object.');
    expect(() =>
      projectOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        surprise: 'schema drift',
      }),
    ).toThrow('Replica row contains unknown source key "surprise".');
    expect(() =>
      projectOfflineReplicaValues(sampleSchema, {
        ...sampleRowValues,
        title: null,
      }),
    ).toThrow('Replica row source key "title" must not be null.');
  });
});

type UserNotesSelect = { id: number; title: string };
const userNotesSchema = defineReplicaEntity<UserNotesSelect>()({
  table: 'user_notes',
  sourceKey: 'user_notes',
  scope: 'user',
  fields: {
    id: serverId(),
    title: text(),
  },
});

const schemaBundle = defineOfflineReplicaSchema({
  version: 2,
  entities: [userNotesSchema, sampleSchema],
  migrations: [
    {
      fromVersion: 1,
      statements: ['ALTER TABLE sample_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0'],
      migrateWebRow: (row) => row,
    },
  ],
});

describe('offline-replica-schema bundle runtime', () => {
  it('orders entities and migrations deterministically regardless of input order', () => {
    const reversed = defineOfflineReplicaSchema({
      version: 2,
      entities: [sampleSchema, userNotesSchema],
      migrations: [
        {
          fromVersion: 1,
          statements: ['ALTER TABLE sample_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0'],
          migrateWebRow: (row) => row,
        },
      ],
    });

    expect(schemaBundle.entities.map((entity) => entity.sourceKey)).toEqual(['sample_items', 'user_notes']);
    expect(schemaBundle.migrations.map((migration) => migration.fromVersion)).toEqual([1]);
    expect(reversed.schemaFingerprintInput).toBe(schemaBundle.schemaFingerprintInput);
    expect(reversed.entities).toEqual(schemaBundle.entities);
    expect(reversed.migrations.map((migration) => migration.statements)).toEqual(
      schemaBundle.migrations.map((migration) => migration.statements),
    );
  });

  it('exposes a canonical bundle schema fingerprint input', () => {
    expect(schemaBundle.schemaFingerprintInput).toBe(
      `version=2|entities=${sampleSchema.schemaFingerprintInput};${userNotesSchema.schemaFingerprintInput}|migrations=from=1|statements=ALTER TABLE sample_items ADD COLUMN legacy_flag INTEGER NOT NULL DEFAULT 0`,
    );
  });

  it('computes a stable 64-character lowercase sha256 digest', async () => {
    const digest = await sha256OfflineReplicaSchema(schemaBundle);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe('0c276e4507eff8937278ac5126fe66aceab802ef780efc459d80de70dba050f5');
  });

  it('changes the bundle fingerprint when storageKind changes from integer to booleanColumn while affinity stays INTEGER', async () => {
    type IntegerSelect = { id: number; flag: number };
    type BooleanSelect = { id: number; flag: boolean };

    const integerEntity = defineReplicaEntity<IntegerSelect>()({
      table: 'flag_items',
      sourceKey: 'flag_items',
      scope: 'user',
      fields: {
        id: serverId(),
        flag: integer(),
      },
    });
    const booleanEntity = defineReplicaEntity<BooleanSelect>()({
      table: 'flag_items',
      sourceKey: 'flag_items',
      scope: 'user',
      fields: {
        id: serverId(),
        flag: booleanColumn(),
      },
    });

    expect(integerEntity.fields.find((field) => field.sourceKey === 'flag')).toMatchObject({
      affinity: 'INTEGER',
      storageKind: 'integer',
    });
    expect(booleanEntity.fields.find((field) => field.sourceKey === 'flag')).toMatchObject({
      affinity: 'INTEGER',
      storageKind: 'booleanColumn',
    });
    expect(integerEntity.schemaFingerprintInput).not.toBe(booleanEntity.schemaFingerprintInput);

    const integerBundle = defineOfflineReplicaSchema({
      version: 1,
      entities: [integerEntity],
      migrations: [],
    });
    const booleanBundle = defineOfflineReplicaSchema({
      version: 1,
      entities: [booleanEntity],
      migrations: [],
    });

    expect(integerBundle.schemaFingerprintInput).not.toBe(booleanBundle.schemaFingerprintInput);
    expect(await sha256OfflineReplicaSchema(integerBundle)).not.toBe(await sha256OfflineReplicaSchema(booleanBundle));
  });

  it('rejects invalid bundle and migration versions', () => {
    expect(() =>
      defineOfflineReplicaSchema({
        version: 0,
        entities: [sampleSchema],
        migrations: [],
      }),
    ).toThrow('Replica schema version must be a positive integer.');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [{ fromVersion: 0, statements: ['SELECT 1'], migrateWebRow: (row) => row }],
      }),
    ).toThrow('Replica migration fromVersion must be a positive integer.');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [{ fromVersion: 2, statements: ['SELECT 1'], migrateWebRow: (row) => row }],
      }),
    ).toThrow('Replica migration from version 2 targets version 3, which exceeds bundle version 2.');
  });

  it('rejects duplicate entity identifiers and migration fromVersion values', () => {
    expect(() =>
      defineOfflineReplicaSchema({
        version: 1,
        entities: [sampleSchema, sampleSchema],
        migrations: [],
      }),
    ).toThrow('Duplicate replica entity table "sample_items".');

    type AltSelect = { id: number; title: string };
    const altTableSchema = defineReplicaEntity<AltSelect>()({
      table: 'alt_items',
      sourceKey: 'sample_items',
      scope: 'user',
      fields: {
        id: serverId(),
        title: text(),
      },
    });

    expect(() =>
      defineOfflineReplicaSchema({
        version: 1,
        entities: [sampleSchema, altTableSchema],
        migrations: [],
      }),
    ).toThrow('Duplicate replica entity source key "sample_items".');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [
          { fromVersion: 1, statements: ['SELECT 1'], migrateWebRow: (row) => row },
          { fromVersion: 1, statements: ['SELECT 2'], migrateWebRow: (row) => row },
        ],
      }),
    ).toThrow('Duplicate replica migration from version 1.');
  });

  it('rejects non-consecutive migrations and empty SQL statements', () => {
    expect(() =>
      defineOfflineReplicaSchema({
        version: 4,
        entities: [sampleSchema],
        migrations: [
          { fromVersion: 1, statements: ['SELECT 1'], migrateWebRow: (row) => row },
          { fromVersion: 3, statements: ['SELECT 2'], migrateWebRow: (row) => row },
        ],
      }),
    ).toThrow('Replica migrations must advance consecutive schema versions; expected fromVersion 2, received 3.');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [{ fromVersion: 1, statements: ['SELECT 1', '   '], migrateWebRow: (row) => row }],
      }),
    ).toThrow('Replica migration from version 1 statement 2 must not be empty.');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [{ fromVersion: 1, statements: [], migrateWebRow: (row) => row }],
      }),
    ).toThrow('Replica migration from version 1 requires at least one SQL statement.');

    expect(() =>
      defineOfflineReplicaSchema({
        version: 2,
        entities: [sampleSchema],
        migrations: [{ fromVersion: 1, statements: ['SELECT 1'] } as never],
      }),
    ).toThrow('Replica migration from version 1 requires migrateWebRow.');
  });
});

describe('offline-replica-schema types', () => {
  type CompileSelect = {
    id: number;
    title: string;
    notes: string | null;
  };

  it('type: every select key must appear exactly once', () => {
    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      fields: {
        id: serverId(),
        title: text(),
        notes: nullable(text()),
      },
    });

    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      // @ts-expect-error — `notes` is missing from the field map.
      fields: {
        id: serverId(),
        title: text(),
      },
    });

    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      // @ts-expect-error — `extra` is not part of the select shape.
      fields: {
        id: serverId(),
        title: text(),
        notes: nullable(text()),
        extra: text(),
      },
    });
  });

  it('type: column nullability must match the select property', () => {
    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      fields: {
        id: serverId(),
        title: text(),
        // @ts-expect-error — nullable select properties require nullable(...).
        notes: text(),
      },
    });

    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      fields: {
        id: serverId(),
        // @ts-expect-error — non-null select properties reject nullable(...).
        title: nullable(text()),
        notes: nullable(text()),
      },
    });

    defineReplicaEntity<CompileSelect>()({
      table: 'compile_items',
      sourceKey: 'compile_items',
      scope: 'group',
      fields: {
        id: serverId(),
        title: text(),
        notes: nullable(text()),
      },
    });
  });

  it('type: serverId() applies only to numeric source properties', () => {
    type StringIdSelect = { id: string; title: string };
    defineReplicaEntity<StringIdSelect>()({
      table: 'items',
      sourceKey: 'items',
      scope: 'user',
      fields: {
        // @ts-expect-error — serverId() cannot map a string property.
        id: serverId(),
        title: text(),
      },
    });
  });

  it('type: primitive literal unions use their SQLite builder primitive', () => {
    type LiteralSelect = {
      id: number;
      kind: 0 | 1;
      role: 'admin' | 'member';
    };

    defineReplicaEntity<LiteralSelect>()({
      table: 'literal_items',
      sourceKey: 'literal_items',
      scope: 'group',
      fields: {
        id: serverId(),
        kind: integer(),
        role: text(),
      },
    });
  });

  it('type: literal unions reject mismatched primitive builders', () => {
    type LiteralSelect = {
      id: number;
      kind: 0 | 1;
      role: 'admin' | 'member';
    };

    defineReplicaEntity<LiteralSelect>()({
      table: 'literal_mismatch_items',
      sourceKey: 'literal_mismatch_items',
      scope: 'group',
      fields: {
        id: serverId(),
        // @ts-expect-error — numeric literal unions require integer().
        kind: text(),
        // @ts-expect-error — string literal unions require text().
        role: integer(),
      },
    });
  });
});
