import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { NavController } from '@ionic/angular/standalone';
import type { Observable } from 'rxjs';
import { of } from 'rxjs';
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
    onAuthorized = vi.fn().mockResolvedValue(true) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>,
    onUnauthenticated = vi.fn().mockResolvedValue(false) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>,
    onUnavailable = vi.fn().mockResolvedValue(false) as unknown as (s: RouterStateSnapshot, error?: unknown) => Promise<boolean | UrlTree>,
    isUnavailableError = vi.fn().mockReturnValue(false) as unknown as (error: unknown) => boolean,
  }: {
    onAuthorized?: (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    onUnauthenticated?: (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    onUnavailable?: (s: RouterStateSnapshot, error?: unknown) => Promise<boolean | UrlTree>;
    isUnavailableError?: (error: unknown) => boolean;
  } = {},
) {
  const navigate = vi.fn().mockResolvedValue(true);
  const setDirection = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideKitAuth(() => ({
        authState: () => of(state),
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
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
  });

  it("'anonymous' → returns true", async () => {
    setup('anonymous');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequiredUnauthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kitRequireConfirmingGuard
// ---------------------------------------------------------------------------
describe('kitRequireConfirmingGuard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("'confirm' → returns true", async () => {
    setup('confirm');
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireConfirmingGuard(routeStub, stateStub)));
    expect(result).toBe(true);
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
    expect(onAuthorized).toHaveBeenCalledWith(stateStub);
  });

  it("'user' → propagates UrlTree from onAuthorized", async () => {
    const urlTree = { queryParams: {} } as unknown as UrlTree;
    const onAuthorized = vi.fn().mockResolvedValue(urlTree) as unknown as (s: RouterStateSnapshot) => Promise<boolean | UrlTree>;
    setup('user', { onAuthorized });
    const result = await runGuard(TestBed.runInInjectionContext(() => kitRequireAuthorizedGuard(routeStub, stateStub)));
    expect(result).toBe(urlTree);
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
    expect(onUnavailable).toHaveBeenCalledWith(stateStub, undefined);
    expect(onUnauthenticated).not.toHaveBeenCalled();
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
    expect(onUnavailable).toHaveBeenCalledWith(stateStub, networkError);
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
    expect(onUnavailable).toHaveBeenCalledWith(stateStub, networkError);
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
