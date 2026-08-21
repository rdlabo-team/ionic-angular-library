import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { NavController } from '@ionic/angular';
import type { Observable } from 'rxjs';
import { of, Subject } from 'rxjs';
import { throwError } from 'rxjs';
import { firstValueFrom } from 'rxjs';

import {
  type KitAuthGuardState,
  type KitAuthState,
  provideKitAuth,
  kitRequiredUnauthorizedGuard,
  kitRequireConfirmingGuard,
  kitRequireAuthorizedGuard,
} from './auth-guards';
import { KitAuthAccessService, type KitAuthAccessLease, type KitRemoteAccessRecovery } from './auth-access.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const REDIRECTS = {
  whenAuthorized: '/home',
  whenConfirming: '/auth/confirm',
  whenNotConfirming: '/auth/signin',
  whenUnauthorized: '/auth',
};

const routeStub = {} as ActivatedRouteSnapshot;
const stateStub = {} as RouterStateSnapshot;

/**
 * The guards always return an Observable at runtime (rxjs pipe).
 * CanActivateFn returns `MaybeAsync<GuardResult>` which widens the compile-time type,
 * so we cast to Observable before handing to firstValueFrom.
 */
function runGuard(value: unknown): Promise<boolean | UrlTree> {
  return firstValueFrom(value as Observable<boolean | UrlTree>);
}

/** Cast a vi.fn() mock so it satisfies a typed function signature. */
function mockFn<T>(): T {
  return vi.fn() as unknown as T;
}

function setup(
  state: KitAuthGuardState,
  {
    onAuthorized = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
    ) => Promise<boolean | UrlTree | KitRemoteAccessRecovery>,
    onUnauthenticated = vi.fn().mockResolvedValue(false) as unknown as (
      s: RouterStateSnapshot,
    ) => Promise<boolean | UrlTree | KitRemoteAccessRecovery>,
    onUnavailable = vi.fn().mockResolvedValue(false) as unknown as (s: RouterStateSnapshot, error?: unknown) => Promise<boolean | UrlTree>,
    isUnavailableError = vi.fn().mockReturnValue(false) as unknown as (error: unknown) => boolean,
    authState = () => of(state),
  }: {
    onAuthorized?: (s: RouterStateSnapshot) => Promise<boolean | UrlTree | KitRemoteAccessRecovery>;
    onUnauthenticated?: (s: RouterStateSnapshot) => Promise<boolean | UrlTree | KitRemoteAccessRecovery>;
    onUnavailable?: (s: RouterStateSnapshot, error?: unknown) => Promise<boolean | UrlTree>;
    isUnavailableError?: (error: unknown) => boolean;
    authState?: () => Observable<KitAuthGuardState>;
  } = {},
) {
  const navigate = vi.fn().mockResolvedValue(true);
  const setDirection = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideKitAuth(() => ({
        authState,
        onAuthorized,
        onUnauthenticated,
        onUnavailable,
        isUnavailableError,
        redirects: REDIRECTS,
      })),
      { provide: Router, useValue: { navigate } },
      { provide: NavController, useValue: { setDirection } },
    ],
  });

  return { navigate, setDirection, onAuthorized, onUnauthenticated, onUnavailable, isUnavailableError };
}

