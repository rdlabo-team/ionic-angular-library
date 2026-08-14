import { ErrorHandler, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_KIT_OPTIONS, type OfflineKitOptions } from './offline-kit-options';
import { OfflineMutationAdmissionService, OfflineMutationPersistenceDisabledError } from './offline-mutation-admission.service';
import {
  OFFLINE_MUTATION_PERSISTENCE_ADAPTER,
  OfflineMutationPersistencePendingError,
  OfflineMutationPersistenceRequiresOnlineError,
  OfflineMutationPersistenceService,
} from './offline-mutation-persistence.service';
import { OfflineNetworkService } from './offline-network.service';
import { OfflineSyncService } from './offline-sync.service';

describe('OfflineMutationPersistenceService', () => {
  const networkState = signal<'online' | 'offline'>('online');
  const pendingCount = signal(0);
  const flush = vi.fn(async () => undefined);
  const handleError = vi.fn();

  beforeEach(() => {
    TestBed.resetTestingModule();
    networkState.set('online');
    pendingCount.set(0);
    flush.mockReset();
    handleError.mockReset();
  });

  it('keeps historical always-enabled admission when no preference adapter is configured', async () => {
    const { service, admission } = setup({ databaseName: 'test', replicaSchema: {} as never });

    await service.initialize();

    expect(service.available).toBe(false);
    expect(service.enabled()).toBe(true);
    await expect(admission.run(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('loads a durable OFF preference before opening admission', async () => {
    const loadEnabled = vi.fn(async () => false);
    const { service, admission } = setup(options(loadEnabled, vi.fn()));

    await service.initialize();

    expect(service.enabled()).toBe(false);
    await expect(admission.run(async () => undefined)).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
  });

  it('uses the configured default when no durable preference exists', async () => {
    const { service } = setup(options(async () => null, vi.fn(), false));

    await service.initialize();

    expect(service.enabled()).toBe(false);
  });

  it('reports preference loading failure and continues with admission fail-closed', async () => {
    const failure = new Error('settings unavailable');
    const { service, admission } = setup(options(async () => Promise.reject(failure), vi.fn()));

    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.enabled()).toBe(false);
    expect(handleError).toHaveBeenCalledExactlyOnceWith(failure);
    await expect(admission.run(async () => undefined)).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
  });

  it('applies a latest enable after a deferred initial OFF load without state/admission divergence', async () => {
    let releaseLoad!: (enabled: boolean) => void;
    const loadEnabled = vi.fn(() => new Promise<boolean>((resolve) => (releaseLoad = resolve)));
    const saveEnabled = vi.fn(async () => undefined);
    const { service, admission } = setup(options(loadEnabled, saveEnabled));

    const initializing = service.initialize();
    const enabling = service.setEnabled(true);
    releaseLoad(false);
    await Promise.all([initializing, enabling]);

    expect(saveEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.enabled()).toBe(true);
    await expect(admission.run(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('keeps admission closed when latest disable crosses a deferred initial ON load', async () => {
    let releaseLoad!: (enabled: boolean) => void;
    const loadEnabled = vi.fn(() => new Promise<boolean>((resolve) => (releaseLoad = resolve)));
    const saveEnabled = vi.fn(async () => undefined);
    const { service, admission } = setup(options(loadEnabled, saveEnabled));

    const initializing = service.initialize();
    const disabling = service.setEnabled(false);
    releaseLoad(true);
    await Promise.all([initializing, disabling]);

    expect(saveEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(service.enabled()).toBe(false);
    await expect(admission.run(async () => undefined)).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
  });

  it('applies a latest enable after initial load failure is reported', async () => {
    let rejectLoad!: (error: unknown) => void;
    const failure = new Error('settings unavailable');
    const loadEnabled = vi.fn(() => new Promise<boolean>((_resolve, reject) => (rejectLoad = reject)));
    const saveEnabled = vi.fn(async () => undefined);
    const { service, admission } = setup(options(loadEnabled, saveEnabled));

    const initializing = service.initialize();
    const enabling = service.setEnabled(true);
    rejectLoad(failure);
    await Promise.all([initializing, enabling]);

    expect(handleError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(saveEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.enabled()).toBe(true);
    await expect(admission.run(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('closes admission, waits for accepted work, flushes, then persists OFF', async () => {
    const saveEnabled = vi.fn(async () => undefined);
    const { service, admission } = setup(options(async () => true, saveEnabled));
    await service.initialize();
    let release!: () => void;
    const accepted = admission.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    pendingCount.set(1);
    flush.mockImplementationOnce(async () => {
      pendingCount.set(0);
    });

    const disabling = service.setEnabled(false);
    await expect(admission.run(async () => undefined)).rejects.toBeInstanceOf(OfflineMutationPersistenceDisabledError);
    expect(flush).not.toHaveBeenCalled();
    release();
    await accepted;
    await disabling;

    expect(flush).toHaveBeenCalledOnce();
    expect(saveEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(service.enabled()).toBe(false);
  });

  it('reopens admission when an offline disable with pending commands fails', async () => {
    const { service, admission } = setup(options(async () => true, vi.fn()));
    await service.initialize();
    networkState.set('offline');
    pendingCount.set(1);

    await expect(service.setEnabled(false)).rejects.toBeInstanceOf(OfflineMutationPersistenceRequiresOnlineError);

    expect(service.enabled()).toBe(true);
    await expect(admission.run(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('does not persist OFF when commands remain after flush', async () => {
    const saveEnabled = vi.fn(async () => undefined);
    const { service } = setup(options(async () => true, saveEnabled));
    await service.initialize();
    pendingCount.set(2);

    await expect(service.setEnabled(false)).rejects.toEqual(new OfflineMutationPersistencePendingError(2));

    expect(saveEnabled).not.toHaveBeenCalled();
    expect(service.enabled()).toBe(true);
  });

  it('honors a latest disable requested while the preceding enable write is in flight', async () => {
    let releaseEnable!: () => void;
    const writes: boolean[] = [];
    const saveEnabled = vi.fn(
      (enabled: boolean) =>
        new Promise<void>((resolve) => {
          writes.push(enabled);
          if (enabled) releaseEnable = resolve;
          else resolve();
        }),
    );
    const { service } = setup(options(async () => false, saveEnabled));
    await service.initialize();

    const enabling = service.setEnabled(true);
    await vi.waitFor(() => expect(writes).toEqual([true]));
    const disabling = service.setEnabled(false);
    releaseEnable();
    await Promise.all([enabling, disabling]);

    expect(writes).toEqual([true, false]);
    expect(service.enabled()).toBe(false);
  });

  function setup(kitOptions: OfflineKitOptions): {
    service: OfflineMutationPersistenceService;
    admission: OfflineMutationAdmissionService;
  } {
    const adapter = kitOptions.mutationPersistence?.adapter;
    TestBed.configureTestingModule({
      providers: [
        OfflineMutationPersistenceService,
        OfflineMutationAdmissionService,
        { provide: OFFLINE_KIT_OPTIONS, useValue: kitOptions },
        { provide: OfflineNetworkService, useValue: { state: networkState } },
        { provide: OfflineSyncService, useValue: { pendingCount, flush } },
        { provide: ErrorHandler, useValue: { handleError } },
        ...(adapter ? [adapter, { provide: OFFLINE_MUTATION_PERSISTENCE_ADAPTER, useExisting: adapter }] : []),
      ],
    });
    return {
      service: TestBed.inject(OfflineMutationPersistenceService),
      admission: TestBed.inject(OfflineMutationAdmissionService),
    };
  }

  function options(
    loadEnabled: () => Promise<boolean | null | undefined>,
    saveEnabled: (enabled: boolean) => Promise<void>,
    defaultEnabled = true,
  ): OfflineKitOptions {
    class TestMutationPersistenceAdapter {
      loadEnabled = loadEnabled;
      saveEnabled = saveEnabled;
    }
    return {
      databaseName: 'test',
      replicaSchema: {} as never,
      mutationPersistence: { adapter: TestMutationPersistenceAdapter, defaultEnabled },
    };
  }
});
