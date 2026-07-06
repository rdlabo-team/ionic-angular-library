import type { Auth, AuthCredential } from 'firebase/auth';
import {
  EmailAuthProvider,
  FacebookAuthProvider,
  linkWithCredential,
  linkWithPopup,
  OAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInWithCredential,
  signInWithPopup,
} from '@angular/fire/auth';
import { Capacitor } from '@capacitor/core';
import { FacebookLogin } from '@capacitor-community/facebook-login';
import { SignInWithApple } from '@capacitor-community/apple-sign-in';

/** How a social-credential failure is classified for the app's error hook. */
export type KitOAuthErrorCategory = 'already-in-use' | 'cancelled' | 'other';

/** The mode a social login runs in. */
export type KitOAuthModeName = 'new' | 'link' | 'credential';

/**
 * The mode discriminator. `'credential'` links an email/password to the (re-authenticated) social
 * account, so it requires the new email/password; `'new'` / `'link'` do not.
 */
export type KitOAuthMode =
  | { mode: 'new' }
  | { mode: 'link' }
  | { mode: 'credential'; emailLogin: { email: string; password: string } };

/**
 * The apple identity payload handed to the `success` hook for the backend call. Populated from the
 * native plugin on device, or synthesized from the popup result on the web.
 */
export interface KitAppleResponse {
  user: string | null;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  identityToken: string | null;
  authorizationCode: string | null;
}

/**
 * The uniform lifecycle hooks for a social flow — the same `before / success / error / finally`
 * shape as {@link KitFirebaseAuthService}'s hooks, so a call site reads the same everywhere. All are
 * optional; the kit renders nothing itself.
 *
 * @typeParam Info - the identity payload handed to {@link success} (Facebook access token / Apple
 * response), so an app can notify its backend and give feedback in one place.
 *
 * @remarks
 * `before` runs before the plugin login starts, `success` after the mode's Firebase op succeeds
 * (carrying the identity payload — do the backend call and the toast here), `error` on a classified
 * failure (`'cancelled'` is passed through so the app can stay silent on a user cancel), and
 * `finally` always. The kit swallows none of these errors.
 */
interface KitSocialHooks<Info> {
  before?: () => void | Promise<unknown>;
  success?: (info: Info) => void | Promise<unknown>;
  error?: (category: KitOAuthErrorCategory, error: unknown) => void | Promise<unknown>;
  finally?: () => void | Promise<unknown>;
}

/** Options for {@link kitFacebookLogin}. */
export type KitFacebookLoginOptions = KitOAuthMode &
  KitSocialHooks<{ accessToken: string; mode: KitOAuthModeName }> & {
    /** Facebook permissions to request. */
    permissions: string[];
  };

/** Options for {@link kitAppleLogin}. */
export type KitAppleLoginOptions = KitOAuthMode & KitSocialHooks<{ response: KitAppleResponse; mode: KitOAuthModeName }>;

/** Generate a random nonce for the Facebook OIDC (Limited Login) flow. */
const generateNonce = (length = 16): string => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < length; i++) {
    nonce += charset[Math.floor(Math.random() * charset.length)];
  }
  return nonce;
};

const classifyOAuthError = (e: unknown): KitOAuthErrorCategory => {
  const code = (e as { code?: string } | undefined)?.code;
  if (code === 'auth/credential-already-in-use') {
    return 'already-in-use';
  }
  if (code === 'auth/user-cancelled') {
    return 'cancelled';
  }
  return 'other';
};

/**
 * The shared 3-mode credential state machine (internal).
 *
 * @remarks
 * `new` signs in with the credential, `link` links it, `credential` re-authenticates with the social
 * credential and then links an email/password. Any Firebase error is classified and handed to
 * `error` (returning `false`); on success the app's `success` hook (backend + feedback) runs with the
 * identity payload, and it returns `true`.
 */
const applyOAuthCredential = async (
  auth: Auth,
  credential: AuthCredential,
  mode: KitOAuthMode,
  effects: {
    success: () => void | Promise<unknown>;
    error: (category: KitOAuthErrorCategory, error: unknown) => void | Promise<unknown>;
  },
): Promise<boolean> => {
  try {
    if (mode.mode === 'new') {
      await signInWithCredential(auth, credential);
    } else {
      const user = auth.currentUser;
      if (!user) {
        throw new Error('kit social: no signed-in user to link/re-authenticate');
      }
      if (mode.mode === 'link') {
        await linkWithCredential(user, credential);
      } else {
        await reauthenticateWithCredential(user, credential);
        await linkWithCredential(user, EmailAuthProvider.credential(mode.emailLogin.email, mode.emailLogin.password));
      }
    }
  } catch (e) {
    await effects.error(classifyOAuthError(e), e);
    return false;
  }
  await effects.success();
  return true;
};

/** Await one animation frame where available (iOS WebView crash workaround; no-op off-browser). */
const nextFrame = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      resolve();
    }
  });

