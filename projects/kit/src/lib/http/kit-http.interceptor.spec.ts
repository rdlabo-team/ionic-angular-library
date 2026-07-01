import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpRequest, HttpResponse } from '@angular/common/http';
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
