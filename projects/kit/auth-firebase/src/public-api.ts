// Firebase auth: the flow library for the fleet. The `firebase/auth` SDK is initialized in *one*
// place only — the DI provider (kit-firebase-provider.ts). Apps inject `KIT_FIREBASE_AUTH` and call
// these pure flow functions, never importing the SDK for the covered operations.
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
  kitUpdateEmail,
  kitUpdatePassword,
  kitSignInAnonymously,
  kitLinkEmailPassword,
  kitUnlinkProvider,
  kitReauthWithRetry,
} from './kit-firebase-auth';
export type {
  KitAuthHooks,
  KitAuthStatus,
  KitResolveAuthStatusOptions,
  KitReauthWithRetryOptions,
  User,
  UserCredential,
} from './kit-firebase-auth';