// ---------------------------------------------------------------------------
// kitRequiredUnauthorizedGuard
// ---------------------------------------------------------------------------
describe('kitRequiredUnauthorizedGuard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("'user' → navigates whenAuthorized and returns false", async () => {
    const { navigate, setDirection } = setup('user');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).toHaveBeenCalledWith('root');
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenAuthorized]);
  });

  it("'confirm' → navigates whenConfirming and returns false (no setDirection)", async () => {
    const { navigate, setDirection } = setup('confirm');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenConfirming]);
  });

  it("'required' → returns true", async () => {
    setup('required');
    TestBed.inject(KitAuthAccessService).grantLocal();
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('none');
  });

  it("'anonymous' → returns true", async () => {
    setup('anonymous');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
  });

  it('does not let a stale auth-page guard clear or redirect a newer identity', async () => {
    const authState = new Subject<KitAuthGuardState>();
    const { navigate } = setup('required', { authState: () => authState });
    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    const access = TestBed.inject(KitAuthAccessService);
    access.beginTransition();
    access.grantRemote();

    authState.next('required');

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('remote');
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// kitRequireConfirmingGuard
// ---------------------------------------------------------------------------
describe('kitRequireConfirmingGuard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("'confirm' → returns true", async () => {
    setup('confirm');
    TestBed.inject(KitAuthAccessService).grantRemote();
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('none');
  });

  it("'anonymous' → navigates whenAuthorized and returns false", async () => {
    const { navigate, setDirection } = setup('anonymous');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).toHaveBeenCalledWith('root');
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenAuthorized]);
  });

  it("'required' → navigates whenNotConfirming and returns false", async () => {
    const { navigate, setDirection } = setup('required');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).toHaveBeenCalledWith('root');
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenNotConfirming]);
  });

  it("'user' → navigates whenNotConfirming and returns false", async () => {
    const { navigate, setDirection } = setup('user');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).toHaveBeenCalledWith('root');
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenNotConfirming]);
  });

  it('does not let a stale confirming guard clear or redirect a newer identity', async () => {
    const authState = new Subject<KitAuthGuardState>();
    const { navigate } = setup('confirm', { authState: () => authState });
    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    const access = TestBed.inject(KitAuthAccessService);
    access.beginTransition();
    access.grantRemote();

    authState.next('confirm');

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('remote');
    expect(navigate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// kitRequireAuthorizedGuard
// ---------------------------------------------------------------------------
describe('kitRequireAuthorizedGuard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("'user' → calls onAuthorized with state and returns its value (true)", async () => {
    const onAuthorized = vi.fn().mockResolvedValue(true) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('user', { onAuthorized });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(onAuthorized).toHaveBeenCalledWith(stateStub, expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('remote');
  });

  it("'user' → propagates UrlTree from onAuthorized", async () => {
    const urlTree = { queryParams: {} } as unknown as UrlTree;
    const onAuthorized = vi.fn().mockResolvedValue(urlTree) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('user', { onAuthorized });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(urlTree);
  });

  it("'user' → publishes remote access between phased activation and transport resume", async () => {
    const order: string[] = [];
    const onAuthorized = vi.fn(async () => ({
      activate: async () => {
        order.push('activate');
        return true;
      },
      resume: async () => void order.push(`resume:${TestBed.inject(KitAuthAccessService).mode}`),
    }));
    setup('user', { onAuthorized });

    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));

    expect(result).toBe(true);
    expect(order).toEqual(['activate', 'resume:remote']);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('remote');
  });

  it("'user' → invalidates the post-grant resume lease before stale user-visible effects", async () => {
    let markResumeStarted!: () => void;
    let releaseResume!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const navigateAfterResume = vi.fn();
    const onAuthorized = vi.fn(async () => ({
      activate: async () => true,
      resume: async (lease?: KitAuthAccessLease) => {
        markResumeStarted();
        await resumeGate;
        if (lease?.isCurrent()) navigateAfterResume();
      },
    }));
    setup('user', { onAuthorized });

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    await resumeStarted;
    TestBed.inject(KitAuthAccessService).clear();
    releaseResume();

    await expect(pending).resolves.toBe(false);
    expect(navigateAfterResume).not.toHaveBeenCalled();
  });

  it("'user' → does not reclaim a transition started by a synchronous remote-mode subscriber", async () => {
    const navigateAfterResume = vi.fn();
    const resume = vi.fn(async (lease?: KitAuthAccessLease) => {
      if (lease?.isCurrent()) navigateAfterResume();
    });
    const onAuthorized = vi.fn(async () => ({
      activate: async () => true,
      resume,
    }));
    setup('user', { onAuthorized });
    const access = TestBed.inject(KitAuthAccessService);
    const subscription = access.mode$.subscribe((mode) => {
      if (mode === 'remote') access.clear();
    });

    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    subscription.unsubscribe();

    expect(result).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(navigateAfterResume).not.toHaveBeenCalled();
    expect(access.mode).toBe('none');
  });

  it("'user' → keeps verified remote access when only phased resume loses transport", async () => {
    const networkError = { status: 0 };
    const onAuthorized = vi.fn(async () => ({
      activate: async () => true,
      resume: async () => Promise.reject(networkError),
    }));
    setup('user', { onAuthorized, isUnavailableError: (error) => error === networkError });

    await expect(
      runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub))),
    ).resolves.toBe(true);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('remote');
  });

  it("'user' → classifies a synchronous phased resume failure as unavailable", async () => {
    const networkError = { status: 0 };
    const onAuthorized = vi.fn(async () => ({
      activate: async () => true,
      resume: () => {
        throw networkError;
      },
    }));
    setup('user', { onAuthorized, isUnavailableError: (error) => error === networkError });

    await expect(
      runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub))),
    ).resolves.toBe(true);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('remote');
  });

  it("'anonymous' → returns true without calling any hook", async () => {
    const onAuthorized = vi.fn() as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const onUnauthenticated = vi.fn() as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('anonymous', { onAuthorized, onUnauthenticated });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("'required' + onUnauthenticated → true → returns true (fallback allows)", async () => {
    const onUnauthenticated = vi.fn().mockResolvedValue(true) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('required', { onUnauthenticated });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
  });

  it("'required' + onUnauthenticated → UrlTree → passes UrlTree through", async () => {
    const urlTree = { queryParams: {} } as unknown as UrlTree;
    const onUnauthenticated = vi.fn().mockResolvedValue(urlTree) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('required', { onUnauthenticated });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(urlTree);
  });

  it("'required' + onUnauthenticated → false → navigates whenUnauthorized and returns false", async () => {
    const onUnauthenticated = vi.fn().mockResolvedValue(false) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const { navigate, setDirection } = setup('required', { onUnauthenticated });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(setDirection).toHaveBeenCalledWith('root');
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenUnauthorized]);
  });

  it("'confirm' + onUnauthenticated → false → navigates whenUnauthorized and returns false", async () => {
    const onUnauthenticated = vi.fn().mockResolvedValue(false) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const { navigate } = setup('confirm', { onUnauthenticated });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenUnauthorized]);
  });

  it("'unavailable' invokes only onUnavailable and allows local route access", async () => {
    const onUnavailable = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
      error?: unknown,
    ) => Promise<boolean | UrlTree>;
    const { onUnauthenticated } = setup('unavailable', { onUnavailable });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith(
      stateStub,
      undefined,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(onUnauthenticated).not.toHaveBeenCalled();
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('local');
  });

  it("'unavailable' + rejected local restore redirects without granting access", async () => {
    const onUnavailable = vi.fn().mockResolvedValue(false);
    const { navigate } = setup('unavailable', { onUnavailable });

    await expect(
      runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub))),
    ).resolves.toBe(false);
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenUnauthorized]);
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('none');
  });

  it("'required' never invokes the unavailable fallback", async () => {
    const onUnavailable = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
      error?: unknown,
    ) => Promise<boolean | UrlTree>;
    const { navigate } = setup('required', { onUnavailable });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenUnauthorized]);
  });

  it('classified onAuthorized transport failure invokes onUnavailable', async () => {
    const networkError = { status: 0 };
    const onAuthorized = vi.fn().mockRejectedValue(networkError) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const onUnavailable = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
      error?: unknown,
    ) => Promise<boolean | UrlTree>;
    setup('user', {
      onAuthorized,
      onUnavailable,
      isUnavailableError: (error) => error === networkError,
    });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith(
      stateStub,
      networkError,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('unclassified onAuthorized error propagates without local fallback', async () => {
    const unauthorized = { status: 401 };
    const onAuthorized = vi.fn().mockRejectedValue(unauthorized) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const onUnavailable = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
      error?: unknown,
    ) => Promise<boolean | UrlTree>;
    setup('user', { onAuthorized, onUnavailable, isUnavailableError: () => false });
    await expect(runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)))).rejects.toBe(unauthorized);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it.each([401, 403])('HTTP %i from onAuthorized never uses local fallback even with an overly broad classifier', async (status) => {
    const denial = { status };
    const onAuthorized = vi.fn().mockRejectedValue(denial) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    const onUnavailable = vi.fn().mockResolvedValue(true) as unknown as (
      s: RouterStateSnapshot,
      error?: unknown,
    ) => Promise<boolean | UrlTree>;
    setup('user', { onAuthorized, onUnavailable, isUnavailableError: () => true });

    await expect(runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)))).rejects.toBe(denial);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('none');
  });

  it('does not grant remote access when logout supersedes a pending onAuthorized hook', async () => {
    let resolveAuthorized: ((value: true) => void) | undefined;
    const onAuthorized = vi.fn(
      () =>
        new Promise<true>((resolve) => {
          resolveAuthorized = resolve;
        }),
    );
    setup('user', { onAuthorized });

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    const access = TestBed.inject(KitAuthAccessService);
    access.clear();
    resolveAuthorized?.(true);

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('none');
  });

  it('does not grant remote access when logout supersedes phased activation', async () => {
    let releaseActivation: (() => void) | undefined;
    let activationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const resume = vi.fn(async () => undefined);
    const onAuthorized = vi.fn(async () => ({
      activate: async (lease: KitAuthAccessLease) => {
        activationStarted?.();
        await gate;
        return lease.isCurrent();
      },
      resume,
    }));
    setup('user', { onAuthorized });

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    await started;
    const access = TestBed.inject(KitAuthAccessService);
    access.clear();
    releaseActivation?.();

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('none');
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not grant local access when logout supersedes a pending unavailable fallback', async () => {
    let resolveUnavailable: ((value: true) => void) | undefined;
    const onUnavailable = vi.fn(
      () =>
        new Promise<true>((resolve) => {
          resolveUnavailable = resolve;
        }),
    );
    setup('unavailable', { onUnavailable });

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    const access = TestBed.inject(KitAuthAccessService);
    access.clear();
    resolveUnavailable?.(true);

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('none');
  });

  it('suspends existing remote capabilities while unauthenticated fallback is pending', async () => {
    let resolveUnauthenticated: ((value: false) => void) | undefined;
    const onUnauthenticated = vi.fn(
      () =>
        new Promise<false>((resolve) => {
          resolveUnauthenticated = resolve;
        }),
    );
    setup('required', { onUnauthenticated });
    const access = TestBed.inject(KitAuthAccessService);
    access.grantRemote();

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(access.mode).toBe('none');
    resolveUnauthenticated?.(false);

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('none');
  });

  it('suspends existing local capabilities while authoritative sign-out fallback is pending', async () => {
    let resolveUnauthenticated: ((value: false) => void) | undefined;
    const onUnauthenticated = vi.fn(
      () =>
        new Promise<false>((resolve) => {
          resolveUnauthenticated = resolve;
        }),
    );
    setup('required', { onUnauthenticated });
    const access = TestBed.inject(KitAuthAccessService);
    access.grantLocal();

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(access.mode).toBe('none');
    resolveUnauthenticated?.(false);

    await expect(pending).resolves.toBe(false);
    expect(access.mode).toBe('none');
  });

  it('suspends existing remote capabilities until unavailable fallback verifies local access', async () => {
    let resolveUnavailable: ((value: true) => void) | undefined;
    const onUnavailable = vi.fn(
      () =>
        new Promise<true>((resolve) => {
          resolveUnavailable = resolve;
        }),
    );
    setup('unavailable', { onUnavailable });
    const access = TestBed.inject(KitAuthAccessService);
    access.grantRemote();

    const pending = runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(access.mode).toBe('none');
    resolveUnavailable?.(true);

    await expect(pending).resolves.toBe(true);
    expect(access.mode).toBe('local');
  });
});

