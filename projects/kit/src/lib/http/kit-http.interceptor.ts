import type { EnvironmentProviders } from '@angular/core';
import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import type { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Network } from '@capacitor/network';
import type { Observable } from 'rxjs';
import { from, retry, throwError, timer } from 'rxjs';
import { catchError, map, mergeMap, tap, timeout } from 'rxjs/operators';

/**
 * HTTP methods that are safe to retry automatically.
 *
 * @remarks
 * Non-idempotent methods (`POST` / `PATCH` / `DELETE`) are never auto-retried, because a response
 * lost *after* the server processed the write would be replayed into a duplicate write ("saved twice
 * from one tap"). A non-idempotent request that is genuinely safe to replay opts in by carrying an
 * `Idempotency-Key` header (which the server must honor).
 *
 * @internal
 */
const RETRYABLE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Transient HTTP statuses worth retrying: `0` (network/transport failure), `408` (request timeout),
 * `429` (rate limited), and the `502` / `503` / `504` gateway-availability family. Every other status
 * is thrown immediately — a whitelist is safer than a blacklist for deciding what to replay.
 *
 * @internal
 */
const RETRYABLE_STATUSES = [0, 408, 429, 502, 503, 504];

/**
 * Maximum number of automatic retries for a retryable request.
 *
 * @internal
 */
const MAX_RETRIES = 2;

/**
 * Fleet-wide per-request timeout. A request with no response within this window fails with a
 * synthetic `408` (a {@link RETRYABLE_STATUSES | retryable status}). Deliberately generous — it
 * catches a genuinely hung request (dead server) without cutting off legitimately slow work such as
 * a large upload or an AI generation. `timeout({ each })` resets on every emission, so a streaming
 * response that keeps emitting is unaffected.
 *
 * @internal
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * True when the error is the fleet maintenance short-circuit (`503` + body `code: 'MAINTENANCE'`).
 *
 * @remarks
 * Matches Angular `HttpErrorResponse` as `error.error?.code === 'MAINTENANCE'` (body top-level
 * `code`). Must not be retried and must not fall through to {@link KitHttpConfig.onServerBusy}.
 *
 * @param error - The failed response.
 * @returns Whether this is a maintenance response.
 */
export const isMaintenanceError = (error: HttpErrorResponse): boolean =>
  error.status === 503 && error.error?.code === 'MAINTENANCE';

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP-date) into milliseconds, or `null` when it
 * is absent or unparseable.
 *
 * @internal
 */
const parseRetryAfterMs = (error: HttpErrorResponse): number | null => {
  const header = error.headers?.get('Retry-After');
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
};

/**
 * Configuration that customizes the behavior of {@link kitAuthInterceptor}, injected through {@link provideKitHttp}.
 *
 * @remarks
 * The interceptor fixes the retry policy and control flow; only the hooks below are app-specific:
 *
 * - Retries only {@link RETRYABLE_METHODS | idempotent methods} (or a request bearing an
 *   `Idempotency-Key`) on a {@link RETRYABLE_STATUSES | transient status}, up to {@link MAX_RETRIES}
 *   times with a short jittered backoff (honoring `Retry-After`). Writes are never auto-retried.
 * - When the device is offline it fails fast to {@link KitHttpConfig.offlineFallback} instead of
 *   waiting out the retries.
 * - On a final error it classifies by status and calls the matching hook (see each hook below).
 *
 * Only {@link KitHttpConfig.getAuthHeaders} is required — it has no safe default. Every other hook is
 * optional and defaults to a no-op (or `{}` / `false` / `null` as appropriate), so an app configures
 * only the behavior that actually differs from the canonical baseline.
 */
