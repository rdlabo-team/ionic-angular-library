// Firebase auth: the flow library for the fleet. `@angular/fire` is used in *one* place only — the
// DI provider (kit-firebase-provider.ts) — so the planned `@angular/fire` → `firebase/auth` swap is
// provider-local. Apps inject `KIT_FIREBASE_AUTH` and call these pure flow functions, never importing
// the SDK for the covered operations.
//
// The public surface is intentionally curated: dependency wiring plus pure flow functions (each
// pairing a Firebase operation with the uniform `{ before, success, error, finally }` hooks and the
// no-throw null/false contract). The re-auth mechanics (kitReauthenticateThenMutate / KitReauthError
// / KIT_WRONG_PASSWORD_CODES / kitIsWrongPasswordError) are internal details of `kitReauthWithRetry`
// and are not exported.

// Dependency isolation (DI wiring + the Auth token + analytics).
export * from './kit-firebase-provider';

// The canonical error dictionary — an importable constant for apps to render their own error alert.
export { KIT_DEFAULT_AUTH_TEXT } from './kit-firebase-auth-config';
export type { KitAuthText, KitAuthMessage } from './kit-firebase-auth-config';

// Adapters + pure flow functions.
export {
  kitAuthState,
  kitGetIdToken,
  kitResolveAuthStatus,
  kitSignIn,
  kitSignUp,
  kitSignOut,
  kitSendPasswordReset,
  kitSendEmailVerification,
  kitUnlinkProvider,
  kitReauthWithRetry,
} from './kit-firebase-auth';
export type {
  KitAuthHooks,
  KitAuthStatus,
  KitResolveAuthStatusOptions,
  KitReauthWithRetryOptions,
} from './kit-firebase-auth';
