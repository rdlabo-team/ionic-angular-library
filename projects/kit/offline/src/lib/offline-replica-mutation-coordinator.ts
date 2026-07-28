import { Injectable } from '@angular/core';

/**
 * Serializes only local replica read/derive/write critical sections. Network
 * transport must stay outside this coordinator so synchronization never holds
 * the local mutation lane while waiting on I/O.
 */
@Injectable({ providedIn: 'root' })
export class OfflineReplicaMutationCoordinator {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const mutation = this.#tail.then(operation);
    this.#tail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}
