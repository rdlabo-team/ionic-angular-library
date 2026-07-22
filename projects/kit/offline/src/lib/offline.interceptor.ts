import type { HttpEvent, HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { HttpHeaders, HttpResponse as AngularHttpResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { catchError, concatMap, defer, from, map, of, throwError } from 'rxjs';
import { isOfflineFallbackError } from './offline-network.service';
import {
  OFFLINE_BYPASS,
  OFFLINE_RESPONSE_HEADER,
  type OfflineMutationRequestPlan,
  OfflineRequestPolicyRegistry,
} from './offline-request-policy';

export const offlineInterceptor: HttpInterceptorFn = (request, next) => {
  if (request.context.get(OFFLINE_BYPASS)) return next(request);
  const registry = inject(OfflineRequestPolicyRegistry);
  const fallback = inject(OfflineRequestFallbackService);
  const plan = registry.resolve(request);
  if (!plan) return next(request);
  if (plan.kind === 'mutation') {
    if (plan.enqueue) return enqueueMutation(plan.enqueue, request.urlWithParams);
    if (!plan.storeFresh) return next(request);
    return observeRemoteResponse(next(request), plan.storeFresh);
  }
  if (request.method !== 'GET') return next(request);
  return observeRemoteResponse(
    defer(() => next(request)),
    plan.storeFresh,
  ).pipe(catchError((error: unknown) => fallback.handle(request, error, plan) ?? throwError(() => error)));
};

@Injectable({ providedIn: 'root' })
export class OfflineRequestFallbackService {
  readonly #registry = inject(OfflineRequestPolicyRegistry);

  handle(
    request: HttpRequest<unknown>,
    error: unknown,
    resolvedPlan?: ReturnType<OfflineRequestPolicyRegistry['resolve']>,
  ): Observable<HttpEvent<unknown>> | null {
    if (request.context.get(OFFLINE_BYPASS) || request.method !== 'GET' || !isOfflineFallbackError(error)) return null;
    const plan = resolvedPlan ?? this.#registry.resolve(request);
    if (!plan || plan.kind !== 'read') return null;
    return defer(() => from(plan.readCached())).pipe(
      concatMap((cached) =>
        cached ? of(cached.clone({ headers: cached.headers.set(OFFLINE_RESPONSE_HEADER, 'cache') })) : throwError(() => error),
      ),
      catchError(() => throwError(() => error)),
    );
  }
}

function observeRemoteResponse(
  source: Observable<HttpEvent<unknown>>,
  storeFresh: (response: HttpResponse<unknown>) => Promise<void>,
): Observable<HttpEvent<unknown>> {
  return source.pipe(
    concatMap((event) => {
      if (!(event instanceof AngularHttpResponse) || event.headers.has(OFFLINE_RESPONSE_HEADER)) return of(event);
      return defer(() => from(storeFresh(event))).pipe(
        map(() => event),
        catchError(() => of(event)),
      );
    }),
  );
}

function enqueueMutation(enqueue: NonNullable<OfflineMutationRequestPlan['enqueue']>, url: string): Observable<HttpEvent<unknown>> {
  return defer(() => from(enqueue())).pipe(
    map(({ commandId, response }) =>
      (response ?? new AngularHttpResponse({ body: { queued: true, commandId }, status: 202, statusText: 'Accepted', url })).clone({
        headers: (response?.headers ?? new HttpHeaders()).set(OFFLINE_RESPONSE_HEADER, 'queued'),
      }),
    ),
  );
}
