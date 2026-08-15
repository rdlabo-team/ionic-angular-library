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

  it('serializes external reads between mutations and holds the lane until the read settles', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: OFFLINE_REPOSITORY, useValue: {} }],
    });
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => (releaseMutation = resolve));
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
    const order: string[] = [];

    const mutation = coordinator.run(async () => {
      order.push('mutation:start');
      await mutationGate;
      order.push('mutation:end');
    });
    const read = coordinator.runSerializedRead(async () => {
      order.push('read:start');
      await readGate;
      order.push('read:end');
      return 'snapshot';
    });
    const nextMutation = coordinator.run(async () => order.push('next-mutation'));

    await vi.waitFor(() => expect(order).toEqual(['mutation:start']));
    releaseMutation();
    await mutation;
    await vi.waitFor(() => expect(order).toEqual(['mutation:start', 'mutation:end', 'read:start']));
    expect(order).not.toContain('next-mutation');

    releaseRead();
    await expect(read).resolves.toBe('snapshot');
    await nextMutation;
    await coordinator.drain();

    expect(order).toEqual(['mutation:start', 'mutation:end', 'read:start', 'read:end', 'next-mutation']);
  });

  it('runs a queued read after a preceding mutation rejects', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: OFFLINE_REPOSITORY, useValue: {} }] });
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    const mutation = coordinator.run(async () => Promise.reject(new Error('mutation failed')));
    const read = coordinator.runSerializedRead(async () => 'recovered');

    await expect(mutation).rejects.toThrow('mutation failed');
    await expect(read).resolves.toBe('recovered');
  });

  it('releases the lane for a later mutation after a serialized read rejects', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: OFFLINE_REPOSITORY, useValue: {} }] });
    const coordinator = TestBed.inject(OfflineReplicaMutationCoordinator);
    const order: string[] = [];
    const read = coordinator.runSerializedRead(async () => {
      order.push('read');
      throw new Error('read failed');
    });
    const mutation = coordinator.run(async () => order.push('mutation'));

    await expect(read).rejects.toThrow('read failed');
    await mutation;
    expect(order).toEqual(['read', 'mutation']);
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
