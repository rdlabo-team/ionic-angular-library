import { computed, ErrorHandler, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { OFFLINE_KIT_OPTIONS, type OfflineMutationPersistenceAdapter } from './offline-kit-options';
import { OfflineMutationAdmissionService } from './offline-mutation-admission.service';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineSyncService } from './offline-sync.service';

/** Raised when disabling requires pending commands to be synchronized while transport is offline. */
export class OfflineMutationPersistenceRequiresOnlineError extends Error {
  constructor() {
    super('Pending offline mutations must be synchronized before persistence can be disabled.');
    this.name = 'OfflineMutationPersistenceRequiresOnlineError';
  }
}

/** Raised when pending commands remain after the disable transition attempted a flush. */
export class OfflineMutationPersistencePendingError extends Error {
  constructor(readonly pendingCount: number) {
    super('Pending offline mutations remain after synchronization.');
    this.name = 'OfflineMutationPersistencePendingError';
  }
}

type OfflineMutationPersistenceState = 'initializing' | 'enabled' | 'disabling' | 'disabled';

const settledMutationPersistence = async (): Promise<void> => undefined;

function invokeMutationPersistence<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(operation()));
}

function reportMutationPersistenceError(errorHandler: ErrorHandler, error: unknown): void {
  try {
    errorHandler.handleError(error);
  } catch {
    // Preference failure already degraded safely to disabled. Telemetry must not stop bootstrap.
  }
}

/** Read-only mutation admission signal consumed by the HTTP interceptor. */
export const OFFLINE_MUTATION_PERSISTENCE_ENABLED = new InjectionToken<() => boolean>('OFFLINE_MUTATION_PERSISTENCE_ENABLED', {
  factory: () => () => true,
});

/** Product adapter used by Kit to persist the device-local mutation preference. */
export const OFFLINE_MUTATION_PERSISTENCE_ADAPTER = new InjectionToken<OfflineMutationPersistenceAdapter | null>(
  'OFFLINE_MUTATION_PERSISTENCE_ADAPTER',
  { factory: () => null },
);

/** Controls whether Kit accepts new durable mutations while leaving replica reads enabled. */
@Injectable({ providedIn: 'root' })
export class OfflineMutationPersistenceService {
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  readonly #errorHandler = inject(ErrorHandler);
  readonly #persistence = inject(OFFLINE_MUTATION_PERSISTENCE_ADAPTER);
  readonly #network = inject(OfflineNetworkService);
  readonly #sync = inject(OfflineSyncService);
  readonly #admission = inject(OfflineMutationAdmissionService);
  readonly #configured = this.#options.mode !== 'readCacheOnly' && this.#options.mutationPersistence !== undefined;
  readonly #state = signal<OfflineMutationPersistenceState>(this.#configured ? 'initializing' : 'enabled');
  #initializePromise: Promise<void> | null = null;
  #transitionTail: Promise<void> = settledMutationPersistence();
  #transitionRevision = 0;
  #persistedEnabled = !this.#configured;
  #latestTransition: { enabled: boolean; promise: Promise<void>; revision: number } | null = null;

  /** Whether the product configured a device-local mutation persistence preference. */
  readonly available = this.#configured;
  /** Whether new durable Outbox mutations are currently accepted. */
  readonly enabled = computed(() => this.#state() === 'enabled');
  /** Whether Kit is draining accepted and pending mutations before disabling. */
  readonly changing = computed(() => this.#state() === 'disabling');

  /** Loads the durable preference before Kit initializes repository-backed services. */
  async initialize(): Promise<void> {
    if (!this.#configured) {
      this.#admission.open();
      return;
    }
    await (this.#initializePromise ??= this.#loadInitialPreference());
  }

  /**
   * Enables or disables new durable mutations.
   *
   * Disabling closes admission synchronously, waits for already admitted commits,
   * flushes existing commands, verifies an empty Outbox, and only then persists OFF.
   */
  setEnabled(enabled: boolean): Promise<void> {
    if (!this.#configured) return settledMutationPersistence();
    const initialization = this.initialize();
    const latest = this.#latestTransition;
    if (latest?.enabled === enabled) return latest.promise;
    if (!latest && ((enabled && this.#state() === 'enabled') || (!enabled && this.#state() === 'disabled'))) {
      return settledMutationPersistence();
    }

    const revision = ++this.#transitionRevision;
    if (!enabled) {
      this.#state.set('disabling');
      void this.#admission.close();
    }
    const transition = this.#transitionTail.then(() => initialization).then(() => this.#applyTransition(enabled, revision));
    this.#transitionTail = transition.catch(() => undefined);
    const promise = transition.finally(() => {
      if (this.#latestTransition?.revision === revision) this.#latestTransition = null;
    });
    this.#latestTransition = { enabled, promise, revision };
    return promise;
  }

  async #loadInitialPreference(): Promise<void> {
    const persistence = this.#requiredPersistence();
    return invokeMutationPersistence(() => persistence.loadEnabled()).then(
      (stored) => {
        this.#persistedEnabled = stored ?? this.#options.mutationPersistence?.defaultEnabled ?? true;
        if (this.#transitionRevision === 0) {
          this.#state.set(this.#persistedEnabled ? 'enabled' : 'disabled');
          if (this.#persistedEnabled) this.#admission.open();
        }
      },
      async (error: unknown) => {
        this.#persistedEnabled = false;
        if (this.#transitionRevision === 0) this.#state.set('disabled');
        await this.#admission.close();
        reportMutationPersistenceError(this.#errorHandler, error);
      },
    );
  }

  #applyTransition(enabled: boolean, revision: number): Promise<void> {
    if (revision !== this.#transitionRevision) return settledMutationPersistence();
    const transition = enabled ? this.#enable(revision) : this.#disable(revision);
    return transition.catch((error: unknown) => {
      if (revision === this.#transitionRevision) {
        this.#state.set(this.#persistedEnabled ? 'enabled' : 'disabled');
        if (this.#persistedEnabled) this.#admission.open();
      }
      return Promise.reject(error);
    });
  }

  async #enable(revision: number): Promise<void> {
    await this.#requiredPersistence().saveEnabled(true);
    this.#persistedEnabled = true;
    if (revision !== this.#transitionRevision) return;
    this.#state.set('enabled');
    this.#admission.open();
  }

  async #disable(revision: number): Promise<void> {
    await this.#admission.close();
    if (revision !== this.#transitionRevision) return;
    const pendingBeforeFlush = this.#sync.pendingCount();
    if (pendingBeforeFlush > 0) {
      if (this.#network.state() === 'offline') throw new OfflineMutationPersistenceRequiresOnlineError();
      await this.#sync.flush();
    }
    if (revision !== this.#transitionRevision) return;
    const pendingCount = this.#sync.pendingCount();
    if (pendingCount > 0) throw new OfflineMutationPersistencePendingError(pendingCount);
    await this.#requiredPersistence().saveEnabled(false);
    this.#persistedEnabled = false;
    if (revision === this.#transitionRevision) this.#state.set('disabled');
  }

  #requiredPersistence(): OfflineMutationPersistenceAdapter {
    if (!this.#persistence) throw new Error('Offline mutation persistence adapter is not provided.');
    return this.#persistence;
  }
}
