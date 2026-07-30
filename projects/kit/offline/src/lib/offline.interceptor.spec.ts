import { HttpContext, HttpErrorResponse, HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { OfflineNetworkService } from './offline-network.service';
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

  beforeEach(() => {
    resolve = vi.fn(() => null);
    resolveMutation = vi.fn(() => null);
    markApiSuccess = vi.fn();
    markApiFailure = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: OfflineRequestPolicyRegistry, useValue: { resolve } },
        { provide: OfflineMutationRequestPolicyRegistry, useValue: { resolve: resolveMutation } },
        { provide: OfflineNetworkService, useValue: { markApiSuccess, markApiFailure } },
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
});

function run(request: HttpRequest<unknown>, next: Parameters<typeof offlineInterceptor>[1]) {
  return TestBed.runInInjectionContext(() => offlineInterceptor(request, next));
}
