import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { of, throwError } from 'rxjs';
import { firstValueFrom } from 'rxjs';

import { kitAuthInterceptor, provideKitHttp, type KitHttpConfig } from './kit-http.interceptor';

// ---------------------------------------------------------------------------
// Mock @capacitor/network so Network.getStatus() never hits native code.
// ---------------------------------------------------------------------------
vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn().mockResolvedValue({ connected: true }),
  },
}));
import { Network } from '@capacitor/network';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const baseReq = new HttpRequest<unknown>('GET', '/api/test');

/**
 * Build a minimal KitHttpConfig with all hooks as vi.fn() no-ops; override selectively.
 */
function makeConfig(overrides: Partial<KitHttpConfig> = {}): KitHttpConfig {
  return {
    bypass: vi.fn().mockReturnValue(false),
    getAuthHeaders: vi.fn().mockResolvedValue({}),
    buildExtraHeaders: vi.fn().mockReturnValue({}),
    offlineFallback: vi.fn().mockReturnValue(null),
    onResponse: vi.fn(),
    onUnauthorized: vi.fn(),
    onForbidden: vi.fn(),
    onNetworkError: vi.fn(),
    onServerError: vi.fn(),
    ...overrides,
  };
}

function setupInterceptor(config: KitHttpConfig) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideKitHttp(() => config)],
  });
}

