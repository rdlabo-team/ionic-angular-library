import type { Provider, Type } from '@angular/core';
import { inject, Injectable, InjectionToken } from '@angular/core';
import type { HttpRequest, HttpResponse } from '@angular/common/http';
import { HttpContextToken } from '@angular/common/http';

/** outbox再送時にoffline interceptorだけを迂回する。認証・retryは維持する。 */
export const OFFLINE_BYPASS = new HttpContextToken<boolean>(() => false);
export const OFFLINE_RESPONSE_HEADER = 'X-Offline-Response';
export type OfflineResponseSource = 'cache' | 'queued';

export interface OfflineReadRequestPlan {
  kind: 'read';
  readCached(): Promise<HttpResponse<unknown> | null>;
  storeFresh(response: HttpResponse<unknown>): Promise<void>;
}

export interface OfflineQueuedMutation {
  commandId: string;
  response?: HttpResponse<unknown>;
}

export interface OfflineMutationRequestPlan {
  kind: 'mutation';
  enqueue?: () => Promise<OfflineQueuedMutation>;
  storeFresh?: (response: HttpResponse<unknown>) => Promise<void>;
}

export type OfflineRequestPlan = OfflineReadRequestPlan | OfflineMutationRequestPlan;

/** URL・DTO・cache key・feature flagは製品Policyだけが知る。 */
export interface OfflineRequestPolicy {
  resolve(request: HttpRequest<unknown>): OfflineRequestPlan | null;
}

export const OFFLINE_REQUEST_POLICIES = new InjectionToken<readonly OfflineRequestPolicy[]>('OFFLINE_REQUEST_POLICIES', {
  factory: () => [],
});

export function provideOfflineRequestPolicy(policy: Type<OfflineRequestPolicy>): Provider[] {
  return [policy, { provide: OFFLINE_REQUEST_POLICIES, useExisting: policy, multi: true }];
}

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
