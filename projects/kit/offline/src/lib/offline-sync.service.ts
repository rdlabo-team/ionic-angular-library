import { computed, effect, ErrorHandler, inject, Injectable, InjectionToken, signal } from '@angular/core';
import {
  OFFLINE_COMMAND_EXECUTOR,
  OFFLINE_SYNC_CONTEXT,
  offlineCommandLookupIdentity,
  offlineCommandTargetFromReplicaRow,
  type OfflineCommandResult,
  type EnqueueOfflineCommandIdentity,
  type OfflineSyncSession,
} from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineReplicaPullService, OfflineReplicaSchemaMismatchError } from './offline-replica-pull.service';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import type {
  OfflineCommand,
  OfflineReplicaSyncState,
  OfflineReplicaRow,
  OfflineReplicaRowKey,
  OfflineReplicaTransaction,
  OfflineOptimisticReplicaCompanion,
  OfflineRepository,
  OfflineScope,
} from './offline-repository';
import { canonicalOfflineReplicaRowKey, OFFLINE_REPOSITORY } from './offline-repository';
import {
  canonicalOfflinePrincipalId,
  canonicalOfflineCommandIdentity,
  commandIdentityFromReplicaIdentity,
  commandIdentityMatchesReplicaRow,
  offlineGeneratedReplicaIdentity,
  offlineNaturalReplicaIdentity,
  type OfflineCommandIdentity,
  type OfflinePrincipalId,
} from './offline-identity';
import {
  assertOfflineReplicaGeneratedRemoteId,
  canonicalOfflineRemoteIdentity,
  offlineNaturalKeyFromValues,
  type OfflineGeneratedRemoteId,
  type OfflineReplicaEntitySchema,
} from './offline-replica-schema';

/** Aggregate synchronization state exposed to application UI. */
export type OfflineSyncState = 'idle' | 'pending' | 'syncing' | 'attention';

/** Mutation and optimistic entity materialization appended atomically to the outbox. */
export interface EnqueueOfflineCommand<T = unknown> {
  scopeId: string;
  aggregateType: string;
  identity: EnqueueOfflineCommandIdentity;
  operation: string;
  payload: T;
  /** Full local entity value committed to the replica before the command is exposed to the UI. */
  optimisticValue: unknown;
  /**
   * Optimistically hides an existing DB row while retaining its identity and
   * confirmed baseline for durable replay, conflict handling, and discard.
   */
  replicaMutation?: 'upsert' | 'delete';
  baseRevision?: string | number | null;
}

/**
 * A command prepared from replica reads while enqueue/ACK projection is
 * serialized. Only product-owned row changes are accepted here; the sync
 * service owns Outbox and cursor changes.
 */
export interface PreparedOfflineCommand<T = unknown> {
  request: EnqueueOfflineCommand<T>;
  replicaTransaction?: Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>;
}

export interface PreparedOfflineBatchOptions {
  flush?: boolean;
  /** Product identity/scope lease asserted after all async preparation and immediately before the durable commit. */
  assertCurrent?: () => void;
}

/** Validated optimistic projection ready for a single Outbox commit. */
interface MaterializedOfflineEnqueue {
  command: OfflineCommand;
  optimisticRow: OfflineReplicaRow;
  optimisticCompanions: readonly OfflineOptimisticReplicaCompanion[];
}

/** Raised before persistence when an outbox payload is not losslessly JSON serializable. */
export class OfflinePayloadValidationError extends Error {
  constructor(message = 'Offline command payload must contain only JSON values') {
    super(message);
    this.name = 'OfflinePayloadValidationError';
  }
}

/** Raised before persistence when retaining another command would exceed the configured durable Outbox capacity. */
export class OfflineOutboxCapacityError extends Error {
  constructor(
    readonly reason: 'command_count' | 'serialized_bytes',
    readonly currentCommands: number,
    readonly currentBytes: number,
  ) {
    super(
      reason === 'command_count'
        ? 'Offline Outbox command limit reached; synchronize or discard a pending command before continuing'
        : 'Offline Outbox storage limit reached; synchronize or discard a pending command before continuing',
    );
    this.name = 'OfflineOutboxCapacityError';
  }
}

/** Raised when a discard could race a request whose server commit is unknown. */
export class OfflineCommandInFlightError extends Error {
  constructor(readonly commandIds: readonly string[]) {
    super('Offline commands are being synchronized and cannot be discarded until their server result is known');
    this.name = 'OfflineCommandInFlightError';
  }
}

const MAX_PARALLEL_AGGREGATES = 3;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const POST_SEND_PULL_RETRY_MS = 1_000;
const DEFAULT_MAX_OUTBOX_COMMANDS_PER_USER = 1_000;
const DEFAULT_MAX_OUTBOX_BYTES_PER_USER = 10 * 1024 * 1024;

/** Injectable `[0, 1)` source used by equal-jitter retry delay. Defaults to `Math.random`. */
export const OFFLINE_RETRY_RANDOM = new InjectionToken<() => number>('OFFLINE_RETRY_RANDOM', {
  factory: () => Math.random,
});

/**
 * Equal-jitter delay in `[⌊cap/2⌋, cap)` for exponential offline command backoff.
 * Keeps a positive lower bound (half the exponential cap) while still desynchronizing clients.
 *
 * @param attempts - Attempt count already recorded on the failed command (`>= 1` after a send claim).
 * @param random - Unit interval sample in `[0, 1)`.
 */
export function offlineRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const cap = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1));
  const unit = random();
  if (!(unit >= 0 && unit < 1)) {
    throw new Error('Offline retry random() must return a number in [0, 1).');
  }
  const half = cap / 2;
  return Math.floor(half + unit * half);
}