/** Run the interceptor inside an injection context and return the result observable. */
function runInterceptor(req: HttpRequest<unknown>, next: (r: HttpRequest<unknown>) => Observable<unknown>) {
  return TestBed.runInInjectionContext(() => kitAuthInterceptor(req, next as never));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('kitAuthInterceptor', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // Every hook except getAuthHeaders is optional; a config that only provides
  // getAuthHeaders must drive the pipeline without throwing on the missing hooks.
  describe('optional hooks (only getAuthHeaders provided)', () => {
    const minimalConfig: KitHttpConfig = { getAuthHeaders: vi.fn().mockResolvedValue({}) };

    it('passes a successful response through without a bypass/onResponse hook', async () => {
      setupInterceptor(minimalConfig);
      const response = new HttpResponse({ status: 200, body: { ok: true } });
      const next = vi.fn().mockReturnValue(of(response));
      const result = await firstValueFrom(runInterceptor(baseReq, next));
      expect(result).toBe(response);
    });

    it('re-throws a 403 without an onForbidden/offlineFallback hook', async () => {
      setupInterceptor(minimalConfig);
      const error = new HttpErrorResponse({ status: 403 });
      const next = vi.fn().mockReturnValue(throwError(() => error));
      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toBe(error);
    });
  });

  // ---- bypass ---------------------------------------------------------------
  describe('bypass', () => {
    it('passes the original request to next without adding headers', async () => {
      const config = makeConfig({ bypass: vi.fn().mockReturnValue(true) });
      setupInterceptor(config);

      const next = vi.fn().mockReturnValue(of(new HttpResponse({ status: 200 })));
      await firstValueFrom(runInterceptor(baseReq, next));

      expect(next).toHaveBeenCalledOnce();
      // headers must be unmodified — the original request should be passed through
      const passedReq: HttpRequest<unknown> = next.mock.calls[0][0];
      expect(passedReq).toBe(baseReq);
      expect(config.getAuthHeaders).not.toHaveBeenCalled();
    });
  });

  // ---- header merging -------------------------------------------------------
  describe('header merging', () => {
    it('merges getAuthHeaders and buildExtraHeaders onto the cloned request', async () => {
      const config = makeConfig({
        getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'Bearer token' }),
        buildExtraHeaders: vi.fn().mockReturnValue({ 'X-App-Version': '1.0' }),
      });
      setupInterceptor(config);

      const next = vi.fn().mockReturnValue(of(new HttpResponse({ status: 200 })));
      await firstValueFrom(runInterceptor(baseReq, next));

      const passedReq: HttpRequest<unknown> = next.mock.calls[0][0];
      expect(passedReq.headers.get('Authorization')).toBe('Bearer token');
      expect(passedReq.headers.get('X-App-Version')).toBe('1.0');
    });
  });

  // ---- offlineFallback ------------------------------------------------------
  describe('offlineFallback', () => {
    it('returns the fallback observable when non-null; onUnauthorized is not called', async () => {
      const fallbackResponse = new HttpResponse({ status: 200, body: 'cached' });
      const config = makeConfig({
        getAuthHeaders: vi.fn().mockResolvedValue({}),
        offlineFallback: vi.fn().mockReturnValue(of(fallbackResponse)),
      });
      setupInterceptor(config);

      const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 401 })));

      const result = await firstValueFrom(runInterceptor(baseReq, next));
      expect(result).toBe(fallbackResponse);
      expect(config.onUnauthorized).not.toHaveBeenCalled();
    });
  });

  // ---- 401 handling ---------------------------------------------------------
  describe('401 Unauthorized', () => {
    it('calls onUnauthorized and re-throws the error', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const error401 = new HttpErrorResponse({ status: 401 });
      const next = vi.fn().mockReturnValue(throwError(() => error401));

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(config.onUnauthorized).toHaveBeenCalledOnce();
      expect(config.onForbidden).not.toHaveBeenCalled();
    });
  });

  // ---- 403 handling ---------------------------------------------------------
  describe('403 Forbidden', () => {
    it('calls onForbidden and re-throws the error', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const error403 = new HttpErrorResponse({ status: 403 });
      const next = vi.fn().mockReturnValue(throwError(() => error403));

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(config.onForbidden).toHaveBeenCalledOnce();
      expect(config.onUnauthorized).not.toHaveBeenCalled();
    });
  });

  // ---- 400 with message → onServerError -------------------------------------
  describe('400 with error.message', () => {
    it('calls onServerError with the message and re-throws', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const error400 = new HttpErrorResponse({ status: 400, error: { message: 'Invalid input' } });
      const next = vi.fn().mockReturnValue(throwError(() => error400));

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(config.onServerError).toHaveBeenCalledWith('Invalid input');
    });

    it('does not call onServerError when error.message is absent', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const error400 = new HttpErrorResponse({ status: 400, error: {} });
      const next = vi.fn().mockReturnValue(throwError(() => error400));

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(config.onServerError).not.toHaveBeenCalled();
    });
  });

  // ---- 500 with message → onServerError -------------------------------------
  describe('500 with error.message', () => {
    it('calls onServerError with the message', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const error500 = new HttpErrorResponse({ status: 500, error: { message: 'Server crash' } });
      const next = vi.fn().mockReturnValue(throwError(() => error500));

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(config.onServerError).toHaveBeenCalledWith('Server crash');
    });
  });

  // ---- NON_RETRYABLE: no extra subscriptions --------------------------------
  describe('retry: NON_RETRYABLE statuses are not retried', () => {
    it('subscribes to the source observable exactly once for status 400', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      let subscriptionCount = 0;
      const next = vi.fn().mockImplementation(() => {
        return new Observable((subscriber) => {
          subscriptionCount++;
          subscriber.error(new HttpErrorResponse({ status: 400, error: {} }));
        });
      });

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(subscriptionCount).toBe(1);
    });

    it('subscribes exactly once for status 401 (immediate throw, no retry)', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      let subscriptionCount = 0;
      const next = vi.fn().mockImplementation(() => {
        return new Observable((subscriber) => {
          subscriptionCount++;
          subscriber.error(new HttpErrorResponse({ status: 401 }));
        });
      });

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(subscriptionCount).toBe(1);
    });

    it('subscribes exactly once for status 403', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      let subscriptionCount = 0;
      const next = vi.fn().mockImplementation(() => {
        return new Observable((subscriber) => {
          subscriptionCount++;
          subscriber.error(new HttpErrorResponse({ status: 403 }));
        });
      });

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(subscriptionCount).toBe(1);
    });

    it('subscribes exactly once for status 404', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      let subscriptionCount = 0;
      const next = vi.fn().mockImplementation(() => {
        return new Observable((subscriber) => {
          subscriptionCount++;
          subscriber.error(new HttpErrorResponse({ status: 404 }));
        });
      });

      await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
      expect(subscriptionCount).toBe(1);
    });
  });

  // ---- success path ---------------------------------------------------------
  describe('success path', () => {
    it('emits the response when next succeeds', async () => {
      const config = makeConfig();
      setupInterceptor(config);

      const response = new HttpResponse({ status: 200, body: 'ok' });
      const next = vi.fn().mockReturnValue(of(response));

      const result = await firstValueFrom(runInterceptor(baseReq, next));
      expect(result).toBe(response);
      expect(config.onResponse).toHaveBeenCalledWith(response);
      expect(config.onUnauthorized).not.toHaveBeenCalled();
      expect(config.onForbidden).not.toHaveBeenCalled();
      expect(config.onServerError).not.toHaveBeenCalled();
    });

    it('does not call onResponse for an offlineFallback-synthesized response', async () => {
      const fallbackResponse = new HttpResponse({ status: 201, body: { mode: 'offline' } });
      const config = makeConfig({ offlineFallback: vi.fn().mockReturnValue(of(fallbackResponse)) });
      setupInterceptor(config);

      // status 400 is non-retryable → catchError fires immediately (no retry delay)
      const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 400 })));
      const result = await firstValueFrom(runInterceptor(baseReq, next));
      expect(result).toBe(fallbackResponse);
      expect(config.onResponse).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Redesigned retry policy + status classification (kit 0.0.9)
