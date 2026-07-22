import { inject, Injectable, InjectionToken } from '@angular/core';
import { KitStorageService } from '@rdlabo/ionic-angular-kit';

export const OFFLINE_SCHEMA_VERSION = 2;
const FIRST_LOCAL_RESOURCE_ID = 2_000_000_000_000;

export interface OfflineScope {
  userId: number;
  groupId: number;
}

export interface OfflineEntity<T = unknown> extends OfflineScope {
  entityType: string;
  entityId: string;
  value: T;
  serverRevision: string | number | null;
  fetchedAt: number;
}

export interface OfflineQuery<T = unknown> extends OfflineScope {
  queryKey: string;
  value: T;
  orderedIds: string[];
  cursor: string | null;
  etag: string | null;
  fetchedAt: number;
  isComplete: boolean;
}

export type OfflineCommandState = 'pending' | 'sending' | 'retry_wait' | 'blocked_auth' | 'rejected' | 'conflict';

export interface OfflineCommand<T = unknown> extends OfflineScope {
  commandId: string;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  payload: T;
  payloadHash: string;
  baseRevision: string | number | null;
  state: OfflineCommandState;
  attempts: number;
  retryAt: number | null;
  createdAt: number;
  lastErrorCode: string | null;
}

export interface OfflineRepository {
  initialize(): Promise<void>;
  getLastUserId(): Promise<number | null>;
  setLastUserId(userId: number): Promise<void>;
  allocateLocalId(): Promise<number>;
  getEntity<T>(scope: OfflineScope, entityType: string, entityId: string): Promise<OfflineEntity<T> | null>;
  putEntity<T>(entity: OfflineEntity<T>): Promise<void>;
  getQuery<T>(scope: OfflineScope, queryKey: string): Promise<OfflineQuery<T> | null>;
  putQuery<T>(query: OfflineQuery<T>): Promise<void>;
  getCommands(scope: OfflineScope): Promise<OfflineCommand[]>;
  putCommand(command: OfflineCommand): Promise<void>;
  replaceCommand(command: OfflineCommand): Promise<void>;
  removeCommand(commandId: string): Promise<void>;
  clearUser(userId: number): Promise<void>;
  clearGroup(scope: OfflineScope): Promise<void>;
}

export const OFFLINE_REPOSITORY = new InjectionToken<OfflineRepository>('OFFLINE_REPOSITORY');

export function selectOfflineRepository(
  platform: string,
  webRepository: OfflineRepository,
  nativeRepository: OfflineRepository,
): OfflineRepository {
  return platform === 'ios' || platform === 'android' ? nativeRepository : webRepository;
}

interface OfflineMetadata {
  schemaVersion: number;
  lastUserId: number | null;
  nextLocalId: number;
}

const METADATA_KEY = 'offline:metadata';
const ENTITIES_KEY = 'offline:business_cache:entities';
const QUERIES_KEY = 'offline:business_cache:queries';
const OUTBOX_KEY = 'offline:outbox:commands';

/** WebはIonic StorageのIndexedDB driverを利用する。 */
@Injectable({ providedIn: 'root' })
export class IonicOfflineRepository implements OfflineRepository {
  readonly #storage = inject(KitStorageService);
  #initialization: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();

  initialize(): Promise<void> {
    this.#initialization ??= this.#migrate();
    return this.#initialization;
  }

