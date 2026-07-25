import type { EnvironmentProviders } from '@angular/core';
import { inject, InjectionToken, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import type { CanActivateFn, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { NavController } from '@ionic/angular/standalone';
import type { Observable } from 'rxjs';
import { of, throwError } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import {
  isExplicitAuthDenial,
  type KitAuthAccessLease,
  type KitAuthRecoveryConfig,
  type KitRemoteAccessRecovery,
  KitAuthAccessService,
  KIT_AUTH_RECOVERY_CONFIG,
  KitAuthRecoveryService,
} from './auth-access.service';

/**
 * Discriminated set of authentication states the guards react to.
 *
 * @remarks
 * The application is responsible for emitting these values through {@link KitAuthConfig.authState}.
 * An application that does not use a value (for example email confirmation) simply never emits it.
 *
 * - `user` — fully authenticated and verified.
 * - `confirm` — awaiting email confirmation.
 * - `required` — not authenticated.
 * - `anonymous` — signed in anonymously; the user can still be guided toward full registration.
 */
export type KitAuthState = 'user' | 'confirm' | 'required' | 'anonymous';

/**
 * Authentication states accepted by route guards.
 *
 * @remarks
 * `unavailable` means the authentication authority cannot currently be reached; this is distinct
 * from an explicit signed-out result. {@link KitAuthState} remains the original four-state union
 * so existing exhaustive consumers remain source-compatible.
 */
export type KitAuthGuardState = KitAuthState | 'unavailable';

/**
 * Redirect targets (route paths) used by the guards when access is denied.
 *
 * @remarks
 * Every field is required and must be provided per application, because the guards have no
 * knowledge of the host application's route layout.
 */
export interface KitAuthRedirects {
  /** Used by {@link kitRequiredUnauthorizedGuard}: where to navigate when the user is already authenticated (`user`). */
  readonly whenAuthorized: string;
  /** Used by {@link kitRequiredUnauthorizedGuard}: where to navigate when the user is awaiting email confirmation (`confirm`). */
  readonly whenConfirming: string;
  /** Used by {@link kitRequireConfirmingGuard}: where to navigate when the state is not `confirm`. */
  readonly whenNotConfirming: string;
  /** Used by {@link kitRequireAuthorizedGuard}: where to navigate when the state is not `user` and the fallback is not allowed. */
  readonly whenUnauthorized: string;
}

/**
 * Configuration consumed by the authentication guards, injected through {@link provideKitAuth}.
 *
 * @remarks
 * `authState` and `redirects` are required. The `onAuthorized`, `onUnauthenticated`, and
 * `onUnavailable` hooks are optional. Without them the guard allows an authenticated user and
 * redirects unauthenticated or unavailable states, so an app only supplies hooks with real logic.
 */
export interface KitAuthConfig extends KitAuthRecoveryConfig {
  /**
   * Source of the current authentication state.
   *
   * @remarks
   * Typically backed by the application's own auth service (for example `AuthService.isAuth()`).
   *
   * @returns A stream of {@link KitAuthState} values.
   */
  authState(): Observable<KitAuthGuardState>;
  /**
   * Application-specific work that runs in {@link kitRequireAuthorizedGuard} after the state is confirmed to be `user`.
   *
   * @remarks
   * Typical responsibilities include token login, permission checks, terms-of-service acceptance,
   * or restoring a previously requested redirect. Optional; defaults to `true` (allow activation).
   *
   * @param state - The router state snapshot of the route being activated.
   * @param lease - Transition lease that product persistence must verify immediately before commit.
   * @returns `true` to allow activation, a `UrlTree` to perform a custom redirect, or a phased
   * remote activation that installs the session before transport work resumes.
   */
  onAuthorized?(state: RouterStateSnapshot, lease: KitAuthAccessLease): Promise<boolean | UrlTree | KitRemoteAccessRecovery>;
  /**
   * Fallback that runs in {@link kitRequireAuthorizedGuard} when the state is `required` (not authenticated).
   *
   * @remarks
   * For example, attempt an anonymous sign-in and allow the route. Optional; defaults to `false`
   * (fall through to the default `whenUnauthorized` redirect).
   *
   * @param state - The router state snapshot of the route being activated.
   * @param lease - Transition lease that product persistence must verify immediately before commit.
   * @returns `true` to allow activation, a `UrlTree` for a custom redirect, a phased remote
   * activation, or `false` to use the default redirect.
   */
  onUnauthenticated?(state: RouterStateSnapshot, lease: KitAuthAccessLease): Promise<boolean | UrlTree | KitRemoteAccessRecovery>;
  /**
   * Fallback that runs only when authentication is unavailable, never for an explicit
   * unauthenticated result.
   *
   * @remarks
   * This hook may authorize read/write access to a previously verified local replica. It must not
   * provide credentials to HTTP or realtime transports. Explicit sign-out and HTTP 401/403 must
   * remain unauthorized.
   *
   * @param state - The router state snapshot of the route being activated.
   * @param error - The classified transport error, or `undefined` when `authState` emitted
   * `unavailable`.
   * @param lease - Transition lease that local-session activation must verify before commit.
   * @returns `true` to allow local route activation, a `UrlTree` for a custom redirect, or `false`
   * to use the default redirect.
   */
  onUnavailable?(state: RouterStateSnapshot, error: unknown | undefined, lease: KitAuthAccessLease): Promise<boolean | UrlTree>;
  /** Redirect targets used by the guards. */
  redirects: KitAuthRedirects;
}

/**
 * Injection token that carries the {@link KitAuthConfig} to the authentication guards.
 */
export const KIT_AUTH_CONFIG = new InjectionToken<KitAuthConfig>('@rdlabo/ionic-angular-kit:auth');

/**
 * Wire the authentication guard configuration into the application's dependency injection.
 *
 * @remarks
 * The factory runs inside an injection context, so it may call `inject()` (for example
 * `inject(AuthService)`) to build the configuration.
 *
 * @param configFactory - Factory that returns the {@link KitAuthConfig} for the application.
 * @returns Environment providers to add to the application bootstrap.
 *
 * @example
 * ```ts
 * provideKitAuth(() => {
 *   const auth = inject(AuthService);
 *   return {
 *     // onAuthorized / onUnauthenticated are optional (default: allow / fall through to redirect).
 *     authState: () => auth.isAuth(),
 *     redirects: {
 *       whenAuthorized: '/',
 *       whenConfirming: '/auth/confirm',
 *       whenNotConfirming: '/auth/signin',
 *       whenUnauthorized: 'auth',
 *     },
 *   };
 * });
 * ```
 */
export const provideKitAuth = (configFactory: () => KitAuthConfig): EnvironmentProviders =>
  makeEnvironmentProviders([
    { provide: KIT_AUTH_CONFIG, useFactory: configFactory },
    { provide: KIT_AUTH_RECOVERY_CONFIG, useExisting: KIT_AUTH_CONFIG },
    provideAppInitializer(() => inject(KitAuthRecoveryService).initialize()),
  ]);

/**
 * Guard that requires the user to be unauthenticated (for example sign-in or sign-up pages).
 *
 * @remarks
 * Allows the `required`, `anonymous`, and `unavailable` states (an anonymous user is permitted to
 * proceed to a registration page). An authenticated user (`user`) is sent to `whenAuthorized`, and
 * a user awaiting confirmation (`confirm`) is sent to `whenConfirming`.
 *
 * @returns A stream emitting `true` to allow activation, or `false` after triggering a redirect.
 *
 * @example
 * ```ts
 * const routes: Routes = [{ path: 'signin', component: SigninPage, canActivate: [kitRequiredUnauthorizedGuard] }];
 * ```
 */
export const kitRequiredUnauthorizedGuard: CanActivateFn = () => {
  const { authState, redirects } = inject(KIT_AUTH_CONFIG);
  const router = inject(Router);
  const navCtrl = inject(NavController);
  const access = inject(KitAuthAccessService);
  const lease = access.beginTransition({ suspendRemote: true });

  return authState().pipe(
    catchError((error) => {
      if (lease.isCurrent() && isExplicitAuthDenial(error)) access.clear();
      return throwError(() => error);
    }),
    map((data) => {
      if (!lease.isCurrent()) return false;
      if (data !== 'unavailable') access.clear();
      if (data === 'user') {
        navCtrl.setDirection('root');
        router.navigate([redirects.whenAuthorized]);
        return false;
      } else if (data === 'confirm') {
        router.navigate([redirects.whenConfirming]);
        return false;
      }
      // 'required' | 'anonymous' | 'unavailable'
      return true;
    }),
  );
};

/**
 * Guard that requires the user to be awaiting email confirmation (`confirm`).
 *
 * @remarks
 * Any other state triggers a redirect: an `anonymous` user is sent to the authenticated area
 * (`whenAuthorized`), and every remaining state is sent to `whenNotConfirming`.
 *
 * @returns A stream emitting `true` to allow activation, or `false` after triggering a redirect.
 *
 * @example
 * ```ts
 * const routes: Routes = [{ path: 'confirm', component: ConfirmPage, canActivate: [kitRequireConfirmingGuard] }];
 * ```
 */
export const kitRequireConfirmingGuard: CanActivateFn = () => {
  const { authState, redirects } = inject(KIT_AUTH_CONFIG);
  const router = inject(Router);
  const navCtrl = inject(NavController);
  const access = inject(KitAuthAccessService);
  const lease = access.beginTransition({ suspendRemote: true });

  return authState().pipe(
    catchError((error) => {
      if (lease.isCurrent() && isExplicitAuthDenial(error)) access.clear();
      return throwError(() => error);
    }),
    map((data) => {
      if (!lease.isCurrent()) return false;
      if (data !== 'unavailable') access.clear();
      if (data === 'confirm') {
        return true;
      }
      navCtrl.setDirection('root');
      router.navigate([data === 'anonymous' ? redirects.whenAuthorized : redirects.whenNotConfirming]);
      return false;
    }),
  );
};

/**
 * Guard that requires the user to be fully authenticated (`user`).
 *
 * @remarks
 * - `user` — runs {@link KitAuthConfig.onAuthorized} (token login, permission checks, and so on).
 * - `anonymous` — allowed as-is, for applications that permit anonymous browsing.
 * - `unavailable` — runs {@link KitAuthConfig.onUnavailable}; this is the only state intended for
 *   restored local-replica access.
 * - `required` / `confirm` — runs {@link KitAuthConfig.onUnauthenticated}; if it resolves to `false`,
 *   the user is redirected to `whenUnauthorized`.
 *
 * @param _route - The activated route snapshot (unused).
 * @param state - The router state snapshot, forwarded to the configuration hooks.
 * @returns A stream emitting the activation result: `true`, a `UrlTree`, or `false` after a redirect.
 *
 * @example
 * ```ts
 * const routes: Routes = [{ path: 'home', component: HomePage, canActivate: [kitRequireAuthorizedGuard] }];
 * ```
 */
export const kitRequireAuthorizedGuard: CanActivateFn = (_route, state) => {
  const { authState, onAuthorized, onUnauthenticated, onUnavailable, isUnavailableError, redirects } = inject(KIT_AUTH_CONFIG);
  const router = inject(Router);
  const navCtrl = inject(NavController);
  const access = inject(KitAuthAccessService);
  const lease = access.beginTransition({ suspendRemote: true });

  const redirectUnauthorized = (): false => {
    if (!lease.isCurrent()) return false;
    access.clear();
    navCtrl.setDirection('root');
    router.navigate([redirects.whenUnauthorized]);
    return false;
  };
  const resolveUnavailable = async (error?: unknown): Promise<boolean | UrlTree> => {
    try {
      const fallback = onUnavailable ? await onUnavailable(state, error, lease) : false;
      if (!lease.isCurrent()) return false;
      if (fallback === true) {
        access.grantLocal();
        return true;
      }
      if (fallback === false) return redirectUnauthorized();
      access.clear();
      return fallback;
    } catch (fallbackError) {
      if (!lease.isCurrent()) return false;
      access.clear();
      throw fallbackError;
    }
  };
  const resolveRemote = async (
    result: boolean | UrlTree | KitRemoteAccessRecovery,
  ): Promise<boolean | UrlTree> => {
    if (!lease.isCurrent()) return false;
    if (isRemoteAccessActivation(result)) {
      if (!(await result.activate(lease)) || !lease.isCurrent()) return false;
      access.grantRemote();
      const resumeLease = access.beginTransition();
      const remoteRevision = access.revision;
      try {
        await result.resume(resumeLease);
      } catch (error) {
        if (access.revision !== remoteRevision) return false;
        if (isExplicitAuthDenial(error)) {
          access.clear();
          throw error;
        }
        if (!isUnavailableError?.(error)) throw error;
      }
      return access.revision === remoteRevision;
    }
    if (result === true) access.grantRemote();
    else access.clear();
    return result;
  };

  interface AuthEmission {
    authState: KitAuthGuardState;
    error?: unknown;
  }
  return authState().pipe(
    map((authState): AuthEmission => ({ authState })),
    catchError((error): Observable<AuthEmission> => {
      if (!lease.isCurrent()) return of({ authState: 'required' });
      if (isExplicitAuthDenial(error)) {
        access.clear();
        return throwError(() => error);
      }
      return isUnavailableError?.(error) ? of({ authState: 'unavailable', error }) : throwError(() => error);
    }),
    mergeMap(async ({ authState: data, error: authStateError }) => {
      if (!lease.isCurrent()) return false;
      if (data === 'user') {
        // 既定は「許可」。tokenLogin / 権限確認等が必要なアプリだけ onAuthorized を渡す。
        if (!onAuthorized) {
          if (!lease.isCurrent()) return false;
          access.grantRemote();
          return true;
        }
        try {
          const result = await onAuthorized(state, lease);
          if (!lease.isCurrent()) return false;
          return await resolveRemote(result);
        } catch (error) {
          if (!lease.isCurrent()) return false;
          if (isExplicitAuthDenial(error)) {
            access.clear();
            throw error;
          }
          if (!isUnavailableError?.(error)) throw error;
          return resolveUnavailable(error);
        }
      }
      if (data === 'anonymous') {
        if (!lease.isCurrent()) return false;
        access.grantRemote();
        return true;
      }
      if (data === 'unavailable') {
        return resolveUnavailable(authStateError);
      }
      // `required` / `confirm` are authoritative denials. Revoke a previously verified local
      // capability before an anonymous-sign-in fallback (if any) is allowed to await.
      if (!access.suspend(lease)) return false;
      // 既定は false（whenUnauthorized へ）。匿名ログイン等のフォールバックが要るアプリだけ渡す。
      const fallback = onUnauthenticated ? await onUnauthenticated(state, lease) : false;
      if (!lease.isCurrent()) return false;
      if (fallback !== false) {
        return resolveRemote(fallback);
      }
      return redirectUnauthorized();
    }),
  );
};

function isRemoteAccessActivation(value: boolean | UrlTree | KitRemoteAccessRecovery): value is KitRemoteAccessRecovery {
  return (
    typeof value === 'object' &&
    value !== null &&
    'activate' in value &&
    typeof value.activate === 'function' &&
    'resume' in value &&
    typeof value.resume === 'function'
  );
}