/** Maintains the optimistic local replica and synchronizes its durable outbox. */
@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  readonly #network = inject(OfflineNetworkService);
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #executor = inject(OFFLINE_COMMAND_EXECUTOR);
  readonly #context = inject(OFFLINE_SYNC_CONTEXT);
  readonly #hooks = inject(OFFLINE_COMMAND_HOOKS);
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #pull = inject(OfflineReplicaPullService);
  readonly #replicaMutations = inject(OfflineReplicaMutationCoordinator);
  readonly #errorHandler = inject(ErrorHandler);
  readonly #retryRandom = inject(OFFLINE_RETRY_RANDOM);
  readonly #commands = signal<OfflineCommand[]>([]);
  readonly #knownScopes = new Map<string, OfflineScope>();
  /** ACKed scopes whose authoritative post-send pull has not completed yet. */
  readonly #pendingPullScopes = new Map<string, OfflineScope>();
  #activeUserId: OfflinePrincipalId | null = null;
  #flushPromise: Promise<void> | null = null;
  #partialFlushInFlight = false;
  #chainedFullFlush: Promise<void> | null = null;
  readonly #flushTransitions = new Set<Promise<void>>();
  #generation = 0;
  readonly #sendingTransitions = new Set<Promise<unknown>>();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** When non-null, automatic flushes pull only foreground scopes plus Outbox scopes. */
  #foregroundScopePolicy: readonly string[] | null = null;
  #initialized = false;
  #lastCommandCreatedAt = 0;
  #coldReconciliationRequired = this.#repository.getReconciliationScopes === undefined;

  readonly pendingCommands = this.#commands.asReadonly();
  readonly pendingCount = computed(() => this.pendingCommands().length);
  readonly conflicts = computed(() => this.#commands().filter((command) => command.state === 'conflict'));
  readonly syncState = computed<OfflineSyncState>(() => {
    const commands = this.#commands();
    if (commands.some((command) => ['blocked_auth', 'rejected', 'conflict'].includes(command.state))) return 'attention';
    // Any non-sending ambiguous commit (including restart-normalized pending+unknown) needs attention.
    if (commands.some((command) => command.state !== 'sending' && command.serverCommitUnknown === true)) return 'attention';
    if (commands.some((command) => command.state === 'sending')) return 'syncing';
    return commands.length > 0 ? 'pending' : 'idle';
  });

  constructor() {
    effect(() => {
      const connected = this.#network.connected();
      if (this.#initialized && connected) this.#flushInBackground();
    });
  }

  async initialize(options: { flush?: boolean } = {}): Promise<void> {
    if (this.#initialized) return;
    await this.#repository.initialize();
    await this.#discoverScopes();
    const commands = await this.#readKnownCommands();
    await Promise.all(
      commands
        .filter((command) => command.state === 'sending')
        .map((command) =>
          this.#repository.putCommand({
            ...command,
            state: 'pending',
            serverCommitUnknown: command.serverCommitUnknown ?? true,
          }),
        ),
    );
    this.#initialized = true;
    await this.#refreshState();
    if (options.flush !== false && this.#network.connected()) this.#flushInBackground();
  }

  noteScope(scope: OfflineScope): void {
    this.#knownScopes.set(this.#scopeKey(scope), scope);
  }

  async reloadPendingCommands(): Promise<void> {
    await this.initialize();
    await this.#refreshState();
  }

  async refreshSession(foregroundScopeIds?: readonly string[]): Promise<void> {
    this.#setForegroundScopePolicy(foregroundScopeIds);
    await this.initialize({ flush: false });
    await this.#discoverScopes();
    await this.#restoreInterruptedCommands();
    await this.#refreshState();
    if (this.#network.connected()) this.#flushInBackground();
  }

  /** Restores local outbox visibility without enabling pull or replay transport. */
  async refreshLocalSession(): Promise<void> {
    await this.initialize();
    await this.#discoverLocalScopes();
    await this.#restoreInterruptedCommands();
    await this.#refreshState();
  }

  async resetSession(): Promise<void> {
    this.revokeSession();
    await Promise.allSettled([this.#replicaMutations.drain(), ...this.#flushTransitions]);
    await this.#waitForSendingTransitions();
    await this.#restoreInterruptedCommands();
    this.#activeUserId = null;
    this.#knownScopes.clear();
    this.#pendingPullScopes.clear();
    this.#commands.set([]);
    this.#scheduleRetry(null);
  }

  /** Synchronously invalidate in-flight enqueue and transport work owned by the current session. */
  revokeSession(): void {
    this.#invalidateFlush();
    this.#foregroundScopePolicy = null;
  }

  enqueue<T>(request: EnqueueOfflineCommand<T>, options: { flush?: boolean } = {}): Promise<string> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(() => this.#enqueue(request, options, generation));
  }

  /**
   * Reads, derives, and commits the base optimistic row, product companion
   * rows, and Outbox command as one serialized replica transaction.
   */
  enqueuePrepared<T>(
    prepare: (repository: OfflineRepository) => Promise<PreparedOfflineCommand<T>>,
    options: { flush?: boolean } = {},
  ): Promise<string> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(async () => {
      await this.initialize();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared enqueue.');
      const prepared = await prepare(this.#repository);
      return this.#enqueue(prepared.request, options, generation, prepared.replicaTransaction);
    });
  }

  /**
   * Prepares and commits multiple Outbox commands as one serialized replica
   * transaction under a single captured session generation.
   *
   * All entries are prepared and validated before any write. Empty batches,
   * overlapping aggregate intents, and overlapping replica footprints are
   * rejected with no durable state change.
   */
  enqueuePreparedBatch<T>(
    prepare: (repository: OfflineRepository) => Promise<readonly PreparedOfflineCommand<T>[]>,
    options: PreparedOfflineBatchOptions = {},
  ): Promise<readonly string[]> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(async () => {
      await this.initialize();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared batch enqueue.');
      const prepared = await prepare(this.#repository);
      return this.#enqueuePreparedBatch(prepared, options, generation);
    });
  }

  /**
   * Atomically replaces a resolved durable command with a newly prepared command.
   *
   * Use this after an authoritative conflict read. The old intent remains durable
   * until validation, capacity checks, optimistic projection and replacement
   * command preparation have all succeeded.
   */
  replacePrepared<T>(
    commandId: string,
    prepare: (repository: OfflineRepository) => Promise<PreparedOfflineCommand<T>>,
    options: { flush?: boolean } = {},
  ): Promise<string> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(async () => {
      await this.initialize();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared replacement.');
      const knownCommands = await this.#readKnownCommands();
      const replaced = knownCommands.find((command) => command.commandId === commandId);
      if (!replaced) throw new Error(`Offline command ${commandId} no longer exists.`);
      this.#assertDiscardable([replaced]);
      if (
        knownCommands.some((command) => command.commandId !== commandId && this.#aggregateKey(command) === this.#aggregateKey(replaced))
      ) {
        throw new Error('Offline replacement requires the command to be the only pending intent for its aggregate.');
      }
      const prepared = await prepare(this.#repository);
      return this.#enqueue(prepared.request, options, generation, prepared.replicaTransaction, replaced);
    });
  }

  /**
   * Atomically rematerializes every unresolved intent for one aggregate.
   *
   * This is the conflict-recovery boundary for ordered intent chains: the old
   * chain remains durable until every replacement has been prepared and the
   * complete chain can be committed in one replica transaction.
   */
  replacePreparedAggregate<T>(
    commandId: string,
    prepare: (repository: OfflineRepository, commands: readonly OfflineCommand[]) => Promise<readonly PreparedOfflineCommand<T>[]>,
    options: PreparedOfflineBatchOptions = {},
  ): Promise<readonly string[]> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(async () => {
      await this.initialize();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared aggregate replacement.');
      const knownCommands = await this.#readKnownCommands();
      const selected = knownCommands.find((command) => command.commandId === commandId);
      if (!selected) throw new Error(`Offline command ${commandId} no longer exists.`);
      const aggregateKey = this.#aggregateKey(selected);
      const replaced = knownCommands.filter((command) => this.#aggregateKey(command) === aggregateKey);
      this.#assertDiscardable(replaced);
      const prepared = await prepare(this.#repository, replaced);
      if (prepared.length !== replaced.length) {
        throw new Error('Offline aggregate replacement must preserve the ordered intent count.');
      }
      const session = await this.#beginEnqueueSession(generation);
      const materializations: MaterializedOfflineEnqueue[] = [];
      for (const [index, entry] of prepared.entries()) {
        this.#assertEnqueueScope(session, entry.request.scopeId);
        materializations.push(await this.#materializeEnqueue(session.userId, entry.request, entry.replicaTransaction, replaced[index]));
      }
      const retained = knownCommands.filter((command) => !replaced.some((item) => item.commandId === command.commandId));
      this.#assertDistinctBatchFootprints(materializations, retained, true);
      await this.#assertOutboxCapacity(
        session.userId,
        materializations.map((item) => item.command),
        replaced.map((command) => command.commandId),
        knownCommands,
      );
      options.assertCurrent?.();
      await this.#commitMaterializedEnqueues(
        materializations,
        generation,
        options,
        replaced.map((command) => command.commandId),
      );
      return materializations.map((item) => item.command.commandId);
    });
  }

  /**
   * Serializes a product-owned replica projection with enqueue and command ACK
   * reconciliation. For read/derive/write cache updates, prefer
   * `runSerializedReplicaMutation` so the read is serialized as well.
   */
  async transactReplica(transaction: OfflineReplicaTransaction): Promise<void> {
    await this.runSerializedReplicaMutation(async (repository) => {
      await repository.transactReplica(transaction);
    });
  }

  /**
   * Runs a product cache's replica read/derive/write sequence atomically with
   * enqueue and ACK projection. Use this for any repository reads that inform
   * a later transaction; `transactReplica` alone only serializes the write.
   */
  runSerializedReplicaMutation<T>(operation: (repository: OfflineRepository) => Promise<T>): Promise<T> {
    const generation = this.#generation;
    return this.#serializeReplicaMutation(async () => {
      await this.initialize();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before serialized replica mutation.');
      const result = await operation(this.#repository);
      if (this.#isCurrent(generation)) await this.#refreshState(generation);
      return result;
    });
  }

  #serializeReplicaMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.#replicaMutations.run(operation);
  }

  async #enqueue<T>(
    request: EnqueueOfflineCommand<T>,
    options: { flush?: boolean },
    generation: number,
    replicaTransaction?: Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>,
    replaced?: OfflineCommand,
  ): Promise<string> {
    const session = await this.#beginEnqueueSession(generation);
    this.#assertEnqueueScope(session, request.scopeId);
    const materialization = await this.#materializeEnqueue(session.userId, request, replicaTransaction, replaced);
    const currentCommands = await this.#commandsForUser(session.userId);
    const retainedCommands = replaced ? currentCommands.filter((command) => command.commandId !== replaced.commandId) : currentCommands;
    this.#assertDistinctBatchFootprints([materialization], retainedCommands);
    await this.#assertOutboxCapacity(
      session.userId,
      [materialization.command],
      replaced ? [replaced.commandId] : undefined,
      currentCommands,
    );
    await this.#commitMaterializedEnqueues([materialization], generation, options, replaced ? [replaced.commandId] : undefined);
    return materialization.command.commandId;
  }

  async #enqueuePreparedBatch<T>(
    prepared: readonly PreparedOfflineCommand<T>[],
    options: PreparedOfflineBatchOptions,
    generation: number,
  ): Promise<readonly string[]> {
    if (prepared.length === 0) {
      throw new Error('Prepared offline batch must contain at least one command.');
    }
    const session = await this.#beginEnqueueSession(generation);
    const currentCommands = await this.#commandsForUser(session.userId);
    this.#rememberCreatedAt(currentCommands);
    const firstCreatedAt = Math.max(Date.now(), this.#lastCommandCreatedAt + 1);
    this.#lastCommandCreatedAt = firstCreatedAt + prepared.length - 1;
    const materializations: MaterializedOfflineEnqueue[] = [];
    for (const [index, entry] of prepared.entries()) {
      this.#assertEnqueueScope(session, entry.request.scopeId);
      materializations.push(
        await this.#materializeEnqueue(session.userId, entry.request, entry.replicaTransaction, undefined, firstCreatedAt + index),
      );
    }
    this.#assertDistinctBatchFootprints(materializations, currentCommands);
    await this.#assertOutboxCapacity(
      session.userId,
      materializations.map((item) => item.command),
      undefined,
      currentCommands,
    );
    options.assertCurrent?.();
    await this.#commitMaterializedEnqueues(materializations, generation, options);
    return materializations.map((item) => item.command.commandId);
  }

  async #beginEnqueueSession(generation: number): Promise<OfflineSyncSession> {
    await this.initialize();
    if (this.#options.mode === 'readCacheOnly') {
      throw new Error('This offline provider is configured as a read-only cache and cannot enqueue commands.');
    }
    const session = await this.#getLocalSession();
    if (!session) throw new Error('Cannot enqueue an offline command without an authenticated user');
    this.#assertSessionPrincipalBoundary(session);
    this.#setActiveUser(session.userId);
    if (!this.#isCurrent(generation)) {
      throw new Error('Offline session changed before the command could be persisted');
    }
    return session;
  }

  #assertEnqueueScope(session: OfflineSyncSession, scopeId: string): void {
    if (!session.scopes.some((candidate) => candidate.userId === session.userId && candidate.scopeId === scopeId)) {
      throw new Error(`Offline sync session does not include scope "${scopeId}".`);
    }
    this.noteScope({ userId: session.userId, scopeId });
  }

  async #materializeEnqueue<T>(
    userId: OfflinePrincipalId,
    request: EnqueueOfflineCommand<T>,
    replicaTransaction?: Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>,
    replaced?: OfflineCommand,
    createdAt?: number,
  ): Promise<MaterializedOfflineEnqueue> {
    const scope = { userId, scopeId: request.scopeId };
    this.noteScope(scope);
    const commandIdentity = offlineCommandLookupIdentity(request.identity);
    const normalized = await this.#normalizeEnqueueRequest(scope, request, commandIdentity);
    const optimisticValue = request.optimisticValue;
    const commandId = crypto.randomUUID();
    const sourceKey = this.#hooks.entityType(request);
    let command: OfflineCommand = {
      ...scope,
      commandId,
      aggregateType: request.aggregateType,
      sourceKey,
      identity: commandIdentity,
      operation: request.operation,
      payload: normalized.payload,
      optimisticValue,
      replicaMutation: request.replicaMutation ?? 'upsert',
      payloadHash: await this.#payloadHash(normalized.payload),
      baseRevision: normalized.baseRevision,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: replaced?.createdAt ?? createdAt ?? (await this.#nextCommandCreatedAt(userId)),
      lastErrorCode: null,
    };
    if (
      replaced &&
      (replaced.userId !== command.userId ||
        replaced.scopeId !== command.scopeId ||
        replaced.aggregateType !== command.aggregateType ||
        replaced.sourceKey !== command.sourceKey ||
        canonicalOfflineCommandIdentity(replaced.identity) !== canonicalOfflineCommandIdentity(command.identity))
    ) {
      throw new Error('Offline replacement command must address the same aggregate and replica identity.');
    }
    const entityType = command.sourceKey;
    const schema = this.#entitySchema(entityType);
    if (schema.identity.kind === 'localOnly') {
      throw new Error(`Offline replica source "${entityType}" is local-only and cannot be added to the Outbox.`);
    }
    if (schema.identity.kind === 'generated' && request.identity.kind !== 'generated') {
      throw new Error(`Offline replica source "${entityType}" requires generated identity.`);
    }
    if (schema.identity.kind === 'naturalKey' && request.identity.kind !== 'natural') {
      throw new Error(`Offline replica source "${entityType}" requires natural identity.`);
    }
    if (request.replicaMutation === 'delete' && !this.#repository.getReplicaRowIncludingPendingDelete) {
      throw new Error('Offline repository does not support durable replica delete tombstones.');
    }
    const existing = await this.#getReplicaRowForSync(scope, entityType, commandIdentity);
    const generatedIdentity = request.identity.kind === 'generated' ? request.identity : null;
    const initialRemoteId = this.#initialRemoteId(
      schema,
      existing?.identity.kind === 'generated' ? existing.identity.remoteId : null,
      generatedIdentity?.remoteId,
    );
    this.#assertRemoteIdHint(
      schema,
      existing?.identity.kind === 'generated' ? existing.identity.remoteId : null,
      generatedIdentity?.remoteIdHint,
    );
    const naturalKey = offlineNaturalKeyFromValues(schema, optimisticValue);
    if (
      schema.identity.kind === 'naturalKey' &&
      canonicalOfflineRemoteIdentity(schema, { naturalKey: request.identity.kind === 'natural' ? request.identity.naturalKey : {} }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: naturalKey! })
    ) {
      throw new Error(`Offline command naturalKey must match optimistic values for "${entityType}".`);
    }
    const remoteIdentity =
      schema.identity.kind === 'generated'
        ? initialRemoteId === null
          ? null
          : { remoteId: initialRemoteId }
        : schema.identity.kind === 'naturalKey'
          ? { naturalKey: naturalKey! }
          : null;
    if (schema.identity.kind === 'naturalKey') {
      const canonicalValuesKey = canonicalOfflineRemoteIdentity(schema, remoteIdentity!);
      if (
        existing &&
        canonicalOfflineRemoteIdentity(schema, {
          naturalKey:
            existing.identity.kind === 'natural' ? existing.identity.naturalKey : offlineNaturalKeyFromValues(schema, existing.values)!,
        }) !== canonicalValuesKey
      ) {
        throw new Error(`Offline replica naturalKey is immutable and must match optimistic values for "${entityType}".`);
      }
    }
    if (remoteIdentity !== null) {
      const mapped = await this.#repository.getReplicaRowByRemoteIdentity(scope, entityType, remoteIdentity);
      if (mapped !== null && !commandIdentityMatchesReplicaRow(schema, mapped, commandIdentity)) {
        if ('remoteId' in remoteIdentity) {
          throw new Error(`Offline replica remote id ${String(remoteIdentity.remoteId)} is already mapped to another row.`);
        }
        throw new Error(`Offline replica remote identity is already mapped to another row.`);
      }
    }
    const rowIdentity: import('./offline-identity').OfflineReplicaIdentity =
      schema.identity.kind === 'naturalKey'
        ? offlineNaturalReplicaIdentity(schema, optimisticValue)
        : offlineGeneratedReplicaIdentity(generatedIdentity!.localId, initialRemoteId);
    const optimisticRow: OfflineReplicaRow = {
      ...scope,
      sourceKey: entityType,
      identity: rowIdentity,
      values: optimisticValue,
      confirmedValues: existing?.confirmedValues ?? existing?.values ?? null,
      serverRevision: existing?.serverRevision ?? normalized.baseRevision,
      fetchedAt: Date.now(),
      syncState: 'pending',
      visibility: request.replicaMutation === 'delete' ? 'pending_delete' : 'present',
    };
    const preparedCompanions = await this.#prepareOptimisticCompanions(scope, optimisticRow, replicaTransaction);
    const optimisticCompanions = replaced ? this.#replacementCompanions(replaced, preparedCompanions) : preparedCompanions;
    if (replicaTransaction) this.#canonicalJson(replicaTransaction);
    if (optimisticCompanions.length > 0) command = { ...command, optimisticCompanions };
    return { command, optimisticRow, optimisticCompanions };
  }

  #assertDistinctBatchFootprints(
    entries: readonly MaterializedOfflineEnqueue[],
    existingCommands: readonly OfflineCommand[],
    allowOneAggregate = false,
  ): void {
    const aggregates = new Set<string>();
    const replicaKeys = new Set<string>();
    const existingFootprints = new Map<string, string>();
    for (const command of existingCommands) {
      const aggregate = this.#aggregateKey(command);
      for (const key of this.#commandFootprintKeys(command)) existingFootprints.set(key, aggregate);
    }
    for (const entry of entries) {
      const aggregate = this.#aggregateKey(entry.command);
      if (aggregates.has(aggregate) && !allowOneAggregate) {
        throw new Error('Prepared offline batch contains overlapping aggregate intents.');
      }
      aggregates.add(aggregate);
      for (const key of [
        this.#replicaRowKey(entry.optimisticRow),
        ...entry.optimisticCompanions.map((companion) => this.#replicaRowKey(companion.key)),
      ]) {
        if (replicaKeys.has(key) && !allowOneAggregate) {
          throw new Error('Prepared offline batch contains overlapping replica footprints.');
        }
        const existingAggregate = existingFootprints.get(key);
        if (existingAggregate !== undefined && existingAggregate !== aggregate) {
          throw new Error('Offline commands for different aggregates cannot share a replica footprint.');
        }
        replicaKeys.add(key);
      }
    }
  }

  #commandFootprintKeys(command: OfflineCommand): readonly string[] {
    const identity =
      command.identity.kind === 'generated'
        ? offlineGeneratedReplicaIdentity(command.identity.localId, null)
        : ({ kind: 'natural', naturalKey: command.identity.naturalKey } as const);
    return [
      this.#replicaRowKey({ ...command, identity }),
      ...(command.optimisticCompanions ?? []).map((companion) => this.#replicaRowKey(companion.key)),
    ];
  }

  async #commitMaterializedEnqueues(
    entries: readonly MaterializedOfflineEnqueue[],
    generation: number,
    options: { flush?: boolean },
    removeCommandIds?: readonly string[],
  ): Promise<void> {
    if (generation !== this.#generation) {
      throw new Error('Offline session changed before the command could be persisted');
    }
    await this.#repository.transactReplica({
      putRows: entries.flatMap((entry) => [
        entry.optimisticRow,
        ...entry.optimisticCompanions.flatMap((companion) => (companion.after ? [companion.after] : [])),
      ]),
      removeRows: entries.flatMap((entry) => entry.optimisticCompanions.flatMap((companion) => (companion.after ? [] : [companion.key]))),
      putCommands: entries.map((entry) => entry.command),
      removeCommandIds,
    });
    await this.#refreshState().catch((error) => this.#reportError(error));
    if (options.flush !== false && this.#network.connected()) this.#flushInBackground();
  }

  async #prepareOptimisticCompanions(
    scope: OfflineScope,
    optimisticRow: OfflineReplicaRow,
    transaction?: Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>,
  ): Promise<OfflineOptimisticReplicaCompanion[]> {
    if (!transaction) return [];
    const runtimeTransaction = transaction as OfflineReplicaTransaction;
    const unsupported = Object.keys(runtimeTransaction).filter((key) => key !== 'putRows' && key !== 'removeRows');
    if (unsupported.length > 0) {
      throw new Error(`Prepared offline enqueue cannot mutate ${unsupported.join(', ')}.`);
    }
    const putRows = transaction.putRows ?? [];
    const removeRows = transaction.removeRows ?? [];
    const baseKey = this.#replicaRowKey(optimisticRow);
    const seen = new Set<string>([baseKey]);
    const mutations: { key: OfflineReplicaRowKey; after: OfflineReplicaRow | null }[] = [];
    for (const row of putRows) {
      this.#assertCompanionScope(scope, row);
      const key = this.#replicaRowKey(row);
      if (seen.has(key)) throw new Error(`Prepared offline enqueue contains duplicate replica row ${key}.`);
      seen.add(key);
      mutations.push({ key: this.#minimalReplicaRowKey(row), after: row });
    }
    for (const row of removeRows) {
      this.#assertCompanionScope(scope, row);
      const key = this.#replicaRowKey(row);
      if (seen.has(key)) throw new Error(`Prepared offline enqueue contains duplicate replica row ${key}.`);
      seen.add(key);
      mutations.push({ key: this.#minimalReplicaRowKey(row), after: null });
    }
    return Promise.all(
      mutations.map(async ({ key, after }) => {
        const before =
          (await this.#repository.getReplicaRowIncludingPendingDelete?.(scope, key.sourceKey, key.identity)) ??
          (await this.#repository.getReplicaRow(scope, key.sourceKey, key.identity));
        return { key, before, after: this.#optimisticCompanionAfter(after, before) };
      }),
    );
  }

  #assertCompanionScope(scope: OfflineScope, key: OfflineReplicaRowKey): void {
    if (key.userId !== scope.userId || key.scopeId !== scope.scopeId) {
      throw new Error('Prepared offline enqueue companion rows must use the command scope.');
    }
  }

  #replacementCompanions(
    replaced: OfflineCommand,
    optimisticCompanions: readonly OfflineOptimisticReplicaCompanion[],
  ): OfflineOptimisticReplicaCompanion[] {
    const previousByKey = new Map(
      (replaced.optimisticCompanions ?? []).map((companion) => [this.#replicaRowKey(companion.key), companion]),
    );
    const previousKeys = new Set(previousByKey.keys());
    const replacementKeys = new Set(optimisticCompanions.map((companion) => this.#replicaRowKey(companion.key)));
    if (previousKeys.size !== replacementKeys.size || [...previousKeys].some((key) => !replacementKeys.has(key))) {
      throw new Error('Offline replacement must preserve the optimistic companion footprint.');
    }
    return optimisticCompanions.map((companion) => {
      const previousBefore = previousByKey.get(this.#replicaRowKey(companion.key))!.before;
      const before = this.#replacementCompanionBefore(companion.before, previousBefore);
      return { ...companion, before, after: this.#optimisticCompanionAfter(companion.after, before) };
    });
  }

  #replacementCompanionBefore(current: OfflineReplicaRow | null, historical: OfflineReplicaRow | null): OfflineReplicaRow | null {
    const confirmedValues = current ? current.confirmedValues : (historical?.confirmedValues ?? null);
    if (confirmedValues === null) return null;
    const source = current ?? historical!;
    return {
      ...source,
      values: confirmedValues,
      confirmedValues,
      syncState: 'confirmed',
      visibility: 'present',
    };
  }

  #optimisticCompanionAfter(after: OfflineReplicaRow | null, before: OfflineReplicaRow | null): OfflineReplicaRow | null {
    if (!after) return null;
    return { ...after, confirmedValues: before?.confirmedValues ?? null };
  }

  #minimalReplicaRowKey(key: OfflineReplicaRowKey): OfflineReplicaRowKey {
    return {
      userId: key.userId,
      scopeId: key.scopeId,
      sourceKey: key.sourceKey,
      identity: key.identity,
    };
  }

  #replicaRowKey(key: OfflineReplicaRowKey): string {
    return canonicalOfflineReplicaRowKey(this.#entitySchema(key.sourceKey), key);
  }

  async #assertOutboxCapacity(
    userId: OfflinePrincipalId,
    newCommands: readonly OfflineCommand[],
    excludingCommandIds?: readonly string[],
    knownCommands?: readonly OfflineCommand[],
  ): Promise<void> {
    const currentCommands = knownCommands ?? (await this.#commandsForUser(userId));
    const commands = excludingCommandIds
      ? currentCommands.filter((candidate) => !excludingCommandIds.includes(candidate.commandId))
      : currentCommands;
    const maxCommands = this.#options.outboxLimits?.maxCommandsPerUser ?? DEFAULT_MAX_OUTBOX_COMMANDS_PER_USER;
    const maxBytes = this.#options.outboxLimits?.maxBytesPerUser ?? DEFAULT_MAX_OUTBOX_BYTES_PER_USER;
    const currentBytes = this.#serializedOutboxBytes(commands);
    if (commands.length + newCommands.length > maxCommands) {
      throw new OfflineOutboxCapacityError('command_count', commands.length, currentBytes);
    }
    const nextBytes = this.#serializedOutboxBytes([...commands, ...newCommands]);
    if (nextBytes > maxBytes) {
      throw new OfflineOutboxCapacityError('serialized_bytes', commands.length, currentBytes);
    }
  }

  async #commandsForUser(userId: OfflinePrincipalId): Promise<OfflineCommand[]> {
    return this.#repository.getCommandsForUser
      ? this.#repository.getCommandsForUser(userId)
      : (
          await Promise.all(
            [...this.#knownScopes.values()].filter((scope) => scope.userId === userId).map((scope) => this.#repository.getCommands(scope)),
          )
        ).flat();
  }

  #serializedOutboxBytes(commands: readonly OfflineCommand[]): number {
    return new TextEncoder().encode(JSON.stringify(commands)).byteLength;
  }

  async discard(commandId: string, options: { flush?: boolean } = {}): Promise<void> {
    await this.initialize();
    // A pull may have completed while transport was being cancelled. Re-read
    // and project the discard inside the same local mutation lane used by
    // enqueue, ACK, and pull application so an old before-image cannot replace
    // a newer authoritative row after its cursor has advanced.
    const command = await this.#replicaMutations.run(async () => {
      const current = (await this.#readKnownCommands()).find((item) => item.commandId === commandId);
      if (!current) return null;
      this.#assertDiscardable([current]);
      this.#invalidateFlush();
      await this.#discardCommands([current]);
      return current;
    });
    if (!command) return;
    await this.#restoreInterruptedCommands();
    await this.#refreshState();
    await this.#hooks.onCommandRemoved?.(command).catch((error) => this.#reportError(error));
    if (options.flush !== false && this.#network.connected()) this.#flushInBackground();
  }

  /** Clears a retry backoff/auth block selected explicitly by the user and sends the durable command now. */
  async retryNow(commandId: string): Promise<void> {
    await this.initialize();
    this.#invalidateFlush();
    await this.#waitForSendingTransitions();
    await this.#restoreInterruptedCommands();
    const retried = await this.runSerializedReplicaMutation(async (repository) => {
      // Re-read only after every interrupted transport transition has settled.
      // An ACK may have removed the command while retryNow was waiting; never
      // resurrect such a command from an object captured before invalidation.
      const current = (await this.#readKnownCommands()).find((item) => item.commandId === commandId);
      if (!current) return false;
      if (current.state !== 'retry_wait' && current.state !== 'blocked_auth' && current.serverCommitUnknown !== true) {
        throw new Error(`Offline command ${commandId} is not waiting for retry or reauthentication.`);
      }
      await repository.putCommand({
        ...current,
        state: 'pending',
        retryAt: null,
        lastErrorCode: null,
      });
      return true;
    });
    if (retried && this.#network.connected()) await this.flush();
  }

  async discardAllPending(): Promise<void> {
    await this.initialize();
    const commands = await this.#replicaMutations.run(async () => {
      const current = await this.#readKnownCommands();
      this.#assertDiscardable(current);
      this.#invalidateFlush();
      await this.#discardCommands(current);
      return current;
    });
    await this.#refreshState();
    await Promise.all(commands.map((command) => this.#hooks.onCommandRemoved?.(command).catch((error) => this.#reportError(error))));
  }

  #assertDiscardable(commands: readonly OfflineCommand[]): void {
    const ambiguous = commands.filter((command) => command.state === 'sending' || command.serverCommitUnknown === true);
    if (ambiguous.length > 0) {
      throw new OfflineCommandInFlightError(ambiguous.map((command) => command.commandId));
    }
  }

  #flushInBackground(): void {
    void this.#beginFlush(false).catch((error) => this.#errorHandler.handleError(error));
  }

  flush(): Promise<void> {
    return this.#beginFlush(true);
  }

  #beginFlush(explicitFull: boolean): Promise<void> {
    const isPartial = !explicitFull && !this.#coldReconciliationRequired && this.#foregroundScopePolicy !== null;
    if (this.#flushPromise) {
      if (explicitFull && this.#partialFlushInFlight) {
        if (!this.#chainedFullFlush) {
          const generation = this.#generation;
          const partial = this.#flushPromise;
          const chain = partial
            .then(
              () => undefined,
              () => undefined,
            )
            .then(() => {
              if (!this.#isCurrent(generation)) return;
              return this.#beginFlush(true);
            })
            .finally(() => {
              if (this.#chainedFullFlush === chain) this.#chainedFullFlush = null;
            });
          this.#chainedFullFlush = chain;
        }
        return this.#chainedFullFlush;
      }
      return this.#flushPromise;
    }
    const generation = this.#generation;
    const promise = this.#runFlush(generation, explicitFull).finally(() => {
      this.#flushTransitions.delete(promise);
      if (this.#flushPromise === promise) {
        this.#flushPromise = null;
        this.#partialFlushInFlight = false;
      }
    });
    this.#flushPromise = promise;
    this.#partialFlushInFlight = isPartial;
    this.#flushTransitions.add(promise);
    return promise;
  }

  async #runFlush(generation: number, explicitFull: boolean): Promise<void> {
    if (!this.#isCurrent(generation)) return;
    if (!this.#network.connected()) {
      await this.#refreshState(generation);
      return;
    }
    if (!(await this.#discoverScopes(generation))) return;
    const isPartial = !explicitFull && this.#foregroundScopePolicy !== null;
    const pullScopes = isPartial
      ? this.#scopesForPartialPull(this.#foregroundScopePolicy!, await this.#readKnownCommands())
      : [...this.#knownScopes.values()];
    const prePullFailures: unknown[] = [];
    let fatalPullFailure: unknown | null = null;
    const pulledScopeKeys = new Set<string>();
    for (const scope of pullScopes) {
      if (!this.#isCurrent(generation) || !this.#network.connected()) return;
      try {
        await this.#pull.pull(scope);
        await this.#markScopeReconciled(scope, generation);
        pulledScopeKeys.add(this.#scopeKey(scope));
      } catch (error) {
        prePullFailures.push(error);
        if (this.#isFatalPullFailure(error)) {
          // Auth/upgrade-driven recovery only: stop remaining scopes immediately.
          fatalPullFailure = fatalPullFailure ?? error;
          break;
        }
        if (this.#pendingPullScopes.has(this.#scopeKey(scope))) {
          this.#scheduleRetry(Date.now() + POST_SEND_PULL_RETRY_MS);
        }
      }
    }
    const dirtyScopes = new Map<string, OfflineScope>();
    const sendWorkerFailures: unknown[] = [];
    while (this.#network.connected() && this.#isCurrent(generation) && fatalPullFailure === null) {
      const groups = this.#eligibleAggregateGroups(await this.#readKnownCommands()).filter((group) => {
        const head = group[0];
        return head !== undefined && pulledScopeKeys.has(this.#scopeKey(head));
      });
      if (!this.#isCurrent(generation)) return;
      if (groups.length === 0) break;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_AGGREGATES, groups.length) }, async () => {
        while (cursor < groups.length) {
          const group = groups[cursor++];
          if (group && this.#isCurrent(generation)) await this.#sendAggregate(group, generation, dirtyScopes, pulledScopeKeys);
        }
      });
      // Drain with allSettled so one rejecting worker cannot skip sibling settlement or post-send pull.
      const settled = await Promise.allSettled(workers);
      for (const result of settled) {
        if (result.status === 'rejected') sendWorkerFailures.push(result.reason);
      }
      if (sendWorkerFailures.length > 0) break;
    }
    for (const scope of dirtyScopes.values()) {
      this.#pendingPullScopes.set(this.#scopeKey(scope), scope);
    }
    const postPullFailures: unknown[] = [];
    // Fatal pre-pull skips pending post-pulls; recovery is auth/upgrade-driven, not timer retry.
    // Fatal post-send pull stops remaining pending scopes the same way (ACK preserved, no resend).
    if (fatalPullFailure === null) {
      for (const scope of this.#pendingPullScopes.values()) {
        if (!this.#isCurrent(generation) || !this.#network.connected()) break;
        try {
          // A command response may contain only the aggregate's base row. Pull
          // once per dirty scope so sibling-table journal entries are visible
          // before the completed Outbox state is exposed to product UI.
          await this.#pull.pull(scope);
          await this.#markScopeReconciled(scope, generation);
        } catch (error) {
          if (this.#isFatalPullFailure(error)) {
            fatalPullFailure = fatalPullFailure ?? error;
            break;
          }
          postPullFailures.push(error);
        }
      }
    }
    await this.#refreshState(generation);
    if (fatalPullFailure !== null) {
      // Auth/upgrade recovery only — never arm the 1s automatic flush retry.
      // Post-send ACK already removed the command; reconciliation markers remain for later recovery.
      // Only the owning generation may clear the timer — a stale fatal must not disarm a
      // newer session's already-armed retry_wait / post-pull retry.
      if (this.#isCurrent(generation)) this.#scheduleRetry(null);
      throw fatalPullFailure;
    }
    const failures = [...prePullFailures, ...sendWorkerFailures, ...postPullFailures];
    if (failures.length > 0) {
      // Keep rejecting the flush promise after workers settle even when the session
      // was revoked mid-flight, so callers and ErrorHandler still observe the failure.
      if (this.#isCurrent(generation)) {
        this.#scheduleRetry(Date.now() + POST_SEND_PULL_RETRY_MS);
      }
      throw failures[0];
    }
    if (this.#isCurrent(generation)) this.#coldReconciliationRequired = false;
  }

  #isFatalPullFailure(error: unknown): boolean {
    const status = this.#errorStatus(error);
    // Pull-protocol HTTP 409 is schema mismatch (distinct from command-send conflict
    // classification elsewhere in this service). Same classifier for pre-pull and post-send pull.
    if (status === 401 || status === 403 || status === 409) return true;
    return error instanceof OfflineReplicaSchemaMismatchError;
  }

  #setForegroundScopePolicy(foregroundScopeIds?: readonly string[]): void {
    this.#foregroundScopePolicy = foregroundScopeIds !== undefined ? foregroundScopeIds : null;
  }

  #scopesForPartialPull(foregroundScopeIds: readonly string[], commands: readonly OfflineCommand[]): OfflineScope[] {
    const foregroundScopeSet = new Set(foregroundScopeIds);
    const outboxScopeKeys = new Set(commands.map((command) => this.#scopeKey({ userId: command.userId, scopeId: command.scopeId })));
    return [...this.#knownScopes.values()].filter(
      (scope) =>
        foregroundScopeSet.has(scope.scopeId) ||
        outboxScopeKeys.has(this.#scopeKey(scope)) ||
        this.#pendingPullScopes.has(this.#scopeKey(scope)),
    );
  }

  #eligibleAggregateGroups(commands: OfflineCommand[]): OfflineCommand[][] {
    const now = Date.now();
    const groups = new Map<string, OfflineCommand[]>();
    for (const command of commands) {
      const key = this.#aggregateKey(command);
      const group = groups.get(key) ?? [];
      group.push(command);
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => {
      const head = group[0];
      return head?.state === 'pending' || (head?.state === 'retry_wait' && (head.retryAt ?? 0) <= now);
    });
  }

  async #sendAggregate(
    commands: OfflineCommand[],
    generation: number,
    dirtyScopes: Map<string, OfflineScope>,
    pulledScopeKeys: ReadonlySet<string>,
  ): Promise<void> {
    for (const command of commands) {
      if (!this.#isCurrent(generation)) return;
      if (command.state === 'retry_wait' && (command.retryAt ?? 0) > Date.now()) break;
      if (!['pending', 'retry_wait'].includes(command.state)) break;
      // User-scoped aggregates ignore scopeId in the FIFO key, so later commands may
      // belong to scopes that failed pre-pull even when the head was admitted.
      if (!pulledScopeKeys.has(this.#scopeKey({ userId: command.userId, scopeId: command.scopeId }))) break;
      let sending = await this.#claimSendingCommand(command, generation);
      if (!sending) return;
      if (!this.#isCurrent(generation)) return;
      await this.#refreshState(generation);
      if (!this.#isCurrent(generation)) return;
      let row: OfflineReplicaRow | null;
      try {
        row = await this.#rowForCommand(sending);
      } catch (error) {
        if (!this.#isCurrent(generation)) return;
        await this.#persistFailedCommand(sending, error, generation, null, sending.serverCommitUnknown === true);
        throw error;
      }
      if (!row) {
        const error = new Error(
          `Offline replica row not found: ${sending.aggregateType}/${canonicalOfflineCommandIdentity(sending.identity)}`,
        );
        await this.#persistFailedCommand(sending, error, generation, null, sending.serverCommitUnknown === true);
        throw error;
      }
      const priorCommitUnknown = sending.serverCommitUnknown === true;
      const transportCommand = await this.#markTransportStarted(sending, generation);
      if (!transportCommand) return;
      sending = transportCommand;
      let result: OfflineCommandResult;
      try {
        result = await this.#executor.execute(sending, offlineCommandTargetFromReplicaRow(row));
      } catch (error) {
        if (!this.#isCurrent(generation)) return;
        const commitUnknown = this.#executor.provesCommandNotCommitted?.(error, sending)
          ? false
          : priorCommitUnknown || this.#serverCommitCouldBeUnknown(error);
        await this.#persistFailedCommand(sending, error, generation, row, commitUnknown);
        if (!this.#isClassifiableTransportError(error)) throw error;
        break;
      }
      if (!this.#isCurrent(generation)) return;
      try {
        await this.#completeCommand(commands, sending, result, generation);
      } catch (error) {
        if (!this.#isCurrent(generation)) return;
        await this.#persistFailedCommand(sending, error, generation, row, true);
        throw error;
      }
      if (this.#isCurrent(generation)) {
        await this.#hooks.onCommandRemoved?.(sending).catch((error) => this.#reportError(error));
        const scope = { userId: sending.userId, scopeId: sending.scopeId };
        dirtyScopes.set(this.#scopeKey(scope), scope);
      }
    }
  }

  async #normalizeEnqueueRequest<T>(
    scope: OfflineScope,
    request: EnqueueOfflineCommand<T>,
    commandIdentity: OfflineCommandIdentity,
  ): Promise<{ payload: T; baseRevision: string | number | null }> {
    let baseRevision = request.baseRevision ?? null;
    let payload = request.payload;
    const sourceKey = this.#hooks.entityType(request);
    const row = await this.#getReplicaRowForSync(scope, sourceKey, commandIdentity);
    if (row?.serverRevision != null && row.serverRevision !== baseRevision) {
      const rebased = this.#executor.withServerRevision(
        { ...scope, ...request, sourceKey, identity: commandIdentity, payload, baseRevision } as OfflineCommand,
        row.serverRevision,
      );
      baseRevision = row.serverRevision;
      payload = rebased.payload as T;
    }
    return { payload, baseRevision };
  }

  async #completeCommand(
    commands: OfflineCommand[],
    command: OfflineCommand,
    result: OfflineCommandResult,
    generation: number,
  ): Promise<void> {
    return this.#serializeReplicaMutation(() => this.#completeCommandLocked(commands, command, result, generation));
  }

  async #completeCommandLocked(
    commands: OfflineCommand[],
    command: OfflineCommand,
    result: OfflineCommandResult,
    generation: number,
  ): Promise<void> {
    if (result.clearRemoteId === true && result.remoteId !== undefined) {
      throw new Error('Offline command cannot return remoteId and clearRemoteId together.');
    }
    if (result.clearRemoteId === true && result.serverRevision !== undefined) {
      throw new Error('Offline command cannot return serverRevision and clearRemoteId together.');
    }
    // An enqueue may have completed while transport was in flight. Re-read the
    // aggregate immediately before the atomic acknowledgement transaction so a
    // delete ACK cannot remove a row that has already been re-added locally.
    const latestCommands = (await this.#readKnownCommands()).filter(
      (candidate) => this.#aggregateKey(candidate) === this.#aggregateKey(command),
    );
    const latestIndex = latestCommands.findIndex((candidate) => candidate.commandId === command.commandId);
    if (latestIndex < 0) return;
    const revision = result.serverRevision;
    const following = latestCommands.slice(latestIndex + 1);
    const rebased =
      result.clearRemoteId === true
        ? following.map((item) => {
            if (!this.#executor.withoutServerRevision) {
              throw new Error('Offline command executor must implement withoutServerRevision to recreate a deleted remoteId row.');
            }
            return this.#executor.withoutServerRevision(item);
          })
        : revision === undefined
          ? following
          : following.map((item) => this.#executor.withServerRevision(item, revision));
    latestCommands.splice(latestIndex + 1, rebased.length, ...rebased);
    const current = await this.#rowForCommand(command);
    if (!this.#isCurrent(generation)) return;
    if (!current) {
      throw new Error(`Offline replica row disappeared while completing command ${command.commandId}.`);
    }
    this.#assertServerRevision(result.serverRevision);
    const removesReplica = result.removeReplica === true || command.replicaMutation === 'delete';
    if (result.clearRemoteId === true && !removesReplica) {
      throw new Error('Offline command can clear remoteId only for a confirmed replica removal.');
    }
    const confirmedValues = removesReplica ? null : (result.confirmedValues ?? command.optimisticValue);
    const schema = this.#entitySchema(current.sourceKey);
    this.#assertCommandResultIdentity(schema, current, result);
    const resolvedRemoteId = this.#resolvedRemoteId(current, result);
    const row = {
      ...current,
      values: rebased.length > 0 ? current.values : confirmedValues,
      confirmedValues,
      identity:
        current.identity.kind === 'generated'
          ? {
              ...current.identity,
              remoteId: result.clearRemoteId === true ? null : resolvedRemoteId,
            }
          : current.identity,
      serverRevision: result.clearRemoteId === true ? null : (revision ?? current.serverRevision),
      fetchedAt: Date.now(),
      syncState: rebased.length > 0 ? ('pending' as const) : ('confirmed' as const),
      visibility: rebased.at(-1)?.replicaMutation === 'delete' ? ('pending_delete' as const) : ('present' as const),
    };
    const companionTransaction = this.#companionTransactionAfterAcknowledgement(rebased);
    if (!this.#isCurrent(generation)) return;
    await this.#repository.transactReplica({
      putRows: [...(removesReplica && rebased.length === 0 ? [] : [row]), ...(companionTransaction.putRows ?? [])],
      releaseRemoteIds:
        result.clearRemoteId === true &&
        current.identity.kind === 'generated' &&
        current.identity.remoteId !== null &&
        !(removesReplica && rebased.length === 0)
          ? [
              {
                userId: current.userId,
                scopeId: current.scopeId,
                sourceKey: current.sourceKey,
                identity: current.identity,
                remoteId: current.identity.remoteId,
              },
            ]
          : undefined,
      removeRows: [...(removesReplica && rebased.length === 0 ? [current] : []), ...(companionTransaction.removeRows ?? [])],
      putCommands: rebased,
      removeCommandIds: [command.commandId],
      putReconciliationScopes: [{ userId: command.userId, scopeId: command.scopeId }],
    });
    const scope = { userId: command.userId, scopeId: command.scopeId };
    this.#pendingPullScopes.set(this.#scopeKey(scope), scope);
    commands.splice(0, commands.length, ...latestCommands);
  }

  async #rowForCommand(command: OfflineCommand): Promise<OfflineReplicaRow | null> {
    const scope = { userId: command.userId, scopeId: command.scopeId };
    const entityType = this.#entityType(command);
    return this.#getReplicaRowForSync(scope, entityType, command.identity);
  }

  #getReplicaRowForSync(scope: OfflineScope, sourceKey: string, identity: OfflineCommandIdentity): Promise<OfflineReplicaRow | null> {
    return (
      this.#repository.getReplicaRowIncludingPendingDelete?.(scope, sourceKey, identity) ??
      this.#repository.getReplicaRow(scope, sourceKey, identity)
    );
  }

  #replicaState(state: OfflineCommand['state']): OfflineReplicaSyncState {
    if (state === 'blocked_auth' || state === 'rejected' || state === 'conflict') return state;
    return 'pending';
  }

  #entityType(command: Pick<OfflineCommand, 'sourceKey'>): string {
    return command.sourceKey;
  }

  #entitySchema(sourceKey: string): OfflineReplicaEntitySchema<Record<string, unknown>> {
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    return schema;
  }

  async #discardCommands(discarded: readonly OfflineCommand[]): Promise<void> {
    const all = await this.#readKnownCommands();
    const discardedIds = new Set(discarded.map((command) => command.commandId));
    const affected = new Map<string, OfflineCommand>();
    for (const command of discarded) affected.set(this.#aggregateKey(command), command);
    const putRows: OfflineReplicaRow[] = [];
    const removeRows: OfflineReplicaRowKey[] = [];
    const companionRows = new Map<string, OfflineReplicaRow>();
    const companionRemovals = new Map<string, OfflineReplicaRowKey>();
    for (const [key, command] of affected) {
      const row = await this.#rowForCommand(command);
      const remaining = all.filter((item) => !discardedIds.has(item.commandId) && this.#aggregateKey(item) === key);
      if (row) {
        if (remaining.length === 0 && row.confirmedValues === null) {
          removeRows.push(row);
        } else {
          putRows.push({
            ...row,
            values: remaining.length > 0 ? remaining.at(-1)!.optimisticValue : row.confirmedValues,
            syncState: remaining.length > 0 ? 'pending' : 'confirmed',
            visibility: remaining.at(-1)?.replicaMutation === 'delete' ? 'pending_delete' : 'present',
          });
        }
      }
      const aggregateCommands = all.filter((item) => this.#aggregateKey(item) === key);
      const remainingAggregateCommands = aggregateCommands.filter((item) => !discardedIds.has(item.commandId));
      for (const companion of this.#companionsAfterDiscard(aggregateCommands, remainingAggregateCommands)) {
        const companionKey = this.#replicaRowKey(companion.key);
        const hasRemaining = remainingAggregateCommands.some((remainingCommand) =>
          (remainingCommand.optimisticCompanions ?? []).some((candidate) => this.#replicaRowKey(candidate.key) === companionKey),
        );
        const current = await this.#getCompanionRow(companion.key);
        const after = hasRemaining
          ? companion.after && current
            ? { ...companion.after, confirmedValues: current.confirmedValues }
            : companion.after
          : current
            ? current.confirmedValues === null
              ? null
              : {
                  ...current,
                  values: current.confirmedValues,
                  syncState: 'confirmed' as const,
                  visibility: 'present' as const,
                }
            : companion.after;
        if (after) {
          companionRows.set(companionKey, after);
          companionRemovals.delete(companionKey);
        } else {
          companionRows.delete(companionKey);
          companionRemovals.set(companionKey, companion.key);
        }
      }
    }
    await this.#repository.transactReplica({
      putRows: [...putRows, ...companionRows.values()],
      removeRows: [...removeRows, ...companionRemovals.values()],
      removeCommandIds: [...discardedIds],
    });
  }

  #getCompanionRow(key: OfflineReplicaRowKey): Promise<OfflineReplicaRow | null> {
    const scope = { userId: key.userId, scopeId: key.scopeId };
    return (
      this.#repository.getReplicaRowIncludingPendingDelete?.(scope, key.sourceKey, key.identity) ??
      this.#repository.getReplicaRow(scope, key.sourceKey, key.identity)
    );
  }

  #companionTransactionAfterAcknowledgement(
    following: readonly OfflineCommand[],
  ): Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'> {
    const latest = new Map<string, OfflineOptimisticReplicaCompanion>();
    for (const command of following) {
      for (const companion of command.optimisticCompanions ?? []) {
        latest.set(this.#replicaRowKey(companion.key), companion);
      }
    }
    return {
      putRows: [...latest.values()].flatMap((companion) => (companion.after ? [companion.after] : [])),
      removeRows: [...latest.values()].flatMap((companion) => (companion.after ? [] : [companion.key])),
    };
  }

  #companionsAfterDiscard(all: readonly OfflineCommand[], remaining: readonly OfflineCommand[]): OfflineOptimisticReplicaCompanion[] {
    const keys = new Map<string, OfflineOptimisticReplicaCompanion>();
    for (const command of all) {
      for (const companion of command.optimisticCompanions ?? []) {
        const key = this.#replicaRowKey(companion.key);
        const previous = keys.get(key);
        keys.set(key, previous ? { ...companion, before: previous.before } : companion);
      }
    }
    for (const command of remaining) {
      for (const companion of command.optimisticCompanions ?? []) {
        const key = this.#replicaRowKey(companion.key);
        const original = keys.get(key);
        keys.set(key, { ...companion, before: original?.before ?? companion.before });
      }
    }
    const remainingKeys = new Set(
      remaining.flatMap((command) => (command.optimisticCompanions ?? []).map((item) => this.#replicaRowKey(item.key))),
    );
    return [...keys.entries()].map(([key, companion]) => (remainingKeys.has(key) ? companion : { ...companion, after: companion.before }));
  }

  #aggregateKey(command: OfflineCommand): string {
    const sourceKey = this.#entityType(command);
    const schema = this.#options.replicaSchema.entities.find((entity) => entity.sourceKey === sourceKey);
    if (!schema) throw new Error(`Unknown offline replica source key "${sourceKey}".`);
    const partition = schema.scope === 'user' ? 'user' : `partition:${command.scopeId}`;
    return `${canonicalOfflinePrincipalId(command.userId)}:${partition}:${sourceKey}:${canonicalOfflineCommandIdentity(command.identity)}`;
  }

  #failedCommand(command: OfflineCommand, error: unknown, serverCommitUnknown: boolean): OfflineCommand {
    const status = this.#errorStatus(error);
    if (status === 401 || status === 403) {
      return { ...command, state: 'blocked_auth', lastErrorCode: String(status), serverCommitUnknown };
    }
    if (status === 409 || status === 412) {
      return { ...command, state: 'conflict', lastErrorCode: String(status), serverCommitUnknown };
    }
    if (status >= 400 && status < 500 && status !== 429) {
      return { ...command, state: 'rejected', lastErrorCode: String(status), serverCommitUnknown };
    }
    const retryAt = Date.now() + offlineRetryDelayMs(command.attempts, this.#retryRandom);
    return {
      ...command,
      state: 'retry_wait',
      retryAt,
      lastErrorCode: status > 0 ? String(status) : 'network',
      serverCommitUnknown,
    };
  }

  async #persistFailedCommand(
    command: OfflineCommand,
    error: unknown,
    generation: number,
    row?: OfflineReplicaRow | null,
    serverCommitUnknown = true,
  ): Promise<void> {
    const failed = this.#failedCommand(command, error, serverCommitUnknown);
    const current = row === undefined ? await this.#rowForCommand(command) : row;
    if (!this.#isCurrent(generation)) return;
    if (current) {
      await this.#repository.transactReplica({
        putRows: [{ ...current, syncState: this.#replicaState(failed.state) }],
        putCommands: [failed],
      });
    } else {
      await this.#repository.putCommand(failed);
    }
    if (!this.#isCurrent(generation)) return;
    if (failed.state === 'retry_wait') this.#scheduleRetry(failed.retryAt);
    await this.#refreshState(generation);
  }

  #errorStatus(error: unknown): number {
    if (typeof error !== 'object' || error === null) return 0;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : 0;
  }

  #isClassifiableTransportError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' && Number.isInteger(status) && status >= 0;
  }

  #serverCommitCouldBeUnknown(error: unknown): boolean {
    const status = this.#errorStatus(error);
    return status === 0 || status === 429 || status >= 500;
  }

  #reportError(error: unknown): void {
    void Promise.resolve()
      .then(() => this.#errorHandler.handleError(error))
      .catch(() => undefined);
  }

  #assertServerRevision(revision: string | number | undefined): void {
    if (typeof revision === 'number' && !Number.isFinite(revision)) {
      throw new Error(`Offline command returned invalid serverRevision ${String(revision)}.`);
    }
  }

  #resolvedRemoteId(current: OfflineReplicaRow, result: OfflineCommandResult): OfflineGeneratedRemoteId | null {
    if (current.identity.kind !== 'generated') return null;
    const incoming = result.remoteId;
    if (incoming === undefined) return current.identity.remoteId;
    const schema = this.#entitySchema(current.sourceKey);
    assertOfflineReplicaGeneratedRemoteId(schema, incoming);
    if (current.identity.remoteId !== null && current.identity.remoteId !== incoming) {
      throw new Error(
        `Offline replica remote id is immutable: current=${String(current.identity.remoteId)}, incoming=${String(incoming)}.`,
      );
    }
    return incoming;
  }

  #initialRemoteId(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    current: OfflineGeneratedRemoteId | null,
    incoming: OfflineGeneratedRemoteId | null | undefined,
  ): OfflineGeneratedRemoteId | null {
    if (incoming === null || incoming === undefined) return current;
    assertOfflineReplicaGeneratedRemoteId(schema, incoming);
    if (current !== null && current !== incoming) {
      throw new Error(`Offline replica remote id is immutable: current=${String(current)}, incoming=${String(incoming)}.`);
    }
    return incoming;
  }

  #assertRemoteIdHint(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    current: OfflineGeneratedRemoteId | null,
    hint: OfflineGeneratedRemoteId | null | undefined,
  ): void {
    if (hint === null || hint === undefined) return;
    assertOfflineReplicaGeneratedRemoteId(schema, hint);
    if (current !== null && current !== hint) {
      throw new Error(`Offline replica remoteId hint does not match current=${String(current)}: incoming=${String(hint)}.`);
    }
  }

  #assertCommandResultIdentity(
    schema: OfflineReplicaEntitySchema<Record<string, unknown>>,
    current: OfflineReplicaRow,
    result: OfflineCommandResult,
  ): void {
    if (result.clearRemoteId === true && schema.identity.kind !== 'generated') {
      throw new Error(`Offline command cannot clear remoteId for source "${schema.sourceKey}".`);
    }
    if (schema.identity.kind === 'naturalKey' && result.remoteId !== undefined) {
      throw new Error(`Offline command returned generated remote id for naturalKey source "${schema.sourceKey}".`);
    }
    if (schema.identity.kind !== 'generated' && result.remoteId !== undefined) {
      throw new Error(`Offline command returned generated remote id for source "${schema.sourceKey}" without generated identity.`);
    }
    if (schema.identity.kind === 'naturalKey') {
      const confirmedValues = result.confirmedValues ?? current.values;
      const currentKey =
        current.identity.kind === 'natural' ? current.identity.naturalKey : offlineNaturalKeyFromValues(schema, current.values)!;
      const confirmedKey = offlineNaturalKeyFromValues(schema, confirmedValues)!;
      if (
        canonicalOfflineRemoteIdentity(schema, { naturalKey: currentKey }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: confirmedKey })
      ) {
        throw new Error(`Offline replica naturalKey is immutable for "${schema.sourceKey}".`);
      }
    }
  }

  async #discoverScopes(generation = this.#generation): Promise<boolean> {
    const session = await this.#context.getSession();
    if (!this.#isCurrent(generation)) return false;
    if (!session) {
      return false;
    }
    this.#assertSessionPrincipalBoundary(session);
    this.#setActiveUser(session.userId);
    this.#knownScopes.clear();
    for (const scope of session.scopes) this.#knownScopes.set(this.#scopeKey(scope), scope);
    await this.#restorePendingPullScopes(session.userId, generation);
    return true;
  }

  async #discoverLocalScopes(generation = this.#generation): Promise<boolean> {
    const session = await this.#getLocalSession();
    if (!this.#isCurrent(generation)) return false;
    if (!session) {
      this.#activeUserId = null;
      this.#knownScopes.clear();
      return true;
    }
    this.#assertSessionPrincipalBoundary(session);
    this.#setActiveUser(session.userId);
    this.#knownScopes.clear();
    for (const scope of session.scopes) this.#knownScopes.set(this.#scopeKey(scope), scope);
    await this.#restorePendingPullScopes(session.userId, generation);
    return true;
  }

  #getLocalSession(): Promise<OfflineSyncSession | null> {
    return this.#context.getLocalSession?.() ?? this.#context.getSession();
  }

  #setActiveUser(userId: OfflinePrincipalId): void {
    if (this.#activeUserId === userId) return;
    this.#knownScopes.clear();
    this.#pendingPullScopes.clear();
    this.#activeUserId = userId;
    this.#lastCommandCreatedAt = 0;
  }

  #assertSessionPrincipalBoundary(session: OfflineSyncSession): void {
    canonicalOfflinePrincipalId(session.userId);
    for (const scope of session.scopes) {
      if (scope.userId !== session.userId) {
        throw new Error('Offline sync session scope belongs to a different principal.');
      }
    }
  }

  async #readKnownCommands(): Promise<OfflineCommand[]> {
    const commands = (await Promise.all([...this.#knownScopes.values()].map((scope) => this.#repository.getCommands(scope))))
      .flat()
      .sort(compareOfflineCommands);
    this.#rememberCreatedAt(commands);
    return commands;
  }

  async #nextCommandCreatedAt(userId: OfflinePrincipalId): Promise<number> {
    const commands = await this.#commandsForUser(userId);
    this.#rememberCreatedAt(commands);
    const createdAt = Math.max(Date.now(), this.#lastCommandCreatedAt + 1);
    this.#lastCommandCreatedAt = createdAt;
    return createdAt;
  }

  #rememberCreatedAt(commands: readonly OfflineCommand[]): void {
    for (const command of commands) this.#lastCommandCreatedAt = Math.max(this.#lastCommandCreatedAt, command.createdAt);
  }

  async #refreshState(generation = this.#generation): Promise<void> {
    const commands = await this.#readKnownCommands();
    if (!this.#isCurrent(generation)) return;
    this.#commands.set(commands);
    const nextRetry = commands
      .filter((command) => command.state === 'retry_wait' && command.retryAt !== null)
      .reduce<number | null>((earliest, command) => Math.min(earliest ?? command.retryAt!, command.retryAt!), null);
    this.#scheduleRetry(nextRetry);
  }

  #scheduleRetry(retryAt: number | null): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (retryAt === null) return;
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        if (this.#network.connected()) this.#flushInBackground();
      },
      Math.max(0, retryAt - Date.now()),
    );
  }

  #invalidateFlush(): void {
    this.#generation += 1;
    this.#flushPromise = null;
    this.#partialFlushInFlight = false;
    this.#chainedFullFlush = null;
    this.#scheduleRetry(null);
  }

  #isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  async #restoreInterruptedCommands(): Promise<void> {
    const commands = await this.#readKnownCommands();
    await Promise.all(
      commands
        .filter((command) => command.state === 'sending')
        .map((command) =>
          this.#repository.putCommand({
            ...command,
            state: 'pending',
            serverCommitUnknown: command.serverCommitUnknown ?? true,
          }),
        ),
    );
  }

  #claimSendingCommand(command: OfflineCommand, generation: number): Promise<OfflineCommand | null> {
    const transition = this.#serializeReplicaMutation(async () => {
      if (!this.#isCurrent(generation)) return null;
      const scope = { userId: command.userId, scopeId: command.scopeId };
      const current = (await this.#repository.getCommands(scope)).find((candidate) => candidate.commandId === command.commandId);
      if (!current || !['pending', 'retry_wait'].includes(current.state)) return null;
      const sending: OfflineCommand = {
        ...current,
        state: 'sending',
        attempts: current.attempts + 1,
        retryAt: null,
        lastErrorCode: null,
      };
      await this.#repository.putCommand(sending);
      return sending;
    });
    this.#sendingTransitions.add(transition);
    void transition.then(
      () => this.#sendingTransitions.delete(transition),
      () => this.#sendingTransitions.delete(transition),
    );
    return transition;
  }

  #markTransportStarted(command: OfflineCommand, generation: number): Promise<OfflineCommand | null> {
    return this.#serializeReplicaMutation(async () => {
      if (!this.#isCurrent(generation)) return null;
      const scope = { userId: command.userId, scopeId: command.scopeId };
      const current = (await this.#repository.getCommands(scope)).find((candidate) => candidate.commandId === command.commandId);
      if (!current || current.state !== 'sending') return null;
      const transportCommand = { ...current, serverCommitUnknown: true };
      await this.#repository.putCommand(transportCommand);
      return transportCommand;
    });
  }

  async #restorePendingPullScopes(userId: OfflinePrincipalId, generation: number): Promise<void> {
    if (!this.#repository.getReconciliationScopes) return;
    const durableScopes = await this.#repository.getReconciliationScopes(userId);
    if (!this.#isCurrent(generation) || this.#activeUserId !== userId) return;
    const currentKeys = new Set(this.#knownScopes.keys());
    this.#pendingPullScopes.clear();
    const revoked: OfflineScope[] = [];
    for (const scope of durableScopes) {
      const key = this.#scopeKey(scope);
      if (scope.userId === userId && currentKeys.has(key)) this.#pendingPullScopes.set(key, scope);
      else revoked.push(scope);
    }
    if (revoked.length > 0) {
      await this.#repository.transactReplica({ removeReconciliationScopes: revoked });
    }
  }

  async #markScopeReconciled(scope: OfflineScope, generation: number): Promise<void> {
    if (!this.#isCurrent(generation)) return;
    await this.#repository.transactReplica({ removeReconciliationScopes: [scope] });
    if (!this.#isCurrent(generation)) return;
    this.#pendingPullScopes.delete(this.#scopeKey(scope));
  }

  async #waitForSendingTransitions(): Promise<void> {
    await Promise.allSettled([...this.#sendingTransitions]);
  }

  async #payloadHash(payload: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.#canonicalJson(payload)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  #canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.#canonicalJson(item)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new OfflinePayloadValidationError();
      }
      return `{${Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.#canonicalJson(item)}`)
        .join(',')}}`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new OfflinePayloadValidationError();
    }
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      throw new OfflinePayloadValidationError();
    }
    return serialized;
  }

  #scopeKey(scope: OfflineScope): string {
    return `${canonicalOfflinePrincipalId(scope.userId)}:${scope.scopeId}`;
  }
}

function compareOfflineCommands(left: OfflineCommand, right: OfflineCommand): number {
  return left.createdAt - right.createdAt || (left.commandId < right.commandId ? -1 : left.commandId > right.commandId ? 1 : 0);
}
