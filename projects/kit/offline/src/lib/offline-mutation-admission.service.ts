import { inject, Injectable } from '@angular/core';
import { OFFLINE_KIT_OPTIONS } from './offline-kit-options';

/** Raised when a new durable mutation reaches Kit after mutation persistence was closed. */
export class OfflineMutationPersistenceDisabledError extends Error {
  constructor() {
    super('Offline mutation persistence was disabled before the mutation could be accepted.');
    this.name = 'OfflineMutationPersistenceDisabledError';
  }
}

/** Product-independent lease gate around every new durable Outbox command. */
@Injectable({ providedIn: 'root' })
export class OfflineMutationAdmissionService {
  readonly #options = inject(OFFLINE_KIT_OPTIONS);
  #accepting = this.#options.mutationPersistence === undefined;
  #active = 0;
  #idle: Promise<void> | null = null;
  #resolveIdle: (() => void) | null = null;

  get accepting(): boolean {
    return this.#accepting;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) throw new OfflineMutationPersistenceDisabledError();
    this.#active += 1;
    return new Promise<T>((resolve) => resolve(operation())).finally(() => this.#release());
  }

  open(): void {
    this.#accepting = true;
  }

  async close(): Promise<void> {
    this.#accepting = false;
    if (this.#active === 0) return;
    if (!this.#idle) {
      this.#idle = new Promise<void>((resolve) => {
        this.#resolveIdle = resolve;
      });
    }
    return this.#idle;
  }

  #release(): void {
    this.#active -= 1;
    if (this.#active !== 0) return;
    this.#resolveIdle?.();
    this.#idle = null;
    this.#resolveIdle = null;
  }
}