// ---------------------------------------------------------------------------
describe('kitAuthInterceptor — retry policy & classification', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.mocked(Network.getStatus).mockResolvedValue({ connected: true } as never);
  });

  const postReq = new HttpRequest<unknown>('POST', '/api/save', {});
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('does NOT retry a non-idempotent POST even on a retryable status (502)', async () => {
    setupInterceptor(makeConfig());
    let subs = 0;
    const next = vi.fn().mockImplementation(
      () =>
        new Observable((s) => {
          subs++;
          s.error(new HttpErrorResponse({ status: 502 }));
        }),
    );
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toThrow();
    expect(subs).toBe(1); // write is never auto-retried
  });

  it('offline → fails fast to offlineFallback, and onNetworkError is not called', async () => {
    vi.mocked(Network.getStatus).mockResolvedValue({ connected: false } as never);
    const fallback = of(new HttpResponse({ status: 200, body: { queued: true } }));
    const config = makeConfig({ offlineFallback: vi.fn().mockReturnValue(fallback) });
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
    const result = (await firstValueFrom(runInterceptor(baseReq, next))) as HttpResponse<unknown>;
    expect(result.status).toBe(200);
    expect(config.onNetworkError).not.toHaveBeenCalled();
  });

  it('502/503/504 → onServerBusy', async () => {
    const config = makeConfig({ onServerBusy: vi.fn() });
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toThrow();
    expect(config.onServerBusy).toHaveBeenCalledWith(503, undefined);
  });

  it('503 + code MAINTENANCE → onMaintenance, no onServerBusy, no retry', async () => {
    const config = makeConfig({ onServerBusy: vi.fn(), onMaintenance: vi.fn() });
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 503,
            error: { statusCode: 503, message: 'Service temporarily unavailable', code: 'MAINTENANCE' },
          }),
      ),
    );
    await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toThrow();
    expect(config.onMaintenance).toHaveBeenCalledTimes(1);
    expect(config.onServerBusy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1); // GET would otherwise retry 503
  });

  it('429 → onRateLimited with the Retry-After seconds', async () => {
    const config = makeConfig({ onRateLimited: vi.fn() });
    setupInterceptor(config);
    const next = vi
      .fn()
      .mockReturnValue(throwError(() => new HttpErrorResponse({ status: 429, headers: new HttpHeaders({ 'Retry-After': '30' }) })));
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toThrow();
    expect(config.onRateLimited).toHaveBeenCalledWith(30);
  });

  it('status 0 while connected → onNetworkError', async () => {
    const config = makeConfig();
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toThrow();
    await flush();
    expect(config.onNetworkError).toHaveBeenCalledWith(0);
  });

  it('404 fires no generic alert hook', async () => {
    const config = makeConfig({ onServerBusy: vi.fn(), onRateLimited: vi.fn() });
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(throwError(() => new HttpErrorResponse({ status: 404, error: { message: 'nope' } })));
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toThrow();
    await flush();
    expect(config.onNetworkError).not.toHaveBeenCalled();
    expect(config.onServerError).not.toHaveBeenCalled();
    expect(config.onServerBusy).not.toHaveBeenCalled();
  });

  it('getAuthHeaders rejection → onAuthError, request not sent', async () => {
    const err = new Error('token failed');
    const config = makeConfig({ getAuthHeaders: vi.fn().mockRejectedValue(err), onAuthError: vi.fn() });
    setupInterceptor(config);
    const next = vi.fn().mockReturnValue(of(new HttpResponse({ status: 200 })));
    await expect(firstValueFrom(runInterceptor(baseReq, next))).rejects.toBe(err);
    expect(config.onAuthError).toHaveBeenCalledWith(baseReq, err);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// timeoutMs + treatAsError (kit 0.0.10 — for local-interceptor migration)
// ---------------------------------------------------------------------------
describe('kitAuthInterceptor — timeoutMs & treatAsError', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.mocked(Network.getStatus).mockResolvedValue({ connected: true } as never);
  });

  const postReq = new HttpRequest<unknown>('POST', '/api/save', {});

  it('treatAsError rejects a 2xx response (204) as an error, without retrying it', async () => {
    const config = makeConfig({ treatAsError: vi.fn((res: HttpResponse<unknown>) => res.status === 204) });
    setupInterceptor(config);
    let subs = 0;
    const next = vi.fn().mockImplementation(
      () =>
        new Observable((s) => {
          subs++;
          s.next(new HttpResponse({ status: 204 }));
          s.complete();
        }),
    );
    await expect(firstValueFrom(runInterceptor(postReq, next))).rejects.toBeInstanceOf(HttpResponse);
    expect(config.treatAsError).toHaveBeenCalled();
    expect(subs).toBe(1); // a treated-as-error 204 is not retried
  });

  it('treatAsError returning false lets a normal 200 through', async () => {
    const config = makeConfig({ treatAsError: vi.fn(() => false) });
    setupInterceptor(config);
    const ok = new HttpResponse({ status: 200, body: { ok: true } });
    const next = vi.fn().mockReturnValue(of(ok));
    expect(await firstValueFrom(runInterceptor(postReq, next))).toBe(ok);
  });

  it('times out a hung request with a synthetic 408 after the default timeout', async () => {
    vi.useFakeTimers();
    try {
      setupInterceptor(makeConfig());
      const next = vi.fn().mockReturnValue(new Observable<never>(() => {})); // never emits
      const result = firstValueFrom(runInterceptor(postReq, next));
      const assertion = expect(result).rejects.toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
