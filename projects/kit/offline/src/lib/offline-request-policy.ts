import type { Provider, Type } from '@angular/core';
import { inject, Injectable, InjectionToken } from '@angular/core';
import type { HttpRequest, HttpResponse } from '@angular/common/http';
import { HttpContextToken } from '@angular/common/http';

/** outbox再送時にoffline interceptorだけを迂回する。認証・retryは維持する。 */
export const OFFLINE_BYPASS = new HttpContextToken<boolean>(() => false);
/** Header attached to responses served from the local replica fallback. */
export const OFFLINE_RESPONSE_HEADER = 'X-Offline-Response';
/** Origin of a synthetic offline response. */
export type OfflineResponseSource = 'local';

/** Product read policy backed by a local replica fallback for transport failures. */
export interface OfflineReadRequestPlan {
  kind: 'read';
  readLocal(): Promise<HttpResponse<unknown> | null>;
}

/** Resolved offline handling strategy for an HTTP request. */
export type OfflineRequestPlan = OfflineReadRequestPlan;

/** URL・DTO・replica key・feature flagは製品Policyだけが知る。 */
export interface OfflineRequestPolicy {
  resolve(request: HttpRequest<unknown>): OfflineRequestPlan | null;
}

/** Multi-provider token containing product request policies. */
export const OFFLINE_REQUEST_POLICIES = new InjectionToken<readonly OfflineRequestPolicy[]>('OFFLINE_REQUEST_POLICIES', {
  factory: () => [],
});

/** Registers one product request policy with the offline interceptor. */
export function provideOfflineRequestPolicy(policy: Type<OfflineRequestPolicy>): Provider[] {
  return [policy, { provide: OFFLINE_REQUEST_POLICIES, useExisting: policy, multi: true }];
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
