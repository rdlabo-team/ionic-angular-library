import type { Provider, Type } from '@angular/core';
import { inject, Injectable, InjectionToken } from '@angular/core';
import type { HttpRequest, HttpResponse } from '@angular/common/http';
import { HttpContextToken } from '@angular/common/http';

/** outbox再送時にoffline interceptorだけを迂回する。認証・retryは維持する。 */
export const OFFLINE_BYPASS = new HttpContextToken<boolean>(() => false);
/** Header attached to synthetic local or optimistic responses. */
export const OFFLINE_RESPONSE_HEADER = 'X-Offline-Response';
/** Origin of a synthetic offline response. */
export type OfflineResponseSource = 'local' | 'optimistic';

/** Source passed to a read policy's shared response projector. */
export type OfflineReadResponseSource = 'remote' | 'local';

/** Product read policy backed by a local replica fallback for transport failures. */
export interface OfflineReadRequestPlan {
  kind: 'read';
  /**
   * Persists and projects a remote response, or projects a local fallback.
   *
   * @remarks
   * Products may return a replacement response assembled from the local
   * replica. The source makes persistence remote-only while both paths share
   * one product-owned composer.
   */
  projectResponse?(response: HttpResponse<unknown>, source: OfflineReadResponseSource): Promise<HttpResponse<unknown>>;
  /** Reads the same request from the local replica. */
  readLocal(): Promise<HttpResponse<unknown> | null>;
}

/** Resolved offline handling strategy for an HTTP request. */
export type OfflineRequestPlan = OfflineReadRequestPlan;

/** URL・DTO・replica key・feature flagは製品Policyだけが知る。 */
export interface OfflineRequestPolicy {
  resolve(request: HttpRequest<unknown>): OfflineRequestPlan | null;
}

/** A local-first mutation prepared before any HTTP transport is started. */
export interface OfflineMutationRequestPlan {
  kind: 'mutation';
  /**
   * Atomically updates the replica and appends its durable Outbox command,
   * then returns the optimistic response exposed to the original caller.
   */
  prepare(): Promise<HttpResponse<unknown>>;
}

/** Product policy that maps one write request to a local-first mutation. */
export interface OfflineMutationRequestPolicy {
  resolve(request: HttpRequest<unknown>): OfflineMutationRequestPlan | null;
}

/** Multi-provider token containing product request policies. */
export const OFFLINE_REQUEST_POLICIES = new InjectionToken<readonly OfflineRequestPolicy[]>('OFFLINE_REQUEST_POLICIES', {
  factory: () => [],
});

/** Multi-provider token containing product mutation policies. */
export const OFFLINE_MUTATION_REQUEST_POLICIES = new InjectionToken<readonly OfflineMutationRequestPolicy[]>(
  'OFFLINE_MUTATION_REQUEST_POLICIES',
  { factory: () => [] },
);

/** Registers one product request policy with the offline interceptor. */
export function provideOfflineRequestPolicy(policy: Type<OfflineRequestPolicy>): Provider[] {
  return [policy, { provide: OFFLINE_REQUEST_POLICIES, useExisting: policy, multi: true }];
}

/** Registers one product mutation policy with the offline interceptor. */
export function provideOfflineMutationRequestPolicy(policy: Type<OfflineMutationRequestPolicy>): Provider[] {
  return [policy, { provide: OFFLINE_MUTATION_REQUEST_POLICIES, useExisting: policy, multi: true }];
}

/** Resolves the first product policy matching an HTTP request. */
@Injectable({ providedIn: 'root' })
export class OfflineRequestPolicyRegistry {
  readonly #policies = inject(OFFLINE_REQUEST_POLICIES);

  resolve(request: HttpRequest<unknown>): OfflineRequestPlan | null {
    for (const policy of this.#policies) {
      const plan = policy.resolve(request);
      if (plan) return plan;
    }
    return null;
  }
}

/** Raised when more than one mutation policy claims the same request. */
export class OfflineMutationPolicyConflictError extends Error {
  constructor(request: HttpRequest<unknown>, matchCount: number) {
    super(`${matchCount} offline mutation policies matched ${request.method} ${request.urlWithParams}`);
    this.name = 'OfflineMutationPolicyConflictError';
  }
}

/** Resolves the only product mutation policy matching a write request. */
@Injectable({ providedIn: 'root' })
export class OfflineMutationRequestPolicyRegistry {
  readonly #policies = inject(OFFLINE_MUTATION_REQUEST_POLICIES);

  resolve(request: HttpRequest<unknown>): OfflineMutationRequestPlan | null {
    let matched: OfflineMutationRequestPlan | null = null;
    let matchCount = 0;
    for (const policy of this.#policies) {
      const plan = policy.resolve(request);
      if (!plan) continue;
      matched = plan;
      matchCount += 1;
    }
    if (matchCount > 1) throw new OfflineMutationPolicyConflictError(request, matchCount);
    return matched;
  }
}
