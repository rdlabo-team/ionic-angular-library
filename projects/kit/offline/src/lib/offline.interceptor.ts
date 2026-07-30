import type { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpResponse as AngularHttpResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { catchError, concatMap, defer, from, map, of, tap, throwError } from 'rxjs';
import { isOfflineFallbackError, OfflineNetworkService } from './offline-network.service';
import {
  OFFLINE_BYPASS,
  OFFLINE_RESPONSE_HEADER,
  OfflineMutationRequestPolicyRegistry,
  OfflineRequestPolicyRegistry,
  type OfflineReadRequestPlan,
} from './offline-request-policy';

const LOCAL_FIRST_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Applies product read and local-first mutation policies while observing real API reachability. */
export const offlineInterceptor: HttpInterceptorFn = (request, next) => {
  const network = inject(OfflineNetworkService);
  const transport = () => observeTransport(next(request), network);
  if (request.context.get(OFFLINE_BYPASS)) return transport();
  if (request.method === 'GET') {
    const registry = inject(OfflineRequestPolicyRegistry);
    const fallback = inject(OfflineRequestFallbackService);
    const plan = registry.resolve(request);
    if (!plan) return transport();
    return defer(transport).pipe(
      catchError((error: unknown) => fallback.handle(request, error, plan) ?? throwError(() => error)),
      concatMap((event) => projectRemoteResponse(event, plan)),
    );
  }
  if (LOCAL_FIRST_MUTATION_METHODS.has(request.method)) {
    const plan = inject(OfflineMutationRequestPolicyRegistry).resolve(request);
    if (plan) {
      return defer(() => from(plan.prepare())).pipe(
        map((response) => response.clone({ headers: response.headers.set(OFFLINE_RESPONSE_HEADER, 'optimistic') })),
      );
    }
  }
  return transport();
};

function projectRemoteResponse(event: HttpEvent<unknown>, plan: OfflineReadRequestPlan): Observable<HttpEvent<unknown>> {
  if (!(event instanceof AngularHttpResponse) || !plan.projectResponse) return of(event);
  const source = event.headers.get(OFFLINE_RESPONSE_HEADER) === 'local' ? 'local' : 'remote';
  return from(plan.projectResponse(event, source)).pipe(
    map((response) =>
      source === 'local' ? response.clone({ headers: response.headers.set(OFFLINE_RESPONSE_HEADER, 'local') }) : response,
    ),
  );
}

function observeTransport(source: Observable<HttpEvent<unknown>>, network: OfflineNetworkService): Observable<HttpEvent<unknown>> {
  return source.pipe(
    tap({
      next: (event) => {
        if (!(event instanceof AngularHttpResponse)) return;
        if (event.headers.get(OFFLINE_RESPONSE_HEADER) === 'local') {
          network.markApiFailure();
          return;
        }
        network.markApiSuccess();
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
