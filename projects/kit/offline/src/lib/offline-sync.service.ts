import { computed, effect, ErrorHandler, inject, Injectable, InjectionToken, signal, untracked } from '@angular/core';
import {
  OFFLINE_COMMAND_EXECUTOR,
  OFFLINE_SYNC_CONTEXT,
  offlineCommandLookupIdentity,
  offlineCommandTargetFromReplicaRow,
  offlineCommandWithBaseRevision,
  type OfflineCommandResult,
  type EnqueueOfflineCommandIdentity,
  type OfflineSyncSession,
} from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineMutationAdmissionService } from './offline-mutation-admission.service';
import { OfflineReplicaPullService, OfflineReplicaSchemaMismatchError } from './offline-replica-pull.service';
import { isOfflineAggregateIntentConflict, offlineAggregateIntentMutations } from './offline-aggregate-intent-projector';
import { commandFootprintKeys, OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import type {
  OfflineCommand,
  OfflinePullAttention,
  OfflinePullAttentionReason,
  OfflineReplicaSyncState,
  OfflineReplicaRow,
  OfflineReplicaRowKey,
  OfflineReplicaTransaction,
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

/** Mutation appended atomically to the outbox; Kit rematerializes optimistic replica state. */
export interface EnqueueOfflineCommand<T = unknown> {
  scopeId: string;
  aggregateType: string;
  identity: EnqueueOfflineCommandIdentity;
  operation: string;
  payload: T;
  /**
   * Optimistically hides an existing DB row while retaining its identity and
   * confirmed baseline for durable replay, conflict handling, and discard.
   */
  replicaMutation?: 'upsert' | 'delete';
  baseRevision?: string | number | null;
  /** Declared localOnly projection rows this intent may create, update, or remove. */
  localOnlyFootprint?: readonly OfflineReplicaRowKey[];
}

/**
 * A command prepared from replica reads while enqueue/ACK projection is
 * serialized. Kit rematerializes the aggregate; the prepare callback must not
 * supply replica row images as independent truth.
 */
export interface PreparedOfflineCommand<T = unknown> {
  request: EnqueueOfflineCommand<T>;
}

export interface PreparedOfflineBatchOptions {
  flush?: boolean;
  /** Product identity/scope lease asserted after all async preparation and immediately before the durable commit. */
  assertCurrent?: () => void;
}

/** Validated Outbox command ready for a rematerialized replica commit. */
interface MaterializedOfflineEnqueue {
  command: OfflineCommand;
  /** Identity-bearing base row used when the aggregate does not yet exist locally. */
  seedBaseRow?: OfflineReplicaRow | null;
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
  readonly #mutationAdmission = inject(OfflineMutationAdmissionService);
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
  readonly #pullAttentions = signal<OfflinePullAttention[]>([]);
  readonly #knownScopes = new Map<string, OfflineScope>();
  /** In-memory scheduling cache for scopes whose authoritative post-send pull has not completed yet. */
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
  #initialization: Promise<void> | null = null;
  #initialized = false;
  #lastCommandCreatedAt = 0;

  readonly pendingCommands = this.#commands.asReadonly();
  readonly pendingCount = computed(() => this.pendingCommands().length);
  readonly conflicts = computed(() => this.#commands().filter((command) => command.state === 'conflict'));
  /** Durable fatal-pull attentions for the active principal, restored across restart. */
  readonly pullAttentions = this.#pullAttentions.asReadonly();
  readonly syncState = computed<OfflineSyncState>(() => {
    if (this.#pullAttentions().length > 0) return 'attention';
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
      // The network transition may be observed after an explicit flush has already
      // persisted a fatal pull attention. Do not let that stale transition restart
      // the intentionally stopped loop; auth/session refresh remains able to retry.
      const hasFatalPullAttention = untracked(() => this.#pullAttentions().length > 0);
      if (this.#initialized && connected && !hasFatalPullAttention) this.#flushInBackground();
    });
  }

  async initialize(options: { flush?: boolean } = {}): Promise<void> {
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    if (options.flush !== false && this.#network.connected()) this.#flushInBackground();
  }

  #ensureInitialized(): Promise<void> {
    this.#initialization ??= this.#initializeOnce();
    return this.#initialization;
  }

  async #restoreCurrentGeneration(generation: number): Promise<boolean> {
    await this.#ensureInitialized();
    return this.#isCurrent(generation);
  }

  async #initializeOnce(): Promise<void> {
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
  }

  noteScope(scope: OfflineScope): void {
    this.#knownScopes.set(this.#scopeKey(scope), scope);
  }

  async reloadPendingCommands(): Promise<void> {
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    await this.#refreshState();
  }

  async refreshSession(foregroundScopeIds?: readonly string[]): Promise<void> {
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    this.#setForegroundScopePolicy(foregroundScopeIds);
    await this.#discoverScopes();
    await this.#restoreInterruptedCommands();
    await this.#refreshState();
    if (this.#network.connected()) this.#flushInBackground();
  }

  /** Restores local outbox visibility without enabling pull or replay transport. */
  async refreshLocalSession(): Promise<void> {
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
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
    this.#pullAttentions.set([]);
    this.#scheduleRetry(null);
  }

  /** Synchronously invalidate in-flight enqueue and transport work owned by the current session. */
  revokeSession(): void {
    this.#invalidateFlush();
    this.#foregroundScopePolicy = null;
  }

  enqueue<T>(request: EnqueueOfflineCommand<T>, options: { flush?: boolean } = {}): Promise<string> {
    return this.#mutationAdmission.run(() => {
      const generation = this.#generation;
      return this.#serializeReplicaMutation((repository) => this.#enqueue(request, options, generation, undefined, repository));
    });
  }

  /**
   * Reads, derives, and commits one Outbox command, then rematerializes its
   * aggregate from confirmed replica values plus remaining FIFO intents.
   */
  enqueuePrepared<T>(
    prepare: (repository: OfflineRepository) => Promise<PreparedOfflineCommand<T>>,
    options: { flush?: boolean } = {},
  ): Promise<string> {
    return this.#mutationAdmission.run(() => {
      const generation = this.#generation;
      return this.#serializeReplicaMutation(async (repository) => {
        await this.#ensureInitialized();
        if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared enqueue.');
        const prepared = await prepare(repository);
        return this.#enqueue(prepared.request, options, generation, undefined, repository);
      });
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
    return this.#mutationAdmission.run(() => {
      const generation = this.#generation;
      return this.#serializeReplicaMutation(async (repository) => {
        await this.#ensureInitialized();
        if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared batch enqueue.');
        const prepared = await prepare(repository);
        return this.#enqueuePreparedBatch(prepared, options, generation, repository);
      });
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
    return this.#serializeReplicaMutation(async (repository) => {
      await this.#ensureInitialized();
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
      const prepared = await prepare(repository);
      return this.#enqueue(prepared.request, options, generation, replaced, repository);
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
    return this.#serializeReplicaMutation(async (repository) => {
      await this.#ensureInitialized();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before prepared aggregate replacement.');
      const knownCommands = await this.#readKnownCommands();
      const selected = knownCommands.find((command) => command.commandId === commandId);
      if (!selected) throw new Error(`Offline command ${commandId} no longer exists.`);
      const aggregateKey = this.#aggregateKey(selected);
      const replaced = knownCommands.filter((command) => this.#aggregateKey(command) === aggregateKey);
      this.#assertDiscardable(replaced);
      const prepared = await prepare(repository, replaced);
      if (prepared.length !== replaced.length) {
        throw new Error('Offline aggregate replacement must preserve the ordered intent count.');
      }
      const session = await this.#beginEnqueueSession(generation);
      const materializations: MaterializedOfflineEnqueue[] = [];
      for (const [index, entry] of prepared.entries()) {
        this.#assertEnqueueScope(session, entry.request.scopeId);
        materializations.push(await this.#materializeEnqueue(session.userId, entry.request, replaced[index]));
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
        repository,
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
    return this.#serializeReplicaMutation(async (repository) => {
      await this.#ensureInitialized();
      if (!this.#isCurrent(generation)) throw new Error('Offline session changed before serialized replica mutation.');
      const result = await operation(repository);
      if (this.#isCurrent(generation)) await this.#refreshState(generation);
      return result;
    });
  }

  #serializeReplicaMutation<T>(operation: (repository: OfflineRepository) => Promise<T>): Promise<T> {
    return this.#replicaMutations.run(operation);
  }

  async #enqueue<T>(
    request: EnqueueOfflineCommand<T>,
    options: { flush?: boolean },
    generation: number,
    replaced?: OfflineCommand,
    repository: OfflineRepository = this.#repository,
  ): Promise<string> {
    const session = await this.#beginEnqueueSession(generation);
    this.#assertEnqueueScope(session, request.scopeId);
    const materialization = await this.#materializeEnqueue(session.userId, request, replaced);
    const currentCommands = await this.#commandsForUser(session.userId);
    const retainedCommands = replaced ? currentCommands.filter((command) => command.commandId !== replaced.commandId) : currentCommands;
    this.#assertDistinctBatchFootprints([materialization], retainedCommands);
    await this.#assertOutboxCapacity(
      session.userId,
      [materialization.command],
      replaced ? [replaced.commandId] : undefined,
      currentCommands,
    );
    await this.#commitMaterializedEnqueues([materialization], generation, options, replaced ? [replaced.commandId] : undefined, repository);
    return materialization.command.commandId;
  }

  async #enqueuePreparedBatch<T>(
    prepared: readonly PreparedOfflineCommand<T>[],
    options: PreparedOfflineBatchOptions,
    generation: number,
    repository: OfflineRepository,
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
      materializations.push(await this.#materializeEnqueue(session.userId, entry.request, undefined, firstCreatedAt + index));
    }
    this.#assertDistinctBatchFootprints(materializations, currentCommands);
    await this.#assertOutboxCapacity(
      session.userId,
      materializations.map((item) => item.command),
      undefined,
      currentCommands,
    );
    options.assertCurrent?.();
    await this.#commitMaterializedEnqueues(materializations, generation, options, undefined, repository);
    return materializations.map((item) => item.command.commandId);
  }

  async #beginEnqueueSession(generation: number): Promise<OfflineSyncSession> {
    await this.#ensureInitialized();
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
    replaced?: OfflineCommand,
    createdAt?: number,
  ): Promise<MaterializedOfflineEnqueue> {
    const scope = { userId, scopeId: request.scopeId };
    this.noteScope(scope);
    const commandIdentity = offlineCommandLookupIdentity(request.identity);
    const normalized = await this.#normalizeEnqueueRequest(scope, request, commandIdentity);
    const commandId = crypto.randomUUID();
    const sourceKey = this.#hooks.entityType(request);
    const localOnlyFootprint = this.#normalizedLocalOnlyFootprint(scope, request.localOnlyFootprint);
    if (replaced) this.#assertReplacementFootprint(replaced, localOnlyFootprint);
    let command: OfflineCommand = {
      ...scope,
      commandId,
      aggregateType: request.aggregateType,
      sourceKey,
      identity: commandIdentity,
      operation: request.operation,
      payload: normalized.payload,
      replicaMutation: request.replicaMutation ?? 'upsert',
      baseRevision: normalized.baseRevision,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: replaced?.createdAt ?? createdAt ?? (await this.#nextCommandCreatedAt(userId)),
      lastErrorCode: null,
    };
    if (localOnlyFootprint.length > 0) command = { ...command, localOnlyFootprint };
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
    const naturalKey =
      schema.identity.kind === 'naturalKey' && request.identity.kind === 'natural'
        ? request.identity.naturalKey
        : existing
          ? offlineNaturalKeyFromValues(schema, existing.values)
          : null;
    if (
      schema.identity.kind === 'naturalKey' &&
      request.identity.kind === 'natural' &&
      canonicalOfflineRemoteIdentity(schema, { naturalKey: request.identity.naturalKey }) !==
        canonicalOfflineRemoteIdentity(schema, { naturalKey: naturalKey! })
    ) {
      throw new Error(`Offline command naturalKey must match replica identity for "${entityType}".`);
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
        throw new Error(`Offline replica naturalKey is immutable and must match command identity for "${entityType}".`);
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
    this.#canonicalJson(normalized.payload);
    const seedBaseRow = existing
      ? undefined
      : request.identity.kind === 'generated'
        ? {
            ...scope,
            sourceKey,
            identity: { kind: 'generated' as const, localId: request.identity.localId, remoteId: initialRemoteId },
            values: {},
            confirmedValues: null,
            serverRevision: null,
            fetchedAt: Date.now(),
            syncState: 'pending' as const,
          }
        : request.identity.kind === 'natural'
          ? {
              ...scope,
              sourceKey,
              identity: { kind: 'natural' as const, naturalKey: request.identity.naturalKey },
              values: { ...request.identity.naturalKey },
              confirmedValues: null,
              serverRevision: null,
              fetchedAt: Date.now(),
              syncState: 'pending' as const,
            }
          : null;
    return { command, seedBaseRow };
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
      for (const key of this.#commandFootprintKeys(entry.command)) {
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
    return [this.#replicaRowKey({ ...command, identity }), ...commandFootprintKeys(command).map((key) => this.#replicaRowKey(key))];
  }

  async #commitMaterializedEnqueues(
    entries: readonly MaterializedOfflineEnqueue[],
    generation: number,
    options: { flush?: boolean },
    removeCommandIds?: readonly string[],
    repository: OfflineRepository = this.#repository,
  ): Promise<void> {
    if (generation !== this.#generation) {
      throw new Error('Offline session changed before the command could be persisted');
    }
    const known = await this.#readKnownCommands();
    const remaining = [
      ...known.filter((command) => !(removeCommandIds ?? []).includes(command.commandId)),
      ...entries.map((entry) => entry.command),
    ].sort(compareOfflineCommands);
    const affected = new Map<string, OfflineCommand>();
    const seeds = new Map<string, OfflineReplicaRow | null>();
    for (const entry of entries) {
      affected.set(this.#aggregateKey(entry.command), entry.command);
      if (entry.seedBaseRow !== undefined) seeds.set(this.#aggregateKey(entry.command), entry.seedBaseRow);
    }
    const rematerialized = await this.#rematerializeAffectedAggregates(affected, remaining, seeds);
    await repository.transactReplica({
      putRows: rematerialized.putRows,
      removeRows: rematerialized.removeRows,
      putCommands: entries.map((entry) => entry.command),
      removeCommandIds,
    });
    await this.#refreshState().catch((error) => this.#reportError(error));
    if (options.flush !== false && this.#network.connected()) this.#flushInBackground();
  }

  #normalizedLocalOnlyFootprint(
    scope: OfflineScope,
    footprint: readonly OfflineReplicaRowKey[] | undefined,
  ): readonly OfflineReplicaRowKey[] {
    if (!footprint || footprint.length === 0) return [];
    const seen = new Set<string>();
    return footprint.map((key) => {
      this.#assertLocalOnlyFootprintKey(scope, key);
      const canonical = this.#replicaRowKey(key);
      if (seen.has(canonical)) throw new Error(`Prepared offline enqueue contains duplicate replica row ${canonical}.`);
      seen.add(canonical);
      return this.#minimalReplicaRowKey(key);
    });
  }

  #assertLocalOnlyFootprintKey(scope: OfflineScope, key: OfflineReplicaRowKey): void {
    if (key.userId !== scope.userId || key.scopeId !== scope.scopeId) {
      throw new Error('Prepared offline enqueue localOnly footprint must use the command scope.');
    }
    if (this.#entitySchema(key.sourceKey).identity.kind !== 'localOnly') {
      throw new Error(`Prepared offline enqueue footprint may only declare localOnly source "${key.sourceKey}".`);
    }
    if (key.identity.kind !== 'local') {
      throw new Error('Prepared offline enqueue footprint must use local identity.');
    }
  }

  #assertReplacementFootprint(replaced: OfflineCommand, next: readonly OfflineReplicaRowKey[]): void {
    const previous = new Set(commandFootprintKeys(replaced).map((key) => this.#replicaRowKey(key)));
    const incoming = new Set(next.map((key) => this.#replicaRowKey(key)));
    if (previous.size !== incoming.size || [...previous].some((key) => !incoming.has(key))) {
      throw new Error('Offline replacement must preserve the localOnly footprint.');
    }
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
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    // A pull may have completed while transport was being cancelled. Re-read
    // and project the discard inside the same local mutation lane used by
    // enqueue, ACK, and pull application so an old before-image cannot replace
    // a newer authoritative row after its cursor has advanced.
    const command = await this.#replicaMutations.run(async (repository) => {
      const current = (await this.#readKnownCommands()).find((item) => item.commandId === commandId);
      if (!current) return null;
      this.#assertDiscardable([current]);
      this.#invalidateFlush();
      await this.#discardCommands([current], repository);
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
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
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
    const generation = this.#generation;
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    const commands = await this.#replicaMutations.run(async (repository) => {
      const current = await this.#readKnownCommands();
      this.#assertDiscardable(current);
      this.#invalidateFlush();
      await this.#discardCommands(current, repository);
      return current;
    });
    await this.#refreshState();
    await Promise.all(commands.map((command) => this.#hooks.onCommandRemoved?.(command).catch((error) => this.#reportError(error))));
  }

  #assertDiscardable(commands: readonly OfflineCommand[]): void {
    const ambiguous = commands.filter(
      (command) => command.state === 'sending' || command.state === 'awaiting_pull' || command.serverCommitUnknown === true,
    );
    if (ambiguous.length > 0) {
      throw new OfflineCommandInFlightError(ambiguous.map((command) => command.commandId));
    }
  }

  #flushInBackground(): void {
    void this.#beginFlush(false).catch((error) => this.#reportError(error));
  }

  flush(): Promise<void> {
    const generation = this.#generation;
    return this.#flushAfterInitialization(generation);
  }

  async #flushAfterInitialization(generation: number): Promise<void> {
    if (!(await this.#restoreCurrentGeneration(generation))) return;
    return this.#beginFlush(true);
  }

  #beginFlush(explicitFull: boolean): Promise<void> {
    const isPartial = !explicitFull && this.#foregroundScopePolicy !== null;
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
      const pullScope = async (): Promise<void> => {
        await this.#pull.pull(scope);
        await this.#markScopeReconciled(scope, generation);
        pulledScopeKeys.add(this.#scopeKey(scope));
      };
      const pull = await pullScope().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      if (pull.status === 'rejected') {
        prePullFailures.push(pull.error);
        if (this.#isFatalPullFailure(pull.error)) {
          // Auth/upgrade-driven recovery only: stop remaining scopes immediately.
          fatalPullFailure = fatalPullFailure ?? pull.error;
          await this.#persistFatalPullAttentions(pull.error, scope, pullScopes, generation);
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
      const known = await this.#readKnownCommands();
      const groups = this.#eligibleAggregateGroups(known).filter((group) =>
        group.some(
          (command) =>
            (command.state === 'pending' || command.state === 'retry_wait') &&
            pulledScopeKeys.has(this.#scopeKey({ userId: command.userId, scopeId: command.scopeId })),
        ),
      );
      if (!this.#isCurrent(generation)) return;
      if (groups.length === 0) break;
      const pendingBefore = known.filter((command) => command.state === 'pending' || command.state === 'retry_wait').length;
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
      const pendingAfter = (await this.#readKnownCommands()).filter(
        (command) => command.state === 'pending' || command.state === 'retry_wait',
      ).length;
      if (pendingAfter >= pendingBefore) break;
    }
    for (const scope of dirtyScopes.values()) {
      this.#pendingPullScopes.set(this.#scopeKey(scope), scope);
    }
    const postPullFailures: unknown[] = [];
    // Fatal pre-pull skips pending post-pulls; recovery is auth/upgrade-driven, not timer retry.
    // Fatal post-send pull stops remaining pending scopes the same way (ACK preserved, no resend).
    if (fatalPullFailure === null) {
      const postPullScopes = [...this.#pendingPullScopes.values()];
      for (const scope of postPullScopes) {
        if (!this.#isCurrent(generation) || !this.#network.connected()) break;
        // A command response may contain only the aggregate's base row. Pull once per dirty scope so
        // sibling-table journal entries are visible before completed Outbox state reaches product UI.
        const pullScope = async (): Promise<void> => {
          await this.#pull.pull(scope);
          await this.#markScopeReconciled(scope, generation);
        };
        const pull = await pullScope().then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        if (pull.status === 'rejected') {
          if (this.#isFatalPullFailure(pull.error)) {
            fatalPullFailure = fatalPullFailure ?? pull.error;
            await this.#persistFatalPullAttentions(pull.error, scope, postPullScopes, generation);
            break;
          }
          postPullFailures.push(pull.error);
        }
      }
    }
    await this.#refreshState(generation);
    if (fatalPullFailure !== null) {
      // Auth/upgrade recovery only — never arm the 1s automatic flush retry.
      // Transported commands remain awaiting_pull for later auth/upgrade recovery.
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
    if (this.#isCurrent(generation)) {
      for (const command of await this.#readKnownCommands()) {
        if (command.state !== 'awaiting_pull') continue;
        const scope = { userId: command.userId, scopeId: command.scopeId };
        this.#pendingPullScopes.set(this.#scopeKey(scope), scope);
      }
    }
  }

  #isFatalPullFailure(error: unknown): boolean {
    const status = this.#errorStatus(error);
    // Pull-protocol HTTP 409 is schema mismatch (distinct from command-send conflict
    // classification elsewhere in this service). Same classifier for pre-pull and post-send pull.
    if (status === 401 || status === 403 || status === 409) return true;
    return error instanceof OfflineReplicaSchemaMismatchError;
  }

  #pullAttentionReason(error: unknown): OfflinePullAttentionReason | null {
    if (error instanceof OfflineReplicaSchemaMismatchError) return 'schema_upgrade_required';
    const status = this.#errorStatus(error);
    if (status === 409) return 'schema_upgrade_required';
    if (status === 401 || status === 403) return 'authorization_required';
    return null;
  }

  /**
   * Persists durable pull attentions for a current-generation fatal pull.
   * Schema/409 marks all attempted pull scopes; 401 marks every known principal scope;
   * 403 marks only the failing scope. Stale generations must not mutate a newer session.
   */
  async #persistFatalPullAttentions(
    error: unknown,
    failingScope: OfflineScope,
    attemptedScopes: readonly OfflineScope[],
    generation: number,
  ): Promise<void> {
    if (!this.#isCurrent(generation)) return;
    const reason = this.#pullAttentionReason(error);
    if (reason === null) return;
    const status = this.#errorStatus(error);
    // Snapshot synchronously before any await so a concurrent session switch cannot retarget scopes.
    const scoped =
      status === 403
        ? [failingScope]
        : status === 401
          ? [...this.#knownScopes.values()].filter((scope) => scope.userId === failingScope.userId)
          : attemptedScopes.filter((scope) => scope.userId === failingScope.userId);
    const scopes = scoped.length > 0 ? scoped : [failingScope];
    const attentions: OfflinePullAttention[] = scopes.map((scope) => {
      const attention: OfflinePullAttention = {
        userId: scope.userId,
        scopeId: scope.scopeId,
        reason,
      };
      if (status > 0) attention.status = status;
      return attention;
    });
    if (!this.#isCurrent(generation)) return;
    await this.#repository.transactReplica({ putPullAttentions: attentions });
  }

  #setForegroundScopePolicy(foregroundScopeIds?: readonly string[]): void {
    this.#foregroundScopePolicy = foregroundScopeIds !== undefined ? foregroundScopeIds : null;
  }

  #scopesForPartialPull(foregroundScopeIds: readonly string[], commands: readonly OfflineCommand[]): OfflineScope[] {
    const foregroundScopeSet = new Set(foregroundScopeIds);
    const outboxScopeKeys = new Set(commands.map((command) => this.#scopeKey({ userId: command.userId, scopeId: command.scopeId })));
    const attentionScopeKeys = new Set(this.#pullAttentions().map((attention) => this.#scopeKey(attention)));
    return [...this.#knownScopes.values()].filter(
      (scope) =>
        foregroundScopeSet.has(scope.scopeId) ||
        outboxScopeKeys.has(this.#scopeKey(scope)) ||
        attentionScopeKeys.has(this.#scopeKey(scope)) ||
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
    return [...groups.values()].filter((group) =>
      group.some((command) => command.state === 'pending' || (command.state === 'retry_wait' && (command.retryAt ?? 0) <= now)),
    );
  }

  async #sendAggregate(
    commands: OfflineCommand[],
    generation: number,
    dirtyScopes: Map<string, OfflineScope>,
    pulledScopeKeys: ReadonlySet<string>,
  ): Promise<void> {
    for (const command of commands) {
      if (!this.#isCurrent(generation)) return;
      if (command.state === 'awaiting_pull') continue;
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
      const claimedCommand = sending;
      const readRow = async (): Promise<OfflineReplicaRow | null> => this.#rowForCommand(claimedCommand);
      const rowResult = await readRow().then(
        (row) => ({ status: 'fulfilled' as const, row }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      if (rowResult.status === 'rejected') {
        if (!this.#isCurrent(generation)) return;
        await this.#persistFailedCommand(sending, rowResult.error, generation, null, sending.serverCommitUnknown === true);
        throw rowResult.error;
      }
      const row = rowResult.row;
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
      const executeCommand = async (): Promise<OfflineCommandResult> =>
        this.#executor.execute(sending, offlineCommandTargetFromReplicaRow(row));
      const execution = await executeCommand().then(
        (result) => ({ status: 'fulfilled' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      if (execution.status === 'rejected') {
        if (!this.#isCurrent(generation)) return;
        const commitUnknown = this.#executor.provesCommandNotCommitted?.(execution.error, sending)
          ? false
          : priorCommitUnknown || this.#serverCommitCouldBeUnknown(execution.error);
        await this.#persistFailedCommand(sending, execution.error, generation, row, commitUnknown);
        if (!this.#isClassifiableTransportError(execution.error)) throw execution.error;
        break;
      }
      const result = execution.result;
      if (!this.#isCurrent(generation)) return;
      const completeCommand = async (): Promise<void> => this.#completeCommand(commands, sending, result, generation);
      const completion = await completeCommand().then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      if (completion.status === 'rejected') {
        if (!this.#isCurrent(generation)) return;
        await this.#persistFailedCommand(sending, completion.error, generation, row, true);
        throw completion.error;
      }
      if (this.#isCurrent(generation)) {
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
    const sourceKey = this.#hooks.entityType(request);
    const row = await this.#getReplicaRowForSync(scope, sourceKey, commandIdentity);
    if (row?.serverRevision != null && row.serverRevision !== baseRevision) {
      baseRevision = row.serverRevision;
    }
    return { payload: request.payload, baseRevision };
  }

  async #completeCommand(
    commands: OfflineCommand[],
    command: OfflineCommand,
    result: OfflineCommandResult,
    generation: number,
  ): Promise<void> {
    return this.#serializeReplicaMutation((repository) => this.#completeCommandLocked(commands, command, result, generation, repository));
  }

  async #completeCommandLocked(
    commands: OfflineCommand[],
    command: OfflineCommand,
    result: OfflineCommandResult,
    generation: number,
    repository: OfflineRepository,
  ): Promise<void> {
    if (result.clearRemoteId === true && result.remoteId !== undefined) {
      throw new Error('Offline command cannot return remoteId and clearRemoteId together.');
    }
    if (result.clearRemoteId === true && result.serverRevision !== undefined) {
      throw new Error('Offline command cannot return serverRevision and clearRemoteId together.');
    }
    const latestCommands = (await this.#readKnownCommands()).filter(
      (candidate) => this.#aggregateKey(candidate) === this.#aggregateKey(command),
    );
    const latestIndex = latestCommands.findIndex((candidate) => candidate.commandId === command.commandId);
    if (latestIndex < 0) return;
    const revision = result.serverRevision;
    const following = latestCommands.slice(latestIndex + 1);
    const rebased =
      result.clearRemoteId === true
        ? following.map((item) => offlineCommandWithBaseRevision(item, null))
        : revision === undefined
          ? following
          : following.map((item) => offlineCommandWithBaseRevision(item, revision));
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
    const schema = this.#entitySchema(current.sourceKey);
    this.#assertCommandResultIdentity(schema, current, result);
    const resolvedRemoteId = this.#resolvedRemoteId(current, result);
    const reconciliationIdentity =
      current.identity.kind === 'generated'
        ? resolvedRemoteId === null
          ? undefined
          : { remoteId: resolvedRemoteId }
        : current.identity.kind === 'natural'
          ? { naturalKey: current.identity.naturalKey }
          : undefined;
    const awaitingPull: OfflineCommand = {
      ...command,
      state: 'awaiting_pull',
      retryAt: null,
      lastErrorCode: null,
      serverCommitUnknown: false,
      ...(reconciliationIdentity ? { reconciliationIdentity } : {}),
    };
    latestCommands.splice(latestIndex, 1 + rebased.length, awaitingPull, ...rebased);
    const identityUpdatedBase: OfflineReplicaRow = {
      ...current,
      identity:
        current.identity.kind === 'generated'
          ? {
              ...current.identity,
              remoteId: result.clearRemoteId === true ? null : resolvedRemoteId,
            }
          : current.identity,
      serverRevision: result.clearRemoteId === true ? null : (revision ?? current.serverRevision),
      fetchedAt: Date.now(),
    };
    const rematerialized = await this.#rematerializeAggregate(awaitingPull, latestCommands, identityUpdatedBase);
    if (!this.#isCurrent(generation)) return;
    await repository.transactReplica({
      putRows: rematerialized.putRows,
      releaseRemoteIds:
        result.clearRemoteId === true && current.identity.kind === 'generated' && current.identity.remoteId !== null
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
      removeRows: rematerialized.removeRows,
      putCommands: [awaitingPull, ...rebased],
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

  async #discardCommands(discarded: readonly OfflineCommand[], repository: OfflineRepository): Promise<void> {
    const all = await this.#readKnownCommands();
    const discardedIds = new Set(discarded.map((command) => command.commandId));
    const affected = new Map<string, OfflineCommand>();
    for (const command of discarded) affected.set(this.#aggregateKey(command), command);
    const remaining = all.filter((item) => !discardedIds.has(item.commandId));
    const rematerialized = await this.#rematerializeAffectedAggregates(affected, remaining);
    await repository.transactReplica({
      putRows: rematerialized.putRows,
      removeRows: rematerialized.removeRows,
      removeCommandIds: [...discardedIds],
    });
  }

  async #rematerializeAffectedAggregates(
    affected: ReadonlyMap<string, OfflineCommand>,
    remaining: readonly OfflineCommand[],
    seeds: ReadonlyMap<string, OfflineReplicaRow | null> = new Map(),
  ): Promise<Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>> {
    const putRows: OfflineReplicaRow[] = [];
    const removeRows: OfflineReplicaRowKey[] = [];
    for (const [key, command] of affected) {
      const remainingForAggregate = remaining.filter((item) => this.#aggregateKey(item) === key);
      const footprintCommands = [...remainingForAggregate, ...[...affected.values()].filter((item) => this.#aggregateKey(item) === key)];
      const rematerialized = await this.#rematerializeAggregate(
        command,
        remainingForAggregate,
        seeds.has(key) ? seeds.get(key) : undefined,
        footprintCommands,
      );
      putRows.push(...(rematerialized.putRows ?? []));
      removeRows.push(...(rematerialized.removeRows ?? []));
    }
    return { putRows, removeRows };
  }

  async #rematerializeAggregate(
    command: OfflineCommand,
    remaining: readonly OfflineCommand[],
    baseRow = undefined as OfflineReplicaRow | null | undefined,
    footprintCommands = remaining,
  ): Promise<Pick<OfflineReplicaTransaction, 'putRows' | 'removeRows'>> {
    const current = baseRow === undefined ? await this.#rowForCommand(command) : baseRow;
    const projection = this.#replicaMutations.projectAggregateIntent({
      baseRow: current,
      localOnlyRows: await this.#localOnlyRowsForCommands(footprintCommands),
      commands: remaining,
      trigger: 'local',
    });
    if (isOfflineAggregateIntentConflict(projection)) {
      throw new Error('Offline aggregate intent projector cannot return conflict outside pull reconciliation.');
    }
    return offlineAggregateIntentMutations(projection, current);
  }

  async #localOnlyRowsForCommands(commands: readonly OfflineCommand[]): Promise<OfflineReplicaRow[]> {
    const keys = new Map<string, OfflineReplicaRowKey>();
    for (const command of commands) {
      for (const key of commandFootprintKeys(command)) {
        keys.set(this.#replicaRowKey(key), key);
      }
    }
    const rows = await Promise.all([...keys.values()].map((key) => this.#getLocalOnlyRow(key)));
    return rows.filter((row): row is OfflineReplicaRow => row !== null);
  }

  #getLocalOnlyRow(key: OfflineReplicaRowKey): Promise<OfflineReplicaRow | null> {
    const scope = { userId: key.userId, scopeId: key.scopeId };
    return (
      this.#repository.getReplicaRowIncludingPendingDelete?.(scope, key.sourceKey, key.identity) ??
      this.#repository.getReplicaRow(scope, key.sourceKey, key.identity)
    );
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
    await this.#serializeReplicaMutation(async (repository) => {
      const current = row === undefined ? await this.#rowForCommand(command) : row;
      if (!this.#isCurrent(generation)) return;
      if (current) {
        await repository.transactReplica({
          putRows: [{ ...current, syncState: this.#replicaState(failed.state) }],
          putCommands: [failed],
        });
      } else {
        await repository.putCommand(failed);
      }
    });
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
    queueMicrotask(() => this.#dispatchError(error));
  }

  #dispatchError(error: unknown): void {
    let result: unknown;
    try {
      result = (this.#errorHandler.handleError as (reportedError: unknown) => unknown)(error);
    } catch {
      return;
    }
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
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
    if (schema.identity.kind === 'naturalKey' && result.confirmedValues !== undefined) {
      const currentKey =
        current.identity.kind === 'natural' ? current.identity.naturalKey : offlineNaturalKeyFromValues(schema, current.values)!;
      const confirmedKey = offlineNaturalKeyFromValues(schema, result.confirmedValues)!;
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
    await this.#prunePullAttentions(session.userId, generation);
    return true;
  }

  async #discoverLocalScopes(generation = this.#generation): Promise<boolean> {
    const session = await this.#getLocalSession();
    if (!this.#isCurrent(generation)) return false;
    if (!session) {
      this.#activeUserId = null;
      this.#knownScopes.clear();
      this.#pullAttentions.set([]);
      return true;
    }
    this.#assertSessionPrincipalBoundary(session);
    this.#setActiveUser(session.userId);
    this.#knownScopes.clear();
    for (const scope of session.scopes) this.#knownScopes.set(this.#scopeKey(scope), scope);
    await this.#restorePendingPullScopes(session.userId, generation);
    await this.#prunePullAttentions(session.userId, generation);
    return true;
  }

  #getLocalSession(): Promise<OfflineSyncSession | null> {
    return this.#context.getLocalSession?.() ?? this.#context.getSession();
  }

  #setActiveUser(userId: OfflinePrincipalId): void {
    if (this.#activeUserId === userId) return;
    this.#knownScopes.clear();
    this.#pendingPullScopes.clear();
    this.#pullAttentions.set([]);
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
    const attentions =
      this.#activeUserId !== null && this.#repository.getPullAttentions ? await this.#repository.getPullAttentions(this.#activeUserId) : [];
    if (!this.#isCurrent(generation)) return;
    this.#commands.set(commands);
    this.#pullAttentions.set(attentions);
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
    const transition = this.#serializeReplicaMutation(async (repository) => {
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
      await repository.putCommand(sending);
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
    return this.#serializeReplicaMutation(async (repository) => {
      if (!this.#isCurrent(generation)) return null;
      const scope = { userId: command.userId, scopeId: command.scopeId };
      const current = (await this.#repository.getCommands(scope)).find((candidate) => candidate.commandId === command.commandId);
      if (!current || current.state !== 'sending') return null;
      const transportCommand = { ...current, serverCommitUnknown: true };
      await repository.putCommand(transportCommand);
      return transportCommand;
    });
  }

  async #restorePendingPullScopes(userId: OfflinePrincipalId, generation: number): Promise<void> {
    const commands = await this.#readKnownCommands();
    if (!this.#isCurrent(generation) || this.#activeUserId !== userId) return;
    this.#pendingPullScopes.clear();
    for (const command of commands) {
      if (command.state !== 'awaiting_pull') continue;
      const scope = { userId: command.userId, scopeId: command.scopeId };
      const key = this.#scopeKey(scope);
      this.#pendingPullScopes.set(key, scope);
    }
  }

  async #prunePullAttentions(userId: OfflinePrincipalId, generation: number): Promise<void> {
    if (!this.#repository.getPullAttentions) return;
    const attentions = await this.#repository.getPullAttentions(userId);
    if (!this.#isCurrent(generation) || this.#activeUserId !== userId) return;
    const currentKeys = new Set(this.#knownScopes.keys());
    const revoked = attentions.filter((attention) => !currentKeys.has(this.#scopeKey(attention)));
    if (revoked.length > 0) {
      await this.#repository.transactReplica({ removePullAttentions: revoked });
    }
  }

  async #markScopeReconciled(scope: OfflineScope, generation: number): Promise<void> {
    if (!this.#isCurrent(generation)) return;
    await this.#repository.transactReplica({
      removePullAttentions: [scope],
    });
    if (!this.#isCurrent(generation)) return;
    this.#pendingPullScopes.delete(this.#scopeKey(scope));
  }

  async #waitForSendingTransitions(): Promise<void> {
    await Promise.allSettled([...this.#sendingTransitions]);
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