export interface KitHttpConfig {
  /**
   * Produce authentication and metadata headers for the outgoing request.
   *
   * @param request - The outgoing request about to be sent.
   * @returns A map of header names to values, resolved asynchronously.
   */
  getAuthHeaders(request: HttpRequest<unknown>): Promise<Record<string, string>>;
  /**
   * Produce additional headers for the outgoing request.
   *
   * @remarks
   * Optional; defaults to adding no extra headers.
   *
   * @param request - The outgoing request about to be sent.
   * @returns A map of header names to values; return `{}` when none are needed.
   */
  buildExtraHeaders?(request: HttpRequest<unknown>): Record<string, string>;
  /**
   * Treat an otherwise-successful response as an error.
   *
   * @remarks
   * Optional. Some backends use a 2xx status (for example `204` / `206`) to signal a condition the
   * app wants to surface as an error rather than a success. Return `true` to throw the response so it
   * flows through the error path; the status is not in {@link RETRYABLE_STATUSES}, so it is not
   * retried and propagates to the caller. Defaults to treating every 2xx as a success.
   *
   * @param response - The successful `HttpResponse` about to be delivered.
   * @returns `true` to reject the response as an error.
   */
  treatAsError?(response: HttpResponse<unknown>): boolean;
  /**
   * Called for every successful response that completed an actual network round trip.
   *
   * @remarks
   * Responses synthesized by {@link KitHttpConfig.offlineFallback} are produced after `catchError`
   * and therefore never reach this hook, so it observes genuine successes only. A typical use is to
   * reset an "offline" flag once connectivity is restored. Optional; defaults to a no-op.
   *
   * @param event - The successful `HttpResponse`.
   */
  onResponse?(event: HttpResponse<unknown>): void;
  /**
   * Decide whether to pass the request straight through, skipping auth, retry, and error handling.
   *
   * @remarks
   * Useful for external URLs such as S3 or a CDN. Optional; defaults to `false` (never bypass).
   *
   * @param request - The outgoing request.
   * @returns `true` to bypass the interceptor pipeline.
   */
  bypass?(request: HttpRequest<unknown>): boolean;
  /**
   * Provide an offline short-circuit when a request fails.
   *
   * @remarks
   * Returning a non-null observable replaces the error with that response (for example a queued
   * offline result). Optional; defaults to `null` (no fallback, normal error handling proceeds).
   *
   * @param request - The request that failed (after headers were applied).
   * @param error - The error response that triggered the fallback.
   * @returns A replacement event stream, or `null` for no fallback.
   */
  offlineFallback?(request: HttpRequest<unknown>, error: HttpErrorResponse): Observable<HttpEvent<unknown>> | null;
  /**
   * Side effect to run on a `401` response (for example an expired token).
   *
   * @remarks
   * Optional; defaults to a no-op.
   *
   * @param request - The request that received the `401`.
   */
  onUnauthorized?(request: HttpRequest<unknown>): void;
  /**
   * Side effect to run on a `403` response (a permission error).
   *
   * @remarks
   * Optional; defaults to a no-op.
   *
   * @param request - The request that received the `403`.
   */
  onForbidden?(request: HttpRequest<unknown>): void;
  /**
   * UX hook for a genuine network / transport failure (status `0`) while the device reports itself
   * connected — i.e. the server is unreachable rather than the phone being offline.
   *
   * @remarks
   * Optional; defaults to a no-op. Narrow by design: it fires only for status `0` (not for `404`,
   * `429`, `5xx`, …, which have their own hooks), so a "connection lost, reload?" prompt is not shown
   * for server-side problems. When the device is offline it is not called at all — `offlineFallback`
   * owns that path. The kit ships {@link KitReloadAlertController} as the canonical implementation
   * (with de-dup so concurrent failures show a single alert, and auto-dismiss on reconnect).
   *
   * @param status - The HTTP status code (`0`), or a string descriptor for non-HTTP failures.
   * @returns Optionally a promise to await before continuing.
   */
  onNetworkError?(status: number | string): Promise<void> | void;
  /**
   * UX hook for a transient server-availability failure (`502` / `503` / `504`), fired after retries
   * are exhausted.
   *
   * @remarks
   * Optional; defaults to a no-op. Distinct from {@link KitHttpConfig.onNetworkError} — the device's
   * connection is fine, the server is momentarily unavailable — so the app can say "server busy, try
   * again shortly" rather than prompt a reload. **Not** called for fleet maintenance (`503` with
   * `error.error?.code === 'MAINTENANCE'`) — that uses {@link KitHttpConfig.onMaintenance}.
   *
   * @param status - `502`, `503`, or `504`.
   * @param retryAfterSeconds - The server's `Retry-After` hint in seconds, when provided.
   */
  onServerBusy?(status: number, retryAfterSeconds?: number): void;
  /**
   * UX hook for fleet maintenance: HTTP `503` whose body has `code: 'MAINTENANCE'`.
   *
   * @remarks
   * Optional; defaults to a no-op. Fired **without retries** (maintenance is intentional, not
   * transient). Wire to {@link KitMaintenanceController.present} with the wait SSE URL so the lock
   * overlay auto-dismisses when maintenance ends.
   */
  onMaintenance?(): void;
  /**
   * UX hook for a `429 Too Many Requests` response, fired after retries are exhausted.
   *
   * @remarks
   * Optional; defaults to a no-op.
   *
   * @param retryAfterSeconds - The server's `Retry-After` hint in seconds, when provided.
   */
  onRateLimited?(retryAfterSeconds?: number): void;
  /**
   * UX hook for `400` / `422` / `500` responses that carry a server-provided message.
   *
   * @remarks
   * Optional; defaults to a no-op. Note that the message comes straight from the API; prefer a
   * user-facing `userMessage` / `code` in your error contract over showing a raw developer message.
   *
   * @param message - The message extracted from the error body.
   */
  onServerError?(message: string): void;
  /**
   * Side effect for a failure while *producing* the auth headers (`getAuthHeaders` rejected).
   *
   * @remarks
   * Optional; defaults to a no-op. Because the request is never sent in this case, it does not reach
   * the response-error hooks; classify it here (for example a failed token refresh) so it does not
   * fail silently.
   *
   * @param request - The request whose headers could not be produced.
   * @param error - The error thrown by `getAuthHeaders`.
   */
  onAuthError?(request: HttpRequest<unknown>, error: unknown): void;
}

