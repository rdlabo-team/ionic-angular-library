import { DOCUMENT } from '@angular/common';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate } from '@angular/service-worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitAppUpdateService, provideKitAppUpdate } from './kit-app-update.provider';

describe('provideKitAppUpdate', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reloads directly into a complete update before startup continues', async () => {
    const { service, checkForUpdate, reload } = setup(true);

    await service.initialize();

    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not reload when the installed version is current', async () => {
    const { service, checkForUpdate, reload } = setup(false);

    await service.initialize();

    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when Angular service workers are disabled', async () => {
    const { service, checkForUpdate, reload } = setup(false, false);

    await service.initialize();

    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not delay startup when no service worker controls the page', async () => {
    const { service, checkForUpdate, reload } = setup(new Promise<boolean>(() => undefined), true, false);

    await expect(service.initialize()).resolves.toBeUndefined();

    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('continues startup without reloading when the update check fails', async () => {
    const error = new Error('offline');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service, checkForUpdate, reload } = setup(error);

    await expect(service.initialize()).resolves.toBeUndefined();

    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Angular service-worker update check failed', error);
  });

  it('continues startup after ten seconds when the update server does not respond', async () => {
    vi.useFakeTimers();
    const { service, reload } = setup(new Promise<boolean>(() => undefined));
    const initialization = service.initialize();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(initialization).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('shares one update check across repeated initialization', async () => {
    const { service, checkForUpdate } = setup(false);

    await Promise.all([service.initialize(), service.initialize()]);

    expect(checkForUpdate).toHaveBeenCalledOnce();
  });
});

function setup(result: boolean | Error | Promise<boolean>, isEnabled = true, isControlled = true) {
  const checkForUpdate = vi.fn(() =>
    result instanceof Promise ? result : result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideKitAppUpdate(),
      { provide: SwUpdate, useValue: { isEnabled, checkForUpdate } },
      {
        provide: DOCUMENT,
        useValue: {
          defaultView: { navigator: { serviceWorker: { controller: isControlled ? {} : null } } },
          location: { reload },
        },
      },
    ],
  });
  return { service: TestBed.inject(KitAppUpdateService), checkForUpdate, reload };
}
