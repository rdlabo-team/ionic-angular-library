import { HttpContext, HttpErrorResponse, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { OfflineNetworkService } from './offline-network.service';
import { offlineInterceptor } from './offline.interceptor';
import { OFFLINE_BYPASS, OFFLINE_RESPONSE_HEADER, type OfflineRequestPlan, OfflineRequestPolicyRegistry } from './offline-request-policy';

describe('offlineInterceptor', () => {
  let resolve: ReturnType<typeof vi.fn<(request: HttpRequest<unknown>) => OfflineRequestPlan | null>>;
  let markApiSuccess: ReturnType<typeof vi.fn>;
  let markApiFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resolve = vi.fn(() => null);
    markApiSuccess = vi.fn();
    markApiFailure = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: OfflineRequestPolicyRegistry, useValue: { resolve } },
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
  });

  it('GET成功はtransport responseをそのまま返しreachabilityを更新する', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const response = new HttpResponse({ body: { userId: 1 }, status: 200 });
    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(response)))).resolves.toBe(response);
    expect(markApiSuccess).toHaveBeenCalledOnce();
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

  it('403/500はlocal replicaで隠さない', async () => {
    const readLocal = vi.fn();
    resolve.mockReturnValue({ kind: 'read', readLocal });
    for (const status of [403, 500]) {
      const error = new HttpErrorResponse({ status });
      await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)))).rejects.toBe(error);
    }
    expect(readLocal).not.toHaveBeenCalled();
  });

  it('POSTはpolicyを解決せずtransportへ渡しreachabilityを更新する', async () => {
    resolve.mockReturnValue({ kind: 'read', readLocal: vi.fn() });
    const request = new HttpRequest('POST', '/groups/1/documents', {});
    const response = new HttpResponse({ status: 201 });
    const next = vi.fn(() => of(response));
    await expect(firstValueFrom(run(request, next))).resolves.toBe(response);
    expect(resolve).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(markApiSuccess).toHaveBeenCalledOnce();
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
