import {
  defineOfflineReplicaSchema,
  defineReplicaEntity,
  integer,
  nullable,
  serverId,
  text,
} from '../../../../dist/kit/types/rdlabo-ionic-angular-kit-offline';

// Type alias intentionally exercises Record compatibility in a non-strict-null consumer.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type NonStrictSelect = {
  id: number;
  title: string;
  subtitle: string | null;
  sortOrder: number;
};

const entity = defineReplicaEntity<NonStrictSelect>()({
  table: 'nonstrict_items',
  sourceKey: 'nonstrict_items',
  scope: 'user',
  fields: {
    id: serverId(),
    title: text(),
    subtitle: nullable(text()),
    sortOrder: integer(),
  },
});

defineOfflineReplicaSchema({
  version: 1,
  entities: [entity],
  migrations: [],
});

defineReplicaEntity<NonStrictSelect>()({
  table: 'nonstrict_invalid_items',
  sourceKey: 'nonstrict_invalid_items',
  scope: 'user',
  fields: {
    id: serverId(),
    // @ts-expect-error Primitive affinity checks remain active without strictNullChecks.
    title: integer(),
    subtitle: nullable(text()),
    sortOrder: integer(),
  },
});

defineReplicaEntity<NonStrictSelect>()({
  table: 'nonstrict_missing_items',
  sourceKey: 'nonstrict_missing_items',
  scope: 'user',
  // @ts-expect-error Exact-key validation still rejects a missing select property.
  fields: {
    id: serverId(),
    title: text(),
    subtitle: nullable(text()),
  },
});

defineReplicaEntity<NonStrictSelect>()({
  table: 'nonstrict_extra_items',
  sourceKey: 'nonstrict_extra_items',
  scope: 'user',
  // @ts-expect-error Exact-key validation still rejects an unknown property.
  fields: {
    id: serverId(),
    title: text(),
    subtitle: nullable(text()),
    sortOrder: integer(),
    extra: text(),
  },
});