describe('kitRequireAuthorizedGuard — auth state source errors', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('classified transport error invokes onUnavailable', async () => {
    const networkError = { status: 0 };
    const onUnavailable = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAuth(() => ({
          authState: () => throwError(() => networkError),
          onUnavailable,
          isUnavailableError: (error) => error === networkError,
          redirects: REDIRECTS,
        })),
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: NavController, useValue: { setDirection: vi.fn() } },
      ],
    });

    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
    expect(onUnavailable).toHaveBeenCalledWith(
      stateStub,
      networkError,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('does not classify an error from onUnavailable a second time', async () => {
    const networkError = { status: 0 };
    const localStoreError = { status: 0, source: 'local-store' };
    const onUnavailable = vi.fn().mockRejectedValue(localStoreError);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAuth(() => ({
          authState: () => throwError(() => networkError),
          onUnavailable,
          isUnavailableError: (error) => (error as { status?: number })?.status === 0,
          redirects: REDIRECTS,
        })),
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: NavController, useValue: { setDirection: vi.fn() } },
      ],
    });

    await expect(runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)))).rejects.toBe(
      localStoreError,
    );
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it.each([401, 403])('HTTP %i from authState never uses local fallback even with an overly broad classifier', async (status) => {
    const denial = { status };
    const onUnavailable = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAuth(() => ({
          authState: () => throwError(() => denial),
          onUnavailable,
          isUnavailableError: () => true,
          redirects: REDIRECTS,
        })),
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: NavController, useValue: { setDirection: vi.fn() } },
      ],
    });

    await expect(runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)))).rejects.toBe(denial);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(TestBed.inject(KitAuthAccessService).mode).toBe('none');
  });
});

// A config may omit the optional hooks; the guard then applies the built-in defaults
// (onAuthorized → true, onUnauthenticated → false).
describe('kitRequireAuthorizedGuard — optional hooks omitted', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setupBare(state: KitAuthState) {
    const navigate = vi.fn().mockResolvedValue(true);
    const setDirection = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideKitAuth(() => ({
          authState: () => of(state),
          redirects: REDIRECTS,
        })),
        { provide: Router, useValue: { navigate } },
        { provide: NavController, useValue: { setDirection } },
      ],
    });
    return { navigate, setDirection };
  }

  it("'user' with no onAuthorized → defaults to true (allow)", async () => {
    setupBare('user');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
  });

  it("'required' with no onUnauthenticated → defaults to false → redirects whenUnauthorized", async () => {
    const { navigate } = setupBare('required');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(false);
    expect(navigate).toHaveBeenCalledWith([REDIRECTS.whenUnauthorized]);
  });
});