/**
 * Facebook login / link, bundled: native plugin → credential → the shared 3-mode state machine.
 *
 * @remarks
 * On iOS the credential is built from the OIDC token with a nonce (`OAuthProvider('facebook.com')`);
 * elsewhere from the access token (`FacebookAuthProvider`). Returns `{ status: false }` on a
 * cancelled/failed plugin login or a handled Firebase error (the app was already notified via the
 * hooks).
 */
export const kitFacebookLogin = async (
  auth: Auth,
  options: KitFacebookLoginOptions,
): Promise<{ status: boolean }> => {
  await options.before?.();
  try {
    const nonce = generateNonce();
    const event = await FacebookLogin.login({ permissions: options.permissions, nonce }).catch(() => undefined);
    await nextFrame();
    if (!event || !event.accessToken?.token) {
      return { status: false };
    }
    const accessToken = event.accessToken.token;
    const credential: AuthCredential =
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
        ? new OAuthProvider('facebook.com').credential({ rawNonce: nonce, idToken: accessToken })!
        : FacebookAuthProvider.credential(accessToken);

    const status = await applyOAuthCredential(auth, credential, options, {
      success: () => options.success?.({ accessToken, mode: options.mode }),
      error: (category, error) => options.error?.(category, error),
    });
    return { status };
  } finally {
    await options.finally?.();
  }
};

/**
 * Log out of the Facebook SDK (best-effort; errors are ignored).
 *
 * @remarks
 * Apps that offer Facebook login typically call this alongside the Firebase sign-out, so it lives
 * here to keep the `@capacitor-community/facebook-login` import out of the app.
 * Skips the call when the Facebook SDK has no active session — otherwise `FB.logout()` logs
 * "called without an access token" on web and native rejects for email/password users.
 */
export const kitFacebookLogout = async (): Promise<void> => {
  const session = await FacebookLogin.getCurrentAccessToken().catch(() => null);
  if (!session?.accessToken?.token) {
    return;
  }
  await FacebookLogin.logout().catch(() => undefined);
};

/**
 * Sign in with Apple / link, bundled. Native uses the plugin; the web uses the Firebase popup.
 *
 * @remarks
 * - **Native**: `SignInWithApple.authorize()` → `OAuthProvider('apple.com')` credential → the shared
 *   3-mode state machine.
 * - **Web**: `signInWithPopup` / `linkWithPopup` (with `email`/`name` scopes), or, for `credential`,
 *   `reauthenticateWithPopup` then link the email/password. The identity payload for the backend is
 *   synthesized from the popup result.
 *
 * Every failure path (including popup errors) is routed through `onError`.
 */
export const kitAppleLogin = async (auth: Auth, options: KitAppleLoginOptions): Promise<{ status: boolean }> => {
  await options.before?.();
  try {
    if (Capacitor.isNativePlatform()) {
      const authorize = await SignInWithApple.authorize().catch(() => undefined);
      if (!authorize) {
        return { status: false };
      }
      const r = authorize.response;
      const response: KitAppleResponse = {
        user: r.user ?? null,
        email: r.email ?? null,
        givenName: r.givenName ?? null,
        familyName: r.familyName ?? null,
        identityToken: r.identityToken ?? null,
        authorizationCode: r.authorizationCode ?? null,
      };
      const credential = new OAuthProvider('apple.com').credential({ idToken: response.identityToken ?? undefined })!;
      const status = await applyOAuthCredential(auth, credential, options, {
        success: () => options.success?.({ response, mode: options.mode }),
        error: (category, error) => options.error?.(category, error),
      });
      return { status };
    }

    // Web: the popup performs the sign-in/link itself.
    const provider = new OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');

    if (options.mode === 'credential') {
      const user = auth.currentUser;
      try {
        if (!user) {
          throw new Error('kit social: no signed-in user to re-authenticate');
        }
        await reauthenticateWithPopup(user, provider);
        await linkWithCredential(
          user,
          EmailAuthProvider.credential(options.emailLogin.email, options.emailLogin.password),
        );
      } catch (e) {
        await options.error?.(classifyOAuthError(e), e);
        return { status: false };
      }
      await options.success?.({ response: emptyAppleResponse(), mode: 'credential' });
      return { status: true };
    }

    let result;
    try {
      result =
        options.mode === 'new'
          ? await signInWithPopup(auth, provider)
          : await linkWithPopup(requireUser(auth), provider);
    } catch (e) {
      await options.error?.(classifyOAuthError(e), e);
      return { status: false };
    }
    const credential = OAuthProvider.credentialFromResult(result);
    const response: KitAppleResponse = {
      ...emptyAppleResponse(),
      email: result.user?.email ?? null,
      identityToken: credential?.idToken ?? null,
      authorizationCode: credential?.accessToken ?? null,
    };
    await options.success?.({ response, mode: options.mode });
    return { status: true };
  } finally {
    await options.finally?.();
  }
};

const emptyAppleResponse = (): KitAppleResponse => ({
  user: null,
  email: null,
  givenName: null,
  familyName: null,
  identityToken: null,
  authorizationCode: null,
});

const requireUser = (auth: Auth) => {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('kit social: no signed-in user to link');
  }
  return user;
};
