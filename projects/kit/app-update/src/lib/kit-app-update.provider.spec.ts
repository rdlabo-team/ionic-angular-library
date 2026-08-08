import { ApplicationRef, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DOCUMENT } from '@angular/common';
import { SwUpdate } from '@angular/service-worker';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { KitAppUpdateService, provideKitAppUpdate } from './kit-app-update.provider';

describe('provideKitAppUpdate', () => {
  it('activates a complete update and reloads once after startup becomes stable', async () => {
    const stable = new BehaviorSubject(false);
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const activateUpdate = vi.fn().mockResolvedValue(true);
    const reload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAppUpdate(),
        { provide: ApplicationRef, useValue: { isStable: stable } },
        { provide: SwUpdate, useValue: { isEnabled: true, checkForUpdate, activateUpdate } },
        { provide: DOCUMENT, useValue: { location: { reload } } },
      ],
    });

    TestBed.inject(KitAppUpdateService);
    expect(checkForUpdate).not.toHaveBeenCalled();
    stable.next(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(activateUpdate).toHaveBeenCalledOnce();
  });

  it('does not reload when the installed version is current', async () => {
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const activateUpdate = vi.fn();
    const reload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAppUpdate(),
        { provide: ApplicationRef, useValue: { isStable: new BehaviorSubject(true) } },
        { provide: SwUpdate, useValue: { isEnabled: true, checkForUpdate, activateUpdate } },
        { provide: DOCUMENT, useValue: { location: { reload } } },
      ],
    });

    TestBed.inject(KitAppUpdateService);
    await vi.waitFor(() => expect(checkForUpdate).toHaveBeenCalledOnce());
    expect(activateUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
