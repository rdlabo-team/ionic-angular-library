import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { OfflineReplicaMutationCoordinator } from './offline-replica-mutation-coordinator';
import { OFFLINE_REPOSITORY_ATOMIC_MUTATION } from './offline-repository-concurrency';
import { OFFLINE_REPOSITORY, type OfflineRepository } from './offline-repository';

describe('OfflineReplicaMutationCoordinator', () => {
  it('serializes local apply sections and releases the lane after failure', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: OFFLINE_REPOSITORY, useValue: {} }],
    });
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

  it('uses the repository atomic-mutation capability without retrying the product operation', async () => {
    const repository = { getCommands: vi.fn() };
    const atomicMutation = vi.fn(async (operation: (owner: typeof repository) => Promise<string>) => operation(repository));
    TestBed.configureTestingModule({
      providers: [{ provide: OFFLINE_REPOSITORY, useValue: { ...repository, [OFFLINE_REPOSITORY_ATOMIC_MUTATION]: atomicMutation } }],
    });
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    const operation = vi.fn(async (_owner: OfflineRepository) => 'done');

    await expect(coordinator.run((owner) => operation(owner))).resolves.toBe('done');
    expect(operation).toHaveBeenCalledWith(repository);

    expect(atomicMutation).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
  });
});