/**
 * Injection token that carries the {@link KitHttpConfig} to {@link kitAuthInterceptor}.
 */
export const KIT_HTTP_CONFIG = new InjectionToken<KitHttpConfig>('@rdlabo/ionic-angular-kit:http');

/**
 * Wire the {@link kitAuthInterceptor} configuration into the application's dependency injection.
 *
 * @remarks
 * Register the interceptor itself separately via `provideHttpClient(withInterceptors([kitAuthInterceptor]))`.
 * The factory runs inside an injection context, so it may call `inject()`.
 *
 * @param configFactory - Factory that returns the {@link KitHttpConfig} for the application.
 * @returns Environment providers to add to the application bootstrap.
 *
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideHttpClient(withInterceptors([kitAuthInterceptor])),
 *     provideKitHttp(() => {
 *       const auth = inject(AuthService);
 *       const reload = inject(KitReloadAlertController);
 *       return {
 *         // Only getAuthHeaders is required; every other hook is optional and defaults to a no-op.
 *         getAuthHeaders: async () => ({ Authorization: `Bearer ${await auth.token()}` }),
 *         onUnauthorized: () => auth.signOut(),
 *         onNetworkError: (status) =>
 *           reload.present({ header: 'Network error', message: `Reload? (${status})`, okText: 'Reload' }),
 *         onResponse: () => void reload.dismiss(),
 *       };
 *     }),
 *   ],
 * });
 * ```
 */
export const provideKitHttp = (configFactory: () => KitHttpConfig): EnvironmentProviders =>
  makeEnvironmentProviders([{ provide: KIT_HTTP_CONFIG, useFactory: configFactory }]);

/**
 * Classify a final (post-retry) error and invoke the matching {@link KitHttpConfig} hook.
 *
 * @internal
 */
const dispatchError = (config: KitHttpConfig, req: HttpRequest<unknown>, error: HttpErrorResponse): void => {
  const status = error.status;
  const retryAfterMs = parseRetryAfterMs(error);
  const retryAfterSeconds = retryAfterMs === null ? undefined : Math.round(retryAfterMs / 1000);

  if (status === 401) {
    config.onUnauthorized?.(req);
  } else if (status === 403) {
    config.onForbidden?.(req);
  } else if (status === 0) {
    // Genuine network/transport failure. Only surface it when the device is actually connected
    // (server unreachable); when offline, offlineFallback owns the UX — a reload prompt won't help.
    void Network.getStatus().then((network) => {
      if (network.connected) {
        config.onNetworkError?.(status);
      }
    });
  } else if (status === 429) {
    config.onRateLimited?.(retryAfterSeconds);
  } else if (isMaintenanceError(error)) {
    config.onMaintenance?.();
  } else if ([502, 503, 504].includes(status)) {
    config.onServerBusy?.(status, retryAfterSeconds);
  } else if ([400, 422, 500].includes(status) && error.error?.message) {
    config.onServerError?.(error.error.message);
  }
  // Every other status (404, 418, …) is left to the caller — no generic alert.
};

