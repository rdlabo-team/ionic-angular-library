import { HttpContext, HttpErrorResponse, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalize, firstValueFrom, of, Subject, throwError, type Observable } from 'rxjs';
import { OfflineNetworkService } from './offline-network.service';
import { OFFLINE_MUTATION_PERSISTENCE_ENABLED } from './offline-mutation-persistence.service';
import { offlineInterceptor } from './offline.interceptor';
import {
  OFFLINE_BYPASS,
  OFFLINE_RESPONSE_HEADER,
  type OfflineMutationRequestPlan,
  OfflineMutationRequestPolicyRegistry,
  type OfflineReadResponseSource,
  type OfflineRequestPlan,
  OfflineRequestPolicyRegistry,
} from './offline-request-policy';

describe('offlineInterceptor', () => {
  let resolve: ReturnType<typeof vi.fn<(request: HttpRequest<unknown>) => OfflineRequestPlan | null>>;
  let resolveMutation: ReturnType<typeof vi.fn<(request: HttpRequest<unknown>) => OfflineMutationRequestPlan | null>>;
  let markApiSuccess: ReturnType<typeof vi.fn>;
  let markApiFailure: ReturnType<typeof vi.fn>;
  let handleError: ReturnType<typeof vi.fn>;
  let mutationPersistenceEnabled: boolean;

  beforeEach(() => {
    resolve = vi.fn(() => null);
    resolveMutation = vi.fn(() => null);
    markApiSuccess = vi.fn();
    markApiFailure = vi.fn();
    handleError = vi.fn();
    mutationPersistenceEnabled = true;
    TestBed.configureTestingModule({
      providers: [
        { provide: OfflineRequestPolicyRegistry, useValue: { resolve } },
        { provide: OfflineMutationRequestPolicyRegistry, useValue: { resolve: resolveMutation } },
        { provide: OfflineNetworkService, useValue: { markApiSuccess, markApiFailure } },
        { provide: OFFLINE_MUTATION_PERSISTENCE_ENABLED, useValue: () => mutationPersistenceEnabled },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
  });

  it('再送requestはpolicyを迂回してtransportへ渡す', async () => {
    const request = new HttpRequest('POST', '/resource', null, {
      context: new HttpContext().set(OFFLINE_BYPASS, true),
    });
    const response = new HttpResponse({ status: 201 });
    const next = vi.fn(() => of(response));
    await expect(firstValueFrom(run(request, next))).resolves.toBe(response);
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveMutation).not.toHaveBeenCalled();
  });

  it('GET成功はtransport responseをそのまま返しreachabilityを更新する', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const response = new HttpResponse({ body: { userId: 1 }, status: 200 });
    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(response)))).resolves.toBe(response);
    expect(markApiSuccess).toHaveBeenCalledOnce();
  });

  it('GET成功をpolicyで永続化・再合成したresponseへ置換する', async () => {
    const transportResponse = new HttpResponse({ body: { value: 'remote' }, status: 200 });
    const projectedResponse = new HttpResponse({ body: { value: 'projected' }, status: 200 });
    const projectResponse = vi.fn(async () => projectedResponse);
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn(), projectResponse });

    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(transportResponse)))).resolves.toBe(projectedResponse);

    expect(projectResponse).toHaveBeenCalledWith(transportResponse, 'remote');
    expect(markApiSuccess).toHaveBeenCalledOnce();
  });

  it('remote projection失敗はlocal fallbackで隠さない', async () => {
    const projectionError = new HttpErrorResponse({ status: 0, error: new Error('local persistence failed') });
    const readLocal = vi.fn();
    resolve.mockReturnValue({
      kind: 'read',
      readLocal,
      projectResponse: vi.fn(async () => {
        throw projectionError;
      }),
    });

    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(new HttpResponse({ status: 200 }))))).rejects.toBe(
      projectionError,
    );

    expect(readLocal).not.toHaveBeenCalled();
    expect(markApiSuccess).toHaveBeenCalledOnce();
  });

  it('inner interceptorのlocal responseを実API成功として扱わない', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const response = new HttpResponse({
      body: { userId: 1 },
      status: 200,
      headers: new HttpHeaders().set(OFFLINE_RESPONSE_HEADER, 'local'),
    });

    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(response)))).resolves.toBe(response);

    expect(markApiSuccess).not.toHaveBeenCalled();
    expect(markApiFailure).toHaveBeenCalledOnce();
  });

  it('status=0だけlocal replica responseへfallbackする', async () => {
    const local = new HttpResponse({ body: { dataFrom: 'api' }, status: 200 });
    const readLocal = vi.fn(async () => local);
    resolve.mockReturnValue({ kind: 'read', readLocal });
    const error = new HttpErrorResponse({ status: 0, error: new Error('offline') });
    const response = await firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)));
    expect(response instanceof HttpResponse && response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
    expect(readLocal).toHaveBeenCalledOnce();
    expect(markApiFailure).toHaveBeenCalledOnce();
  });

  it('fallback responseもremoteと同じprojectorへlocal sourceとして渡す', async () => {
    const rawLocal = new HttpResponse({ body: { value: 'stored' }, status: 200 });
    const projectedLocal = new HttpResponse({ body: { value: 'composed' }, status: 200 });
    const projectResponse = vi.fn(
      async (_response: HttpResponse<unknown>, _source: OfflineReadResponseSource): Promise<HttpResponse<unknown>> => projectedLocal,
    );
    resolve.mockReturnValue({
      kind: 'read',
      readLocal: vi.fn(async () => rawLocal),
      projectResponse,
    });
    const error = new HttpErrorResponse({ status: 0, error: new Error('offline') });

    const response = await firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)));

    expect(response instanceof HttpResponse && response.body).toEqual({ value: 'composed' });
    expect(response instanceof HttpResponse && response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
    expect(projectResponse).toHaveBeenCalledOnce();
    expect(projectResponse.mock.calls[0]?.[1]).toBe('local');
    expect(projectResponse.mock.calls[0]?.[0].headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
  });

  it('401/403/500はlocal replicaで隠さない', async () => {
    const readLocal = vi.fn();
    resolve.mockReturnValue({ kind: 'read', readLocal });
    for (const status of [401, 403, 500]) {
      const error = new HttpErrorResponse({ status });
      await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)))).rejects.toBe(error);
    }
    expect(readLocal).not.toHaveBeenCalled();
  });

  it('未登録POSTはread policyを解決せずtransportへ渡しreachabilityを更新する', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const request = new HttpRequest('POST', '/groups/1/documents', {});
    const response = new HttpResponse({ status: 201 });
    const next = vi.fn(() => of(response));
    await expect(firstValueFrom(run(request, next))).resolves.toBe(response);
    expect(resolve).not.toHaveBeenCalled();
    expect(resolveMutation).toHaveBeenCalledWith(request);
    expect(next).toHaveBeenCalledOnce();
    expect(markApiSuccess).toHaveBeenCalledOnce();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%sはmatched mutationをtransport前にprepareしてlocal responseを返す', async (method) => {
    const request = new HttpRequest(method, '/groups/1/documents', {});
    const optimistic = new HttpResponse({ body: { localId: 'local-1' }, status: 202 });
    const prepare = vi.fn(async () => optimistic);
    resolveMutation.mockReturnValue({ kind: 'mutation', prepare });
    const next = vi.fn(() => of(new HttpResponse({ status: 500 })));

    const response = await firstValueFrom(run(request, next));

    expect(response instanceof HttpResponse && response.body).toEqual({ localId: 'local-1' });
    expect(response instanceof HttpResponse && response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('optimistic');
    expect(prepare).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(markApiSuccess).not.toHaveBeenCalled();
    expect(markApiFailure).not.toHaveBeenCalled();
  });

  it('mutation persistence OFFではmatched policyを解決せずtransportへ渡す', async () => {
    mutationPersistenceEnabled = false;
    const request = new HttpRequest('POST', '/groups/1/documents', {});
    const response = new HttpResponse({ status: 201 });
    const next = vi.fn(() => of(response));

    await expect(firstValueFrom(run(request, next))).resolves.toBe(response);

    expect(resolveMutation).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('matched mutationのprepare失敗時はtransportへfall throughしない', async () => {
    const error = new Error('outbox full');
    resolveMutation.mockReturnValue({
      kind: 'mutation',
      prepare: vi.fn(async () => {
        throw error;
      }),
    });
    const next = vi.fn(() => of(new HttpResponse({ status: 201 })));

    await expect(firstValueFrom(run(new HttpRequest('POST', '/groups', {}), next))).rejects.toBe(error);

    expect(next).not.toHaveBeenCalled();
    expect(markApiSuccess).not.toHaveBeenCalled();
    expect(markApiFailure).not.toHaveBeenCalled();
  });

  it('POST失敗もtransport経由でreachabilityを更新する', async () => {
    const request = new HttpRequest('POST', '/groups/1/documents', {});
    const error = new HttpErrorResponse({ status: 0, error: new Error('offline') });
    const next = vi.fn(() => throwError(() => error));
    await expect(firstValueFrom(run(request, next))).rejects.toBe(error);
    expect(resolve).not.toHaveBeenCalled();
    expect(markApiFailure).toHaveBeenCalledOnce();
  });

  describe('local-first read strategy', () => {
    const localFirstPlan = (overrides: Partial<OfflineRequestPlan> = {}): OfflineRequestPlan => ({
      kind: 'read',
      readStrategy: 'local-first',
      readLocal: vi.fn(async () => null),
      ...overrides,
    });

    it('local hitのあとremoteを順にemitしreachabilityを更新する', async () => {
      const rawLocal = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      const projectedLocal = new HttpResponse({ body: { value: 'local-projected' }, status: 200 });
      const transportResponse = new HttpResponse({ body: { value: 'remote' }, status: 200 });
      const projectedRemote = new HttpResponse({ body: { value: 'remote-projected' }, status: 200 });
      const projectResponse = vi.fn(async (_response: HttpResponse<unknown>, source: OfflineReadResponseSource) =>
        source === 'local' ? projectedLocal : projectedRemote,
      );
      resolve.mockReturnValue(
        localFirstPlan({
          readLocal: vi.fn(async () => rawLocal),
          projectResponse,
        }),
      );

      const emissions = await collect(run(new HttpRequest('GET', '/bootstrap'), () => of(transportResponse)));

      expect(emissions).toHaveLength(2);
      expect(emissions[0] instanceof HttpResponse && emissions[0].body).toEqual({ value: 'local-projected' });
      expect(emissions[0] instanceof HttpResponse && emissions[0].headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
      expect(emissions[1] instanceof HttpResponse && emissions[1].body).toEqual({ value: 'remote-projected' });
      expect(emissions[1] instanceof HttpResponse && emissions[1].headers.has(OFFLINE_RESPONSE_HEADER)).toBe(false);
      expect(projectResponse.mock.calls.map(([, source]) => source)).toEqual(['local', 'remote']);
      expect(markApiSuccess).toHaveBeenCalledOnce();
      expect(markApiFailure).not.toHaveBeenCalled();
    });

    it('deferred localでもsubscribe直後にtransportを開始する', async () => {
      let transportSubscribed = false;
      let resolveLocal!: (value: HttpResponse<unknown>) => void;
      const localReady = new Promise<HttpResponse<unknown>>((resolve) => {
        resolveLocal = resolve;
      });
      const next = vi.fn(() => {
        transportSubscribed = true;
        return of(new HttpResponse({ body: { value: 'remote' }, status: 200 }));
      });
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(() => localReady) }));

      const pending = collect(run(new HttpRequest('GET', '/bootstrap'), next));
      await vi.waitFor(() => expect(transportSubscribed).toBe(true));
      expect(next).toHaveBeenCalledOnce();
      resolveLocal(new HttpResponse({ body: { value: 'cached' }, status: 200 }));
      await pending;
    });

    it('remoteが先に完了してもemit順はlocal→remote', async () => {
      const transportSubject = new Subject<HttpResponse<unknown>>();
      let resolveLocal!: (value: HttpResponse<unknown>) => void;
      const localReady = new Promise<HttpResponse<unknown>>((resolve) => {
        resolveLocal = resolve;
      });
      const next = vi.fn(() => transportSubject.asObservable());
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(() => localReady) }));

      const pending = collect(run(new HttpRequest('GET', '/bootstrap'), next));
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      transportSubject.next(new HttpResponse({ body: { value: 'remote' }, status: 200 }));
      transportSubject.complete();
      resolveLocal(new HttpResponse({ body: { value: 'cached' }, status: 200 }));

      const emissions = await pending;
      expect(emissions).toHaveLength(2);
      expect(emissions[0] instanceof HttpResponse && emissions[0].body).toEqual({ value: 'cached' });
      expect(emissions[0] instanceof HttpResponse && emissions[0].headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
      expect(emissions[1] instanceof HttpResponse && emissions[1].body).toEqual({ value: 'remote' });
    });

    it('local emit後のstatus=0はerrorにせずreachability failureだけ記録する', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(async () => local) }));
      const error = new HttpErrorResponse({ status: 0, error: new Error('offline') });

      const emissions = await collect(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)));

      expect(emissions).toHaveLength(1);
      expect(emissions[0] instanceof HttpResponse && emissions[0].headers.get(OFFLINE_RESPONSE_HEADER)).toBe('local');
      expect(markApiFailure).toHaveBeenCalledOnce();
      expect(markApiSuccess).not.toHaveBeenCalled();
    });

    it('local emit後の401/403/500はerrorのまま', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(async () => local) }));

      for (const status of [401, 403, 500]) {
        const error = new HttpErrorResponse({ status });
        await expect(collect(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)))).rejects.toBe(error);
      }
    });

    it('local missはnetwork-firstと同じremote→fallback動作', async () => {
      const remote = new HttpResponse({ body: { value: 'remote' }, status: 200 });
      const readLocal = vi.fn(async () => null);
      const next = vi.fn(() => of(remote));
      resolve.mockReturnValue(localFirstPlan({ readLocal }));

      await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), next))).resolves.toBe(remote);

      expect(readLocal).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledOnce();
      expect(markApiSuccess).toHaveBeenCalledOnce();
    });

    it('local read失敗はErrorHandlerへ報告しremoteを継続する', async () => {
      const localError = new Error('sqlite locked');
      const remote = new HttpResponse({ body: { value: 'remote' }, status: 200 });
      const readLocal = vi.fn(async () => {
        throw localError;
      });
      const next = vi.fn(() => of(remote));
      resolve.mockReturnValue(localFirstPlan({ readLocal }));

      await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), next))).resolves.toBe(remote);

      expect(handleError).toHaveBeenCalledWith(localError);
      expect(next).toHaveBeenCalledOnce();
      expect(markApiSuccess).toHaveBeenCalledOnce();
    });

    it('remote projection失敗はlocal emit後もerrorのまま', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      const projectionError = new HttpErrorResponse({ status: 500, error: new Error('projection failed') });
      resolve.mockReturnValue(
        localFirstPlan({
          readLocal: vi.fn(async () => local),
          projectResponse: vi.fn(async (_response, source) => {
            if (source === 'remote') throw projectionError;
            return local;
          }),
        }),
      );

      await expect(collect(run(new HttpRequest('GET', '/bootstrap'), () => of(new HttpResponse({ status: 200 }))))).rejects.toBe(
        projectionError,
      );
    });

    it('remote projectResponseのstatus=0はtransport fallbackとして握りつぶさない', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      const projectionError = new HttpErrorResponse({ status: 0, error: new Error('local persistence failed') });
      resolve.mockReturnValue(
        localFirstPlan({
          readLocal: vi.fn(async () => local),
          projectResponse: vi.fn(async (_response, source) => {
            if (source === 'remote') throw projectionError;
            return local;
          }),
        }),
      );

      await expect(collect(run(new HttpRequest('GET', '/bootstrap'), () => of(new HttpResponse({ status: 200 }))))).rejects.toBe(
        projectionError,
      );
    });

    it('local projectResponse失敗はErrorHandlerへ報告しnetwork-firstへ継続する', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      const projectionError = new Error('corrupt cache');
      const remote = new HttpResponse({ body: { value: 'remote' }, status: 200 });
      const next = vi.fn(() => of(remote));
      resolve.mockReturnValue(
        localFirstPlan({
          readLocal: vi.fn(async () => local),
          projectResponse: vi.fn(async (_response, source) => {
            if (source === 'local') throw projectionError;
            return remote;
          }),
        }),
      );

      const emissions = await collect(run(new HttpRequest('GET', '/bootstrap'), next));

      expect(emissions).toEqual([remote]);
      expect(handleError).toHaveBeenCalledWith(projectionError);
      expect(next).toHaveBeenCalledOnce();
      expect(markApiSuccess).toHaveBeenCalledOnce();
    });

    it('local pending中のunsubscribeはtransportをcancelしemit/reportしない', async () => {
      let transportUnsubscribed = false;
      let resolveLocal!: (value: HttpResponse<unknown>) => void;
      const localReady = new Promise<HttpResponse<unknown>>((resolve) => {
        resolveLocal = resolve;
      });
      const next = vi.fn(() =>
        of(new HttpResponse({ status: 200 })).pipe(
          finalize(() => {
            transportUnsubscribed = true;
          }),
        ),
      );
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(() => localReady) }));

      const subscription = run(new HttpRequest('GET', '/bootstrap'), next).subscribe();
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      subscription.unsubscribe();
      expect(transportUnsubscribed).toBe(true);

      resolveLocal(new HttpResponse({ body: { value: 'cached' }, status: 200 }));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(handleError).not.toHaveBeenCalled();
    });

    it('remote完了前のunsubscribeはtransportをcancelする', async () => {
      const local = new HttpResponse({ body: { value: 'cached' }, status: 200 });
      resolve.mockReturnValue(localFirstPlan({ readLocal: vi.fn(async () => local) }));
      let transportUnsubscribed = false;
      const transportSubject = new Subject<HttpResponse<unknown>>();
      const transport$ = transportSubject.asObservable().pipe(
        finalize(() => {
          transportUnsubscribed = true;
        }),
      );

      const emissions: HttpResponse<unknown>[] = [];
      const subscription = run(new HttpRequest('GET', '/bootstrap'), () => transport$).subscribe({
        next: (event) => {
          if (event instanceof HttpResponse) emissions.push(event);
        },
      });

      await vi.waitFor(() => expect(emissions).toHaveLength(1));
      subscription.unsubscribe();
      expect(transportUnsubscribed).toBe(true);
    });
  });

  it('readStrategy未指定はnetwork-firstのまま', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const response = new HttpResponse({ body: { userId: 1 }, status: 200 });
    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(response)))).resolves.toBe(response);
    expect(markApiSuccess).toHaveBeenCalledOnce();
  });
});

function run(request: HttpRequest<unknown>, next: Parameters<typeof offlineInterceptor>[1]) {
  return TestBed.runInInjectionContext(() => offlineInterceptor(request, next));
}

function collect<T>(source: Observable<T>): Promise<T[]> {
  return new Promise((resolvePromise, reject) => {
    const values: T[] = [];
    source.subscribe({
      next: (value) => values.push(value),
      complete: () => resolvePromise(values),
      error: reject,
    });
  });
}
