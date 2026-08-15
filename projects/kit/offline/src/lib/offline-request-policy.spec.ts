import { HttpHeaders, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { OfflineNetworkService } from './offline-network.service';
import {
  OFFLINE_MUTATION_REQUEST_POLICIES,
  OFFLINE_RESPONSE_COMPLETE_HEADER,
  OFFLINE_RESPONSE_HEADER,
  OfflineMutationPolicyConflictError,
  type OfflineMutationRequestPlan,
  type OfflineMutationRequestPolicy,
  OfflineMutationRequestPolicyRegistry,
  offlineReadEmission,
  shouldCommitOfflineCollection,
} from './offline-request-policy';
import { offlineInterceptor } from './offline.interceptor';

describe('OfflineMutationRequestPolicyRegistry', () => {
  const request = new HttpRequest('POST', '/items?scope=active', {});

  it('returns null when no mutation policy matches', () => {
    const registry = createRegistry([policy(null), policy(null)]);

    expect(registry.resolve(request)).toBeNull();
  });

  it('returns the single matching mutation plan', () => {
    const plan = mutationPlan();
    const registry = createRegistry([policy(null), policy(plan)]);

    expect(registry.resolve(request)).toBe(plan);
  });

  it('fails fast when multiple mutation policies match', () => {
    const registry = createRegistry([policy(mutationPlan()), policy(mutationPlan())]);

    expect(() => registry.resolve(request)).toThrowError('2 offline mutation policies matched POST /items?scope=active');
  });

  it('starts neither prepare nor transport when multiple policies match', () => {
    const firstPrepare = vi.fn(async () => new HttpResponse({ status: 202 }));
    const secondPrepare = vi.fn(async () => new HttpResponse({ status: 202 }));
    const next = vi.fn(() => of(new HttpResponse({ status: 201 })));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: OFFLINE_MUTATION_REQUEST_POLICIES,
          useValue: [policy({ kind: 'mutation', prepare: firstPrepare }), policy({ kind: 'mutation', prepare: secondPrepare })],
        },
        { provide: OfflineNetworkService, useValue: { markApiSuccess: vi.fn(), markApiFailure: vi.fn() } },
      ],
    });

    expect(() => TestBed.runInInjectionContext(() => offlineInterceptor(request, next))).toThrowError(OfflineMutationPolicyConflictError);
    expect(firstPrepare).not.toHaveBeenCalled();
    expect(secondPrepare).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('offline read settlement', () => {
  it('keeps an incomplete empty local collection from replacing usable state', () => {
    const response = new HttpResponse({ headers: new HttpHeaders().set(OFFLINE_RESPONSE_HEADER, 'local') });

    expect(shouldCommitOfflineCollection(offlineReadEmission(response, []))).toBe(false);
  });

  it('commits complete local and remote empty collections', () => {
    const local = new HttpResponse({
      headers: new HttpHeaders().set(OFFLINE_RESPONSE_HEADER, 'local').set(OFFLINE_RESPONSE_COMPLETE_HEADER, 'true'),
    });
    const remote = new HttpResponse();

    expect(shouldCommitOfflineCollection(offlineReadEmission(local, []))).toBe(true);
    expect(shouldCommitOfflineCollection(offlineReadEmission(remote, []))).toBe(true);
  });

  it('commits a nonempty local collection before settlement', () => {
    const response = new HttpResponse({ headers: new HttpHeaders().set(OFFLINE_RESPONSE_HEADER, 'local') });

    expect(shouldCommitOfflineCollection(offlineReadEmission(response, ['cached']))).toBe(true);
  });
});

function createRegistry(policies: readonly OfflineMutationRequestPolicy[]): OfflineMutationRequestPolicyRegistry {
  TestBed.configureTestingModule({
    providers: [{ provide: OFFLINE_MUTATION_REQUEST_POLICIES, useValue: policies }],
  });
  return TestBed.inject(OfflineMutationRequestPolicyRegistry);
}

function policy(plan: OfflineMutationRequestPlan | null): OfflineMutationRequestPolicy {
  return { resolve: vi.fn(() => plan) };
}

function mutationPlan(): OfflineMutationRequestPlan {
  return { kind: 'mutation', prepare: vi.fn(async () => new HttpResponse({ status: 202 })) };
}
