import type { EnvironmentProviders } from '@angular/core';
import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core';
import type { CanActivateFn, RouterStateSnapshot, UrlTree } from '@angular/router';
import { Router } from '@angular/router';
import { NavController } from '@ionic/angular/standalone';
import type { Observable } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';

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
 * All members are required. The hooks let the host application plug its own auth service and
 * navigation policy into the otherwise fixed guard control flow.
 */
export interface KitAuthConfig {
  /**
   * Source of the current authentication state.
   *
   * @remarks
   * Typically backed by the application's own auth service (for example `AuthService.isAuth()`).
   *
   * @returns A stream of {@link KitAuthState} values.
   */
  authState(): Observable<KitAuthState>;
  /**
   * Application-specific work that runs in {@link kitRequireAuthorizedGuard} after the state is confirmed to be `user`.
   *
   * @remarks
   * Typical responsibilities include token login, permission checks, terms-of-service acceptance,
   * or restoring a previously requested redirect.
   *
   * @param state - The router state snapshot of the route being activated.
   * @returns `true` to allow activation, or a `UrlTree` to perform a custom redirect.
   */
  onAuthorized(state: RouterStateSnapshot): Promise<boolean | UrlTree>;
  /**
   * Fallback that runs in {@link kitRequireAuthorizedGuard} when the state is `required` (not authenticated).
   *
   * @remarks
   * For example, attempt an anonymous sign-in and allow the route. Applications that do not need
   * this should pass `async () => false` to fall through to the default redirect.
   *
   * @param state - The router state snapshot of the route being activated.
   * @returns `true` to allow activation, a `UrlTree` for a custom redirect, or `false` to use the default redirect.
   */
  onUnauthenticated(state: RouterStateSnapshot): Promise<boolean | UrlTree>;
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
 *     authState: () => auth.isAuth(),
 *     onAuthorized: async () => true,
 *     onUnauthenticated: async () => false,
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
  makeEnvironmentProviders([{ provide: KIT_AUTH_CONFIG, useFactory: configFactory }]);

/**
 * Guard that requires the user to be unauthenticated (for example sign-in or sign-up pages).
 *
 * @remarks
 * Allows the `required` and `anonymous` states (an anonymous user is permitted to proceed to a
 * registration page). An authenticated user (`user`) is sent to `whenAuthorized`, and a user
 * awaiting confirmation (`confirm`) is sent to `whenConfirming`.
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

  return authState().pipe(
    map((data) => {
      if (data === 'user') {
        navCtrl.setDirection('root');
        router.navigate([redirects.whenAuthorized]);
        return false;
      } else if (data === 'confirm') {
        router.navigate([redirects.whenConfirming]);
        return false;
      }
      // 'required' | 'anonymous'
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

  return authState().pipe(
    map((data) => {
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
  const { authState, onAuthorized, onUnauthenticated, redirects } = inject(KIT_AUTH_CONFIG);
  const router = inject(Router);
  const navCtrl = inject(NavController);

  return authState().pipe(
    mergeMap(async (data) => {
      if (data === 'user') {
        return onAuthorized(state);
      }
      if (data === 'anonymous') {
        return true;
      }
      const fallback = await onUnauthenticated(state);
      if (fallback !== false) {
        return fallback;
      }
      navCtrl.setDirection('root');
      router.navigate([redirects.whenUnauthorized]);
      return false;
    }),
  );
};