  async getLastUserId(): Promise<number | null> {
    await this.initialize();
    return (await this.#metadata()).lastUserId;
  }

  async setLastUserId(userId: number): Promise<void> {
    await this.initialize();
    await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...(await this.#metadata()), lastUserId: userId });
  }

  async allocateLocalId(): Promise<number> {
    await this.initialize();
    let allocated = FIRST_LOCAL_RESOURCE_ID;
    const write = this.#writes.then(async (): Promise<void> => {
      const metadata = await this.#metadata();
      allocated = Math.max(metadata.nextLocalId, FIRST_LOCAL_RESOURCE_ID) + 1;
      await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...metadata, nextLocalId: allocated });
    });
    this.#writes = write.catch((): void => undefined);
    await write;
    return allocated;
  }

  async getEntity<T>(scope: OfflineScope, entityType: string, entityId: string): Promise<OfflineEntity<T> | null> {
    await this.initialize();
    const entities = await this.#readRecord<OfflineEntity<T>>(ENTITIES_KEY);
    return entities[this.#entityKey(scope, entityType, entityId)] ?? null;
  }

  async putEntity<T>(entity: OfflineEntity<T>): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<OfflineEntity<T>>(ENTITIES_KEY, (entities) => {
      entities[this.#entityKey(entity, entity.entityType, entity.entityId)] = entity;
      return entities;
    });
  }

  async getQuery<T>(scope: OfflineScope, queryKey: string): Promise<OfflineQuery<T> | null> {
    await this.initialize();
    const queries = await this.#readRecord<OfflineQuery<T>>(QUERIES_KEY);
    return queries[this.#queryKey(scope, queryKey)] ?? null;
  }

  async putQuery<T>(query: OfflineQuery<T>): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<OfflineQuery<T>>(QUERIES_KEY, (queries) => {
      queries[this.#queryKey(query, query.queryKey)] = query;
      return queries;
    });
  }

  async getCommands(scope: OfflineScope): Promise<OfflineCommand[]> {
    await this.initialize();
    const commands = await this.#readRecord<OfflineCommand>(OUTBOX_KEY);
    return Object.values(commands)
      .filter((command) => command.userId === scope.userId && command.groupId === scope.groupId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async putCommand(command: OfflineCommand): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<OfflineCommand>(OUTBOX_KEY, (commands) => {
      commands[command.commandId] = command;
      return commands;
    });
  }

  replaceCommand(command: OfflineCommand): Promise<void> {
    return this.putCommand(command);
  }

  async removeCommand(commandId: string): Promise<void> {
    await this.initialize();
    await this.#mutateRecord<OfflineCommand>(OUTBOX_KEY, (commands) => {
      delete commands[commandId];
      return commands;
    });
  }

  async clearUser(userId: number): Promise<void> {
    await this.initialize();
    await Promise.all([
      this.#filterRecord<OfflineEntity>(ENTITIES_KEY, (value) => value.userId !== userId),
      this.#filterRecord<OfflineQuery>(QUERIES_KEY, (value) => value.userId !== userId),
      this.#filterRecord<OfflineCommand>(OUTBOX_KEY, (value) => value.userId !== userId),
    ]);
    const metadata = await this.#metadata();
    if (metadata.lastUserId === userId) {
      await this.#storage.set<OfflineMetadata>(METADATA_KEY, { ...metadata, lastUserId: null });
    }
  }

  async clearGroup(scope: OfflineScope): Promise<void> {
    await this.initialize();
    const belongsToGroup = (value: OfflineScope) => value.userId === scope.userId && value.groupId === scope.groupId;
    await Promise.all([
      this.#filterRecord<OfflineEntity>(ENTITIES_KEY, (value) => !belongsToGroup(value)),
      this.#filterRecord<OfflineQuery>(QUERIES_KEY, (value) => !belongsToGroup(value)),
      this.#filterRecord<OfflineCommand>(OUTBOX_KEY, (value) => !belongsToGroup(value)),
    ]);
  }

  async #migrate(): Promise<void> {
    const metadata = await this.#storage.get<OfflineMetadata>(METADATA_KEY);
    if (metadata?.schemaVersion === OFFLINE_SCHEMA_VERSION) return;
    await Promise.all([this.#storage.remove(ENTITIES_KEY), this.#storage.remove(QUERIES_KEY), this.#storage.remove(OUTBOX_KEY)]);
    await this.#storage.set<OfflineMetadata>(METADATA_KEY, {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      lastUserId: metadata?.lastUserId ?? null,
      nextLocalId: metadata?.nextLocalId ?? FIRST_LOCAL_RESOURCE_ID,
    });
  }

  async #metadata(): Promise<OfflineMetadata> {
    const metadata = await this.#storage.get<Partial<OfflineMetadata>>(METADATA_KEY);
    return {
      schemaVersion: metadata?.schemaVersion ?? OFFLINE_SCHEMA_VERSION,
      lastUserId: metadata?.lastUserId ?? null,
      nextLocalId: metadata?.nextLocalId ?? FIRST_LOCAL_RESOURCE_ID,
    };
  }

  async #readRecord<T>(key: string): Promise<Record<string, T>> {
    return (await this.#storage.get<Record<string, T>>(key)) ?? {};
  }

  async #filterRecord<T>(key: string, predicate: (value: T) => boolean): Promise<void> {
    await this.#mutateRecord<T>(key, (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => predicate(value))));
  }

  #mutateRecord<T>(key: string, mutate: (record: Record<string, T>) => Record<string, T>): Promise<void> {
    const write = this.#writes.then(async (): Promise<void> => {
      const record = await this.#readRecord<T>(key);
      await this.#storage.set(key, mutate(record));
    });
    this.#writes = write.catch((): void => undefined);
    return write;
  }

  #entityKey(scope: OfflineScope, entityType: string, entityId: string): string {
    return `${scope.userId}:${scope.groupId}:${entityType}:${entityId}`;
  }

  #queryKey(scope: OfflineScope, queryKey: string): string {
    return `${scope.userId}:${scope.groupId}:${queryKey}`;
  }
}
