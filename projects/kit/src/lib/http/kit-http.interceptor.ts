import type { EnvironmentProviders } from '@angular/core';
import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import type { HttpErrorResponse, HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpResponse } from '@angular/common/http';
import { Network } from '@capacitor/network';
import type { Observable } from 'rxjs';
import { from, retry, throwError, timer } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';

/**
 * HTTP status codes that must never be retried. `401` is handled separately and thrown immediately.
 *
 * @internal
 */
const NON_RETRYABLE_STATUSES = [400, 403, 404, 418, 500, 502];

/**
 * Configuration that customizes the behavior of {@link kitAuthInterceptor}, injected through {@link provideKitHttp}.
 *
 * @remarks
 * The interceptor fixes the retry policy (up to 2 retries with a linearly increasing backoff, plus immediate
 * throw on `401` and on every {@link NON_RETRYABLE_STATUSES | non-retryable status}) and the overall
 * control flow. Only the hooks below are application-specific.
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
   * UX hook for network-originated errors while the device is connected.
   *
   * @remarks
   * Optional; defaults to a no-op. The kit ships {@link KitReloadAlertController} as the fleet's
   * canonical implementation of this hook (with auto-dismiss on reconnect via `onResponse`).
   *
   * @param status - The HTTP status code, or a string descriptor for non-HTTP failures.
   * @returns Optionally a promise to await before continuing.
   */
  onNetworkError?(status: number | string): Promise<void> | void;
  /**
   * UX hook for `400` / `500` responses that carry a server-provided message.
   *
   * @remarks
   * Optional; defaults to a no-op.
   *
   * @param message - The message extracted from the error body.
   */
  onServerError?(message: string): void;
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
 * Canonical functional HTTP interceptor that applies authentication, retries, and error handling.
 *
 * @remarks
 * Behavior, driven by the injected {@link KitHttpConfig}:
 *
 * 1. Requests for which `bypass` returns `true` are forwarded untouched.
 * 2. Otherwise the headers from `getAuthHeaders` and `buildExtraHeaders` are merged onto a cloned request.
 * 3. Failed requests are retried up to 2 times with a linearly increasing backoff of `500ms * (retryCount + 5)`,
 *    except that `401` and any {@link NON_RETRYABLE_STATUSES | non-retryable status}
 *    (`400`, `403`, `404`, `418`, `500`, `502`) are thrown immediately without retrying.
 * 4. On error, `offlineFallback` is consulted first; otherwise `401` calls `onUnauthorized`, `403`
 *    calls `onForbidden`, network-class failures (anything other than `400`/`500`) call
 *    `onNetworkError` when the device is connected, and `400`/`500` responses carrying a body
 *    message call `onServerError`.
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

  return from(config.getAuthHeaders(request)).pipe(
    mergeMap((authHeaders) => {
      const req = request.clone({ setHeaders: { ...authHeaders, ...config.buildExtraHeaders?.(request) } });

      return next(req).pipe(
        retry({
          count: 2,
          delay: (e: HttpErrorResponse, retryCount) => {
            if (e.status === 401) {
              return throwError(() => e);
            }
            if (NON_RETRYABLE_STATUSES.includes(e.status)) {
              return throwError(() => e);
            }
            return timer((retryCount + 5) * 500);
          },
        }),
        tap((event) => {
          if (event instanceof HttpResponse) {
            config.onResponse?.(event);
          }
        }),
        catchError((e: HttpErrorResponse) => {
          const fallback = config.offlineFallback?.(req, e);
          if (fallback) {
            return fallback;
          }
          if (e.status === 401) {
            config.onUnauthorized?.(req);
          } else if (e.status === 403) {
            config.onForbidden?.(req);
          } else if (![400, 500].includes(e.status)) {
            void Network.getStatus().then((status) => {
              if (status.connected) {
                config.onNetworkError?.(e.status);
              }
            });
          } else if (e.error?.message) {
            config.onServerError?.(e.error.message);
          }
          return throwError(() => e);
        }),
      );
    }),
  );
};
