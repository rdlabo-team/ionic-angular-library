import { inject } from '@angular/core';
import { canonicalOfflinePrincipalId, type OfflinePrincipalId } from './offline-identity';
import { toObservable } from '@angular/core/rxjs-interop';
import type { RouterStateSnapshot } from '@angular/router';
import type { KitAuthAccessLease, KitAuthConfig, KitRemoteAccessRecovery } from '@rdlabo/ionic-angular-kit';
import type { Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { OfflineCoordinatorService } from './offline-coordinator.service';

/** Remote identity fields required to activate an offline session boundary. */
export interface OfflineRemoteIdentity {
  readonly userId: OfflinePrincipalId;
  readonly scopeIds: readonly string[];
  readonly authSubject: string;
  /** Scope partitions to pull eagerly on automatic resume; remaining scopes require an explicit flush. */
  readonly foregroundScopeIds?: readonly string[];
}

/** Phase that distinguishes route authorization from background remote recovery. */
export type OfflineAuthExchangePhase = 'authorize' | 'recover';

/** Context passed to the product credential exchange callback. */
export interface OfflineAuthExchangeContext {
  readonly phase: OfflineAuthExchangePhase;
  readonly state?: RouterStateSnapshot;
  readonly lease: KitAuthAccessLease;
}

/** Context supplied after remote transport has resumed for the same authenticated identity. */
export interface OfflineAuthResumeContext<TIdentity extends OfflineRemoteIdentity> {
  readonly phase: OfflineAuthExchangePhase;
  readonly state?: RouterStateSnapshot;
  readonly lease: KitAuthAccessLease;
  readonly identity: TIdentity;
}

/** Options for {@link createOfflineAuthBridge}. */
export interface CreateOfflineAuthBridgeOptions<TIdentity extends OfflineRemoteIdentity = OfflineRemoteIdentity> {
  /** Coordinator override for tests or custom runtimes; otherwise injected from the current context. */
  readonly offline?: OfflineCoordinatorService;
  /**
   * Exchanges a stored or refreshed credential for a remote identity.
   *
   * @returns `null` or `false` when the product declines activation without treating it as an error.
   */
  readonly exchange: (context: OfflineAuthExchangeContext) => Promise<TIdentity | null | false>;
  /** Provider subject currently known to the product auth layer. */
  readonly currentAuthSubject: () => string | null | undefined;
  /** Classifies transport unavailability for guard fallback and recovery retry. */
  readonly isUnavailableError: (error: unknown) => boolean;
  /** Remote availability stream; defaults to `offline.networkState !== 'offline'`. */
  readonly availability?: () => Observable<boolean>;
  /** Optional stronger identity check in addition to the required auth-subject match. */
  readonly isIdentityCurrent?: (identity: TIdentity) => boolean;
  /** Optional product hook after the kit publishes remote access and transport resumes. */
  readonly onRemoteResumed?: (context: OfflineAuthResumeContext<TIdentity>) => Promise<void>;
  /** Delay before {@link KitAuthRecoveryService} retries recovery while local access remains active. */
  readonly retryDelayMs?: number;
}

/** {@link KitAuthConfig} hooks wired for offline-coordinated remote and local access. */
export type OfflineAuthBridgeConfig = Pick<KitAuthConfig, 'onAuthorized' | 'onUnavailable' | 'isUnavailableError' | 'remoteRecovery'>;

/**
 * Builds the offline-aware {@link KitAuthConfig} fragment for guarded route activation and recovery.
 *
 * @remarks
 * The bridge owns `exchange` → {@link OfflineCoordinatorService.prepareRemoteSession} → kit
 * `grantRemote` → {@link OfflineCoordinatorService.resumeRemoteSession} ordering by returning
 * {@link KitRemoteAccessRecovery}. Product consent, error UI, and DTO mapping stay outside.
 *
 * @example
 * ```ts
 * provideKitAuth(() => ({
 *   authState: () => auth.state$,
 *   ...createOfflineAuthBridge({
 *     exchange: async (ctx) => {
 *       const identity = await auth.exchangeCredential(ctx);
 *       const authSubject = auth.currentSubject();
 *       return identity && authSubject ? { ...identity, authSubject } : false;
 *     },
 *     currentAuthSubject: () => auth.currentSubject(),
 *     isUnavailableError: isOfflineFallbackError,
 *   }),
 *   redirects,
 * }));
 * ```
 */
export function createOfflineAuthBridge<TIdentity extends OfflineRemoteIdentity>(
  options: CreateOfflineAuthBridgeOptions<TIdentity>,
): OfflineAuthBridgeConfig {
  const offline = options.offline ?? inject(OfflineCoordinatorService);
  const { exchange, currentAuthSubject, isUnavailableError, isIdentityCurrent, onRemoteResumed, retryDelayMs } = options;
  const defaultAvailability$ = options.availability
    ? undefined
    : toObservable(offline.networkState).pipe(
        map((state) => state !== 'offline'),
        distinctUntilChanged(),
      );
  const availability = options.availability ?? (() => defaultAvailability$!);

  const identityStillCurrent = (lease: KitAuthAccessLease, identity: TIdentity): boolean =>
    lease.isCurrent() && currentAuthSubject() === identity.authSubject && (isIdentityCurrent?.(identity) ?? true);

  const resolveRemoteAccess = async (
    phase: OfflineAuthExchangePhase,
    state: RouterStateSnapshot | undefined,
    lease: KitAuthAccessLease,
  ): Promise<KitRemoteAccessRecovery | false> => {
    if (!lease.isCurrent()) return false;
    const identity = await exchange({ phase, state, lease });
    if (!lease.isCurrent()) return false;
    if (identity === null || identity === false) return false;
    assertOfflineRemoteIdentity(identity);
    if (!identityStillCurrent(lease, identity)) return false;

    return {
      activate: async (activateLease) => {
        if (!identityStillCurrent(activateLease, identity)) return false;
        const identityLease: KitAuthAccessLease = {
          isCurrent: () => identityStillCurrent(activateLease, identity),
        };
        const prepared = await offline.prepareRemoteSession(identity.userId, identity.scopeIds, identity.authSubject, identityLease);
        return prepared && identityLease.isCurrent();
      },
      resume: async (resumeLease) => {
        const resumeStillCurrent = (): boolean =>
          (resumeLease?.isCurrent() ?? true) && currentAuthSubject() === identity.authSubject && (isIdentityCurrent?.(identity) ?? true);
        if (!resumeStillCurrent()) return;
        await offline.resumeRemoteSession(
          identity.foregroundScopeIds !== undefined ? { foregroundScopeIds: identity.foregroundScopeIds } : undefined,
        );
        if (!resumeStillCurrent()) return;
        if (onRemoteResumed) {
          await onRemoteResumed({
            phase,
            state,
            lease: resumeLease ?? lease,
            identity,
          });
          if (!resumeStillCurrent()) return;
        }
      },
    };
  };

  return {
    isUnavailableError,
    onAuthorized: (state, lease) => resolveRemoteAccess('authorize', state, lease),
    onUnavailable: async (_state, _error, lease) => {
      if (!lease.isCurrent()) return false;
      const manifest = await offline.activateOfflineSession(currentAuthSubject(), lease);
      if (!lease.isCurrent()) return false;
      return manifest !== null;
    },
    remoteRecovery: {
      retryDelayMs,
      availability,
      reauthenticate: (lease) => resolveRemoteAccess('recover', undefined, lease),
    },
  };
}

function assertOfflineRemoteIdentity(identity: OfflineRemoteIdentity): void {
  canonicalOfflinePrincipalId(identity.userId);
  if (!Array.isArray(identity.scopeIds) || identity.scopeIds.some((scopeId) => typeof scopeId !== 'string' || scopeId.length === 0)) {
    throw new Error('Offline remote identity scopeIds must contain only non-empty strings.');
  }
  if (typeof identity.authSubject !== 'string' || identity.authSubject.length === 0) {
    throw new Error('Offline remote identity authSubject must be a non-empty string.');
  }
  if (identity.foregroundScopeIds !== undefined) {
    if (
      !Array.isArray(identity.foregroundScopeIds) ||
      identity.foregroundScopeIds.some((scopeId) => typeof scopeId !== 'string' || scopeId.length === 0)
    ) {
      throw new Error('Offline remote identity foregroundScopeIds must contain only non-empty strings.');
    }
    const scopeIds = new Set(identity.scopeIds);
    for (const scopeId of identity.foregroundScopeIds) {
      if (!scopeIds.has(scopeId)) {
        throw new Error(`Offline remote identity foregroundScopeIds must be a subset of scopeIds: "${scopeId}".`);
      }
    }
  }
}
