import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';

describe('OfflineReplicaMutationCoordinator', () => {
  it('serializes local apply sections and releases the lane after failure', async () => {
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const first = coordinator.run(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = coordinator.run(async () => {
      order.push('second');
      throw new Error('apply failed');
    });
    const third = coordinator.run(async () => order.push('third'));

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    release();
    await first;
    await expect(second).rejects.toThrow('apply failed');
    await third;
    await coordinator.drain();

    expect(order).toEqual(['first:start', 'first:end', 'second', 'third']);
  });
});