/**
 * Canonical functional HTTP interceptor that applies authentication, retries, and error handling.
 *
 * @remarks
 * Behavior, driven by the injected {@link KitHttpConfig}:
 *
 * 1. Requests for which `bypass` returns `true` are forwarded untouched.
 * 2. If `getAuthHeaders` rejects, `onAuthError` is called and the request is not sent.
 * 3. Otherwise the headers from `getAuthHeaders` and `buildExtraHeaders` are merged onto a cloned request.
 * 4. On failure the request is retried up to {@link MAX_RETRIES} times, but **only** when the device
 *    is online, the method is a {@link RETRYABLE_METHODS | retryable method} (or carries an
 *    `Idempotency-Key`), and the status is a {@link RETRYABLE_STATUSES | transient status}. The
 *    backoff is `retryCount * 500ms` plus up to 250ms of jitter, or the server's `Retry-After`.
 *    When the device is offline it stops retrying immediately.
 * 5. On the final error, `offlineFallback` is consulted first; otherwise the error is classified by
 *    status (see {@link dispatchError}): `401`→`onUnauthorized`, `403`→`onForbidden`, `0`→
 *    `onNetworkError` (when connected), `429`→`onRateLimited`, maintenance `503`→`onMaintenance`,
 *    other `502`/`503`/`504`→`onServerBusy`, and `400`/`422`/`500` with a body message→`onServerError`.
 *
 * @param request - The outgoing request.
 * @param next - The next handler in the interceptor chain.
 * @returns A stream of HTTP events for the (possibly modified, retried, or replaced) request.
 *
 * @example
 * ```ts
 * provideHttpClient(withInterceptors([kitAuthInterceptor]));
 * ```
 */
export const kitAuthInterceptor: HttpInterceptorFn = (request, next) => {
  const config = inject(KIT_HTTP_CONFIG);

  if (config.bypass?.(request)) {
    return next(request);
  }

  return from(Promise.resolve(config.getAuthHeaders(request))).pipe(
    catchError((headerError: unknown) => {
      // getAuthHeaders failed → the request is never sent; classify it instead of failing silently.
      config.onAuthError?.(request, headerError);
      return throwError(() => headerError);
    }),
    mergeMap((authHeaders) => {
      const req = request.clone({ setHeaders: { ...authHeaders, ...config.buildExtraHeaders?.(request) } });
      const retryable = RETRYABLE_METHODS.includes(req.method) || req.headers.has('Idempotency-Key');

      const base = next(req).pipe(
        timeout({
          each: DEFAULT_TIMEOUT_MS,
          with: () => throwError(() => new HttpErrorResponse({ status: 408, statusText: 'Request Timeout', url: req.url })),
        }),
      );

      return base.pipe(
        map((event) => {
          // A backend may signal an error condition with a 2xx status (e.g. 204/206); surface it as an error.
          if (event instanceof HttpResponse && config.treatAsError?.(event)) {
            throw event;
          }
          return event;
        }),
        retry({
          count: MAX_RETRIES,
          delay: (error: HttpErrorResponse, retryCount: number) =>
            from(Network.getStatus()).pipe(
              mergeMap((network) => {
                // Offline → don't wait out the retries; fail fast so offlineFallback can take over.
                if (!network.connected) {
                  return throwError(() => error);
                }
                // Only replay idempotent requests, and only on a transient status.
                // Maintenance 503 is intentional — never retry; go straight to onMaintenance.
                if (!retryable || !RETRYABLE_STATUSES.includes(error.status) || isMaintenanceError(error)) {
                  return throwError(() => error);
                }
                // Short linear backoff (500ms, 1000ms, …) plus jitter to de-correlate a fleet of
                // clients reconnecting at once; the server's Retry-After wins when present.
                const backoff = parseRetryAfterMs(error) ?? retryCount * 500 + Math.random() * 250;
                return timer(backoff);
              }),
            ),
        }),
        tap((event) => {
          if (event instanceof HttpResponse) {
            config.onResponse?.(event);
          }
        }),
        catchError((error: HttpErrorResponse) => {
          const fallback = config.offlineFallback?.(req, error);
          if (fallback) {
            return fallback;
          }
          dispatchError(config, req, error);
          return throwError(() => error);
        }),
      );
    }),
  );
};
