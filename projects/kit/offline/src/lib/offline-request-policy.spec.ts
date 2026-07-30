import { HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { OfflineNetworkService } from './offline-network.service';
import {
  OFFLINE_MUTATION_REQUEST_POLICIES,
  OfflineMutationPolicyConflictError,
  type OfflineMutationRequestPlan,
  type OfflineMutationRequestPolicy,
  OfflineMutationRequestPolicyRegistry,
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
