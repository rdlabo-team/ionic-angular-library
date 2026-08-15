import { ApplicationInitStatus, ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineCoordinatorService } from './offline-coordinator.service';
import { provideOffline } from './offline-provider';
import { defineOfflineReplicaSchema } from './offline-replica-schema';

describe('provideOffline', () => {
  afterEach(() => TestBed.resetTestingModule());

  const runInitializers = (status: ApplicationInitStatus): void =>
    (status as unknown as { runInitializers(): void }).runInitializers();

  function setup(coordinator: Pick<OfflineCoordinatorService, 'initialize' | 'initializeLocal'>) {
    const handleError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideOffline({
          mode: 'readCacheOnly',
          databaseName: 'provider-test',
          createEncryptionKey: async () => 'test-key',
          replicaSchema: defineOfflineReplicaSchema({ version: 1, entities: [], migrations: [] }),
          requestPolicies: [],
        }),
        { provide: OfflineCoordinatorService, useValue: coordinator },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    return { applicationInit: TestBed.inject(ApplicationInitStatus), handleError };
  }

  it('starts runtime initialization immediately but gates bootstrap only on the local substrate', async () => {
    let releaseLocal: (() => void) | undefined;
    let releaseRuntime: (() => void) | undefined;
    const local = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    const runtime = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const coordinator = {
      initialize: vi.fn(() => runtime),
      initializeLocal: vi.fn(() => local),
    };
    const { applicationInit } = setup(coordinator);

    runInitializers(applicationInit);
    expect(coordinator.initialize).toHaveBeenCalledOnce();
    expect(coordinator.initializeLocal).toHaveBeenCalledOnce();
    expect(applicationInit.done).toBe(false);

    releaseLocal?.();
    await applicationInit.donePromise;
    expect(applicationInit.done).toBe(true);

    releaseRuntime?.();
    await runtime;
  });

  it('reports background runtime failure without failing local bootstrap', async () => {
    let rejectRuntime: ((error: Error) => void) | undefined;
    const runtime = new Promise<void>((_resolve, reject) => {
      rejectRuntime = reject;
    });
    const coordinator = {
      initialize: vi.fn(() => runtime),
      initializeLocal: vi.fn(async () => undefined),
    };
    const { applicationInit, handleError } = setup(coordinator);
    const failure = new Error('network initialization failed');

    runInitializers(applicationInit);
    rejectRuntime?.(failure);
    await applicationInit.donePromise;
    await runtime.catch(() => undefined);

    expect(handleError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('leaves local initialization failures to the bootstrap error boundary', async () => {
    const failure = new Error('local storage unavailable');
    const local = Promise.reject(failure);
    const coordinator = {
      initialize: vi.fn(() => local),
      initializeLocal: vi.fn(() => local),
    };
    const { applicationInit, handleError } = setup(coordinator);

    runInitializers(applicationInit);
    await expect(applicationInit.donePromise).rejects.toBe(failure);

    expect(handleError).not.toHaveBeenCalled();
  });

  it('does not turn a reporting failure into an unhandled background rejection', async () => {
    const failure = new Error('network initialization failed');
    const reportingFailure = new Error('reporting failed');
    const coordinator = {
      initialize: vi.fn(async () => Promise.reject(failure)),
      initializeLocal: vi.fn(async () => undefined),
    };
    const { applicationInit, handleError } = setup(coordinator);
    handleError.mockImplementationOnce(() => {
      throw reportingFailure;
    });

    runInitializers(applicationInit);
    await applicationInit.donePromise;
    await vi.waitFor(() => expect(handleError).toHaveBeenCalledExactlyOnceWith(failure));

    expect(handleError).toHaveBeenCalledOnce();
  });
});
