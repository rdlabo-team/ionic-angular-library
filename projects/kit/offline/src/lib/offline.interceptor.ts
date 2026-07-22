import type { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpResponse as AngularHttpResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { catchError, concatMap, defer, from, of, tap, throwError } from 'rxjs';
import { isOfflineFallbackError, OfflineNetworkService } from './offline-network.service';
import { OFFLINE_BYPASS, OFFLINE_RESPONSE_HEADER, OfflineRequestPolicyRegistry } from './offline-request-policy';

/** Applies product offline read policies while observing real API reachability. */
export const offlineInterceptor: HttpInterceptorFn = (request, next) => {
  const network = inject(OfflineNetworkService);
  const transport = () => observeTransport(next(request), network);
  if (request.context.get(OFFLINE_BYPASS)) return transport();
  if (request.method !== 'GET') return transport();
  const registry = inject(OfflineRequestPolicyRegistry);
  const fallback = inject(OfflineRequestFallbackService);
  const plan = registry.resolve(request);
  if (!plan) return transport();
  return defer(transport).pipe(catchError((error: unknown) => fallback.handle(request, error, plan) ?? throwError(() => error)));
};

function observeTransport(source: Observable<HttpEvent<unknown>>, network: OfflineNetworkService): Observable<HttpEvent<unknown>> {
  return source.pipe(
    tap({
      next: (event) => {
        if (event instanceof AngularHttpResponse) network.markApiSuccess();
      },
      error: (error: unknown) => {
        if (isOfflineFallbackError(error)) network.markApiFailure();
      },
    }),
  );
}

/** Resolves transport failures from the local replica without hiding HTTP errors. */
@Injectable({ providedIn: 'root' })
export class OfflineRequestFallbackService {
  readonly #registry = inject(OfflineRequestPolicyRegistry);
  readonly #errorHandler = inject(ErrorHandler);

  handle(
    request: HttpRequest<unknown>,
    error: unknown,
    resolvedPlan?: ReturnType<OfflineRequestPolicyRegistry['resolve']>,
  ): Observable<HttpEvent<unknown>> | null {
    if (request.context.get(OFFLINE_BYPASS) || request.method !== 'GET' || !isOfflineFallbackError(error)) return null;
    const plan = resolvedPlan ?? this.#registry.resolve(request);
    if (!plan || plan.kind !== 'read') return null;
    return defer(() => from(plan.readLocal())).pipe(
      catchError((localError: unknown) => {
        this.#errorHandler.handleError(localError);
        return throwError(() => error);
      }),
      concatMap((cached) =>
        cached ? of(cached.clone({ headers: cached.headers.set(OFFLINE_RESPONSE_HEADER, 'local') })) : throwError(() => error),
      ),
    );
  }
}
