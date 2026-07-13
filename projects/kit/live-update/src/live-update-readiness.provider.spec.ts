import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { ReplaySubject, Subject } from 'rxjs';
import { provideLiveUpdateReadiness } from './live-update-readiness.provider';

const { ready } = vi.hoisted(() => ({ ready: vi.fn() }));

vi.mock('@capawesome/capacitor-live-update', () => ({ LiveUpdate: { ready } }));

describe('provideLiveUpdateReadiness', () => {
  const flushFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

  afterEach(() => {
    ready.mockReset();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('marks a native bundle ready after Angular is stable and navigation completes', async () => {
    const stable = new ReplaySubject<boolean>(1);
    const routerEvents = new Subject<unknown>();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    ready.mockResolvedValue({
      previousBundleId: null,
      currentBundleId: null,
      rollback: false,
    });
    TestBed.configureTestingModule({
      providers: [
        provideLiveUpdateReadiness(),
        { provide: ApplicationRef, useValue: { isStable: stable } },
        { provide: Router, useValue: { events: routerEvents } },
      ],
    });
    TestBed.inject(ApplicationRef);

    stable.next(true);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();

    routerEvents.next(new NavigationEnd(1, '/', '/'));
    await flushFrame();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('does not initialize Live Update on the web', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    ready.mockResolvedValue({
      previousBundleId: null,
      currentBundleId: null,
      rollback: false,
    });
    TestBed.configureTestingModule({ providers: [provideLiveUpdateReadiness()] });
    TestBed.inject(ApplicationRef);
    expect(ready).not.toHaveBeenCalled();
  });
});
