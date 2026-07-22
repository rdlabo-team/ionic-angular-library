import { HttpContext, HttpErrorResponse, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { offlineInterceptor } from './offline.interceptor';
import { OFFLINE_BYPASS, OFFLINE_RESPONSE_HEADER, type OfflineRequestPlan, OfflineRequestPolicyRegistry } from './offline-request-policy';

describe('offlineInterceptor', () => {
  let resolve: ReturnType<typeof vi.fn<(request: HttpRequest<unknown>) => OfflineRequestPlan | null>>;

  beforeEach(() => {
    resolve = vi.fn(() => null);
    TestBed.configureTestingModule({
      providers: [{ provide: OfflineRequestPolicyRegistry, useValue: { resolve } }],
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

  it('GET成功を保存してから返す', async () => {
    const storeFresh = vi.fn(async (): Promise<void> => undefined);
    resolve.mockReturnValue({ kind: 'read', storeFresh, readCached: vi.fn() });
    const response = new HttpResponse({ body: { userId: 1 }, status: 200 });
    await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => of(response)))).resolves.toBe(response);
    expect(storeFresh).toHaveBeenCalledWith(response);
  });

  it('status=0だけcached responseへfallbackする', async () => {
    const cached = new HttpResponse({ body: { dataFrom: 'api' }, status: 200 });
    const readCached = vi.fn(async () => cached);
    resolve.mockReturnValue({ kind: 'read', storeFresh: vi.fn(), readCached });
    const error = new HttpErrorResponse({ status: 0, error: new Error('offline') });
    const response = await firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)));
    expect(response instanceof HttpResponse && response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('cache');
    expect(readCached).toHaveBeenCalledOnce();
  });

  it('403/500はcacheで隠さない', async () => {
    const readCached = vi.fn();
    resolve.mockReturnValue({ kind: 'read', storeFresh: vi.fn(), readCached });
    for (const status of [403, 500]) {
      const error = new HttpErrorResponse({ status });
      await expect(firstValueFrom(run(new HttpRequest('GET', '/bootstrap'), () => throwError(() => error)))).rejects.toBe(error);
    }
    expect(readCached).not.toHaveBeenCalled();
  });

  it('mutationはtransportより先にoutboxへ保存しsynthetic responseを返す', async () => {
    const enqueue = vi.fn(async () => ({ commandId: 'command-1' }));
    resolve.mockReturnValue({ kind: 'mutation', enqueue });
    const next = vi.fn();
    const response = await firstValueFrom(run(new HttpRequest('POST', '/groups/1/documents', {}), next));
    expect(next).not.toHaveBeenCalled();
    expect(response).toEqual(expect.objectContaining({ status: 202, body: { queued: true, commandId: 'command-1' } }));
    expect(response instanceof HttpResponse && response.headers.get(OFFLINE_RESPONSE_HEADER)).toBe('queued');
  });
});

function run(request: HttpRequest<unknown>, next: Parameters<typeof offlineInterceptor>[1]) {
  return TestBed.runInInjectionContext(() => offlineInterceptor(request, next));
}
