import type { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { HttpResponse as AngularHttpResponse } from '@angular/common/http';
import { ErrorHandler, inject, Injectable } from '@angular/core';
import type { Notification, Observable, ObservableNotification } from 'rxjs';
import {
  catchError,
  concat,
  concatMap,
  connect,
  defer,
  dematerialize,
  EMPTY,
  from,
  map,
  materialize,
  of,
  ReplaySubject,
  take,
  tap,
  throwError,
} from 'rxjs';
import { isOfflineFallbackError, OfflineNetworkService } from './offline-network.service';
import { OFFLINE_MUTATION_PERSISTENCE_ENABLED } from './offline-mutation-persistence.service';
import {
  OFFLINE_BYPASS,
  OFFLINE_RESPONSE_HEADER,
  OfflineMutationRequestPolicyRegistry,
  OfflineRequestPolicyRegistry,
  type OfflineReadRequestPlan,
} from './offline-request-policy';

const LOCAL_FIRST_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type MaterializedTransport = Notification<HttpEvent<unknown>> & ObservableNotification<HttpEvent<unknown>>;

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
    if (plan.readStrategy === 'local-first') {
      return readLocalFirst(request, plan, transport, fallback, inject(ErrorHandler));
    }
    return readNetworkFirst(request, plan, transport, fallback);
  }
  if (LOCAL_FIRST_MUTATION_METHODS.has(request.method)) {
    if (!inject(OFFLINE_MUTATION_PERSISTENCE_ENABLED)()) return transport();
    const plan = inject(OfflineMutationRequestPolicyRegistry).resolve(request);
    if (plan) {
      return defer(() => from(plan.prepare())).pipe(
        map((response) => response.clone({ headers: response.headers.set(OFFLINE_RESPONSE_HEADER, 'optimistic') })),
      );
    }
  }
  return transport();
};

function readNetworkFirst(
  request: HttpRequest<unknown>,
  plan: OfflineReadRequestPlan,
  transport: () => Observable<HttpEvent<unknown>>,
  fallback: OfflineRequestFallbackService,
): Observable<HttpEvent<unknown>> {
  return defer(transport).pipe(
    catchError((error: unknown) => fallback.handle(request, error, plan) ?? throwError(() => error)),
    concatMap((event) => projectReadResponse(event, plan)),
  );
}

/**
 * Stale-while-revalidate local-first GET handling.
 *
 * @remarks
 * Starts raw transport and `readLocal()` concurrently at outer subscription,
 * buffers materialized remote notifications until the local attempt settles,
 * emits a projected local response first on hit, then drains/projects the
 * buffered transport. Remote projection begins only after the local decision.
 *
 * Consumers must keep the returned observable subscribed through revalidation;
 * `firstValueFrom` and `take(1)` cancel in-flight transport and suppress
 * further emissions.
 */
function readLocalFirst(
  request: HttpRequest<unknown>,
  plan: OfflineReadRequestPlan,
  transport: () => Observable<HttpEvent<unknown>>,
  fallback: OfflineRequestFallbackService,
  errorHandler: ErrorHandler,
): Observable<HttpEvent<unknown>> {
  return defer(transport).pipe(
    materialize(),
    connect(
      (bufferedTransport$) =>
        resolveLocalAttempt(plan, errorHandler).pipe(
          concatMap((localResponse) =>
            localResponse
              ? concat(of(localResponse), drainRemoteAfterLocal(bufferedTransport$, plan))
              : drainRemoteNetworkFirst(bufferedTransport$, request, plan, fallback),
          ),
        ),
      { connector: () => new ReplaySubject<MaterializedTransport>() },
    ),
  );
}

function resolveLocalAttempt(plan: OfflineReadRequestPlan, errorHandler: ErrorHandler): Observable<HttpEvent<unknown> | null> {
  return defer(() =>
    from(plan.readLocal()).pipe(
      catchError((localError: unknown) => {
        errorHandler.handleError(localError);
        return of(null);
      }),
    ),
  ).pipe(
    concatMap((local) => (local ? tryProjectLocal(local, plan, errorHandler) : of(null))),
    take(1),
  );
}

function tryProjectLocal(
  cached: AngularHttpResponse<unknown>,
  plan: OfflineReadRequestPlan,
  errorHandler: ErrorHandler,
): Observable<HttpEvent<unknown> | null> {
  return emitTaggedLocalResponse(cached, plan).pipe(
    catchError((error: unknown) => {
      errorHandler.handleError(error);
      return of(null);
    }),
  );
}

function emitTaggedLocalResponse(cached: AngularHttpResponse<unknown>, plan: OfflineReadRequestPlan): Observable<HttpEvent<unknown>> {
  return projectReadResponse(cached.clone({ headers: cached.headers.set(OFFLINE_RESPONSE_HEADER, 'local') }), plan);
}

function drainRemoteAfterLocal(
  bufferedTransport$: Observable<MaterializedTransport>,
  plan: OfflineReadRequestPlan,
): Observable<HttpEvent<unknown>> {
  return bufferedTransport$.pipe(
    dematerialize(),
    catchError((error: unknown) => (isOfflineFallbackError(error) ? EMPTY : throwError(() => error))),
    concatMap((event) => projectReadResponse(event, plan)),
  );
}

function drainRemoteNetworkFirst(
  bufferedTransport$: Observable<MaterializedTransport>,
  request: HttpRequest<unknown>,
  plan: OfflineReadRequestPlan,
  fallback: OfflineRequestFallbackService,
): Observable<HttpEvent<unknown>> {
  return bufferedTransport$.pipe(
    dematerialize(),
    catchError((error: unknown) => fallback.handle(request, error, plan) ?? throwError(() => error)),
    concatMap((event) => projectReadResponse(event, plan)),
  );
}

function projectReadResponse(event: HttpEvent<unknown>, plan: OfflineReadRequestPlan): Observable<HttpEvent<unknown>> {
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
