import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { OFFLINE_COMMAND_EXECUTOR, OFFLINE_SYNC_CONTEXT } from './offline-command-executor';
import { OFFLINE_COMMAND_HOOKS } from './offline-command-hooks';
import { OfflineNetworkService } from './offline-network.service';
import type { OfflineCommand, OfflineScope } from './offline-repository';
import { OFFLINE_REPOSITORY } from './offline-repository';

export type OfflineSyncState = 'idle' | 'pending' | 'syncing' | 'attention';

export interface EnqueueOfflineCommand<T = unknown> {
  groupId: number;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  payload: T;
  baseRevision?: string | number | null;
}

const MAX_PARALLEL_AGGREGATES = 3;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  readonly #network = inject(OfflineNetworkService);
  readonly #repository = inject(OFFLINE_REPOSITORY);
  readonly #executor = inject(OFFLINE_COMMAND_EXECUTOR);
  readonly #context = inject(OFFLINE_SYNC_CONTEXT);
  readonly #hooks = inject(OFFLINE_COMMAND_HOOKS);
  readonly #commands = signal<OfflineCommand[]>([]);
  readonly #knownScopes = new Map<string, OfflineScope>();
  #activeUserId: number | null = null;
  #flushPromise: Promise<void> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #initialized = false;

  readonly pendingCommands = this.#commands.asReadonly();
  readonly pendingCount = computed(() => this.pendingCommands().length);
  readonly conflicts = computed(() => this.#commands().filter((command) => command.state === 'conflict'));
  readonly syncState = computed<OfflineSyncState>(() => {
    const commands = this.#commands();
    if (commands.some((command) => ['blocked_auth', 'rejected', 'conflict'].includes(command.state))) return 'attention';
    if (commands.some((command) => command.state === 'sending')) return 'syncing';
    return commands.length > 0 ? 'pending' : 'idle';
  });

  constructor() {
    effect(() => {
      if (this.#initialized && this.#network.connected()) void this.flush();
    });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#repository.initialize();
    await this.#discoverScopes();
    const commands = await this.#readKnownCommands();
    await Promise.all(
      commands
        .filter((command) => command.state === 'sending')
        .map((command) => this.#repository.putCommand({ ...command, state: 'pending' })),
    );
    this.#initialized = true;
    await this.#refreshState();
    if (this.#network.connected()) void this.flush();
  }

  noteScope(scope: OfflineScope): void {
    this.#knownScopes.set(this.#scopeKey(scope), scope);
  }

  async reloadPendingCommands(): Promise<void> {
    await this.initialize();
    await this.#refreshState();
  }

  async refreshSession(): Promise<void> {
    await this.initialize();
    await this.#discoverScopes();
    await this.#refreshState();
    if (this.#network.connected()) void this.flush();
  }

  async resetSession(): Promise<void> {
    this.#activeUserId = null;
    this.#knownScopes.clear();
    this.#commands.set([]);
    this.#scheduleRetry(null);
  }

  async enqueue<T>(request: EnqueueOfflineCommand<T>, options: { flush?: boolean } = {}): Promise<string> {
    await this.initialize();
    const session = await this.#context.getSession();
    if (!session) throw new Error('Cannot enqueue an offline command without an authenticated user');
    const userId = session.userId;
    this.#setActiveUser(userId);
    const scope = { userId, groupId: request.groupId };
    this.noteScope(scope);
    const normalized = await this.#normalizeEnqueueRequest(scope, request);
    const commandId = crypto.randomUUID();
    await this.#repository.putCommand({
      ...scope,
      commandId,
      aggregateType: request.aggregateType,
      aggregateId: request.aggregateId,
      operation: request.operation,
      payload: normalized.payload,
      payloadHash: await this.#payloadHash(normalized.payload),
      baseRevision: normalized.baseRevision,
      state: 'pending',
      attempts: 0,
      retryAt: null,
      createdAt: Date.now(),
      lastErrorCode: null,
    });
    await this.#refreshState();
    if (options.flush !== false && this.#network.connected()) void this.flush();
    return commandId;
  }

  async discard(commandId: string, options: { flush?: boolean } = {}): Promise<void> {
    await this.initialize();
    const command = (await this.#readKnownCommands()).find((item) => item.commandId === commandId);
    if (!command) return;
    await this.#repository.removeCommand(command.commandId);
    await this.#hooks.onCommandRemoved?.(command);
    await this.#refreshState();
    if (options.flush !== false && this.#network.connected()) void this.flush();
  }

  async discardAllPending(): Promise<void> {
    await this.initialize();
    await Promise.all(
      this.pendingCommands().map(async (command) => {
        await this.#repository.removeCommand(command.commandId);
        await this.#hooks.onCommandRemoved?.(command);
      }),
    );
    await this.#refreshState();
  }

  flush(): Promise<void> {
    this.#flushPromise ??= this.#runFlush().finally(() => (this.#flushPromise = null));
    return this.#flushPromise;
  }

  async #runFlush(): Promise<void> {
    if (!this.#network.connected()) {
      await this.#refreshState();
      return;
    }
    await this.#discoverScopes();
    while (this.#network.connected()) {
      const groups = this.#eligibleAggregateGroups(await this.#readKnownCommands());
      if (groups.length === 0) break;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(MAX_PARALLEL_AGGREGATES, groups.length) }, async () => {
        while (cursor < groups.length) {
          const group = groups[cursor++];
          if (group) await this.#sendAggregate(group);
        }
      });
      await Promise.all(workers);
    }
    await this.#refreshState();
  }

  #eligibleAggregateGroups(commands: OfflineCommand[]): OfflineCommand[][] {
    const now = Date.now();
    const groups = new Map<string, OfflineCommand[]>();
    for (const command of commands) {
      const key = `${command.userId}:${command.groupId}:${command.aggregateType}:${command.aggregateId}`;
      const group = groups.get(key) ?? [];
      group.push(command);
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => {
      const head = group[0];
      return head?.state === 'pending' || (head?.state === 'retry_wait' && (head.retryAt ?? 0) <= now);
    });
  }

  async #sendAggregate(commands: OfflineCommand[]): Promise<void> {
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index]!;
      if (command.state === 'retry_wait' && (command.retryAt ?? 0) > Date.now()) break;
      if (!['pending', 'retry_wait'].includes(command.state)) break;
      const sending: OfflineCommand = {
        ...command,
        state: 'sending',
        attempts: command.attempts + 1,
        retryAt: null,
        lastErrorCode: null,
      };
      await this.#repository.putCommand(sending);
      await this.#refreshState();
      try {
        const result = await this.#executor.execute(sending);
        const revision = result.serverRevision;
        if (this.#hooks.shouldUpdateCache(sending, result)) {
          await this.#updateCachedEntity(sending, result);
          if (revision !== undefined) await this.#rebaseFollowingCommands(commands, index + 1, revision);
        }
        await this.#repository.removeCommand(sending.commandId);
      } catch (error) {
        const failed = this.#failedCommand(sending, error);
        await this.#repository.putCommand(failed);
        if (failed.state === 'retry_wait') this.#scheduleRetry(failed.retryAt);
        break;
      }
    }
  }

  async #normalizeEnqueueRequest<T>(
    scope: OfflineScope,
    request: EnqueueOfflineCommand<T>,
  ): Promise<{ payload: T; baseRevision: string | number | null }> {
    let baseRevision = request.baseRevision ?? null;
    let payload = request.payload;
    const entity = await this.#repository.getEntity(scope, this.#hooks.cacheEntityType(request), request.aggregateId);
    if (entity?.serverRevision != null && entity.serverRevision !== baseRevision) {
      const rebased = this.#executor.withServerRevision(
        { ...scope, ...request, payload, baseRevision } as OfflineCommand,
        entity.serverRevision,
      );
      baseRevision = entity.serverRevision;
      payload = rebased.payload as T;
    }
    return { payload, baseRevision };
  }

  async #updateCachedEntity(command: OfflineCommand, result: { serverRevision?: string | number; response?: unknown }) {
    const scope = { userId: command.userId, groupId: command.groupId };
    const entityType = this.#hooks.cacheEntityType(command);
    const cached = await this.#repository.getEntity(scope, entityType, command.aggregateId);
    if (!cached) return;
    const projected = this.#executor.projectEntity?.(command, cached, result);
    if (!projected && result.serverRevision === undefined) return;
    const updated = projected ?? { ...cached, fetchedAt: Date.now() };
    await this.#repository.putEntity({
      ...updated,
      entityType,
      serverRevision: result.serverRevision ?? updated.serverRevision,
    });
  }

  async #rebaseFollowingCommands(commands: OfflineCommand[], start: number, revision: string | number) {
    for (let index = start; index < commands.length; index++) {
      const rebased = this.#executor.withServerRevision(commands[index]!, revision);
      commands[index] = rebased;
      await this.#repository.replaceCommand(rebased);
    }
  }

  #failedCommand(command: OfflineCommand, error: unknown): OfflineCommand {
    const status = this.#errorStatus(error);
    if (status === 401 || status === 403) return { ...command, state: 'blocked_auth', lastErrorCode: String(status) };
    if (status === 409 || status === 412) return { ...command, state: 'conflict', lastErrorCode: String(status) };
    if (status >= 400 && status < 500 && status !== 429) {
      return { ...command, state: 'rejected', lastErrorCode: String(status) };
    }
    const retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, command.attempts - 1));
    return { ...command, state: 'retry_wait', retryAt, lastErrorCode: status > 0 ? String(status) : 'network' };
  }

  #errorStatus(error: unknown): number {
    if (typeof error !== 'object' || error === null) return 0;
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : 0;
  }

  async #discoverScopes(): Promise<void> {
    const session = await this.#context.getSession();
    if (!session) {
      this.#activeUserId = null;
      this.#knownScopes.clear();
      return;
    }
    this.#setActiveUser(session.userId);
    this.#knownScopes.clear();
    for (const scope of session.scopes) this.#knownScopes.set(this.#scopeKey(scope), scope);
  }

  #setActiveUser(userId: number): void {
    if (this.#activeUserId === userId) return;
    this.#knownScopes.clear();
    this.#activeUserId = userId;
  }

  async #readKnownCommands(): Promise<OfflineCommand[]> {
    return (await Promise.all([...this.#knownScopes.values()].map((scope) => this.#repository.getCommands(scope))))
      .flat()
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async #refreshState(): Promise<void> {
    const commands = await this.#readKnownCommands();
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
        if (this.#network.connected()) void this.flush();
      },
      Math.max(0, retryAt - Date.now()),
    );
  }

  async #payloadHash(payload: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.#canonicalJson(payload)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  #canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.#canonicalJson(item)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.#canonicalJson(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  #scopeKey(scope: OfflineScope): string {
    return `${scope.userId}:${scope.groupId}`;
  }
}
