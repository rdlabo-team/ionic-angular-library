import type { Auth, User, UserCredential } from 'firebase/auth';
export type { User, UserCredential } from 'firebase/auth';
// Ops and KIT_FIREBASE_AUTH must resolve to the *same* `firebase/auth` copy. The kit declares
// `firebase` as a peerDependency so the app's single Firebase install is used everywhere; a second
// copy would make signOut/onAuthStateChanged against KIT_FIREBASE_AUTH a silent no-op.
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  linkWithCredential,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  unlink,
  updateEmail,
  updatePassword,
} from 'firebase/auth';
import { Observable } from 'rxjs';

/**
 * Uniform lifecycle hooks for the bundled email/password auth flows — where the app hangs its own
 * side effects on a flow.
 *
 * @remarks
 * The kit performs the Firebase operation and renders nothing itself. `before` runs before the op,
 * `success` on success, `error` on failure (with the raw error — the app presents it, from its own
 * dictionary), and `finally` always. Failures are *not* thrown: value flows resolve to `null` and
 * boolean flows to `false`. Return values are awaited and ignored.
 *
 * @example
 * ```ts
 * kitSignIn(auth, email, password, {
 *   error: (e) => this.presentAuthError(e),   // app's own error dictionary
 *   success: () => this.nav.navigateRoot('/'),
 * });
 * ```
 */
export interface KitAuthHooks {
  before?: () => void | Promise<unknown>;
  success?: () => void | Promise<unknown>;
  error?: (error: unknown) => void | Promise<unknown>;
  finally?: () => void | Promise<unknown>;
}

/** Run a value-returning op through the {@link KitAuthHooks} lifecycle; resolve `null` on failure. */
const runAuthFlow = async <T>(op: () => Promise<T>, hooks?: KitAuthHooks): Promise<T | null> => {
  await hooks?.before?.();
  try {
    const result = await op();
    await hooks?.success?.();
    return result;
  } catch (e) {
    await hooks?.error?.(e);
    return null;
  } finally {
    await hooks?.finally?.();
  }
};

/** Run a void op through the lifecycle; resolve `true` on success, `false` on a (hooked) failure. */
const runAuthFlowVoid = async (op: () => Promise<void>, hooks?: KitAuthHooks): Promise<boolean> => {
  const result = await runAuthFlow(async () => {
    await op();
    return true as const;
  }, hooks);
  return result === true;
};

/**
 * Sign in with email and password.
 *
 * @remarks
 * Bundles the Firebase op so the app never imports `signInWithEmailAndPassword` directly (the SDK
 * stays isolated in the kit). Resolves the credential, or `null` on failure (handed to the `error`
 * hook).
 */
export const kitSignIn = (auth: Auth, email: string, password: string, hooks?: KitAuthHooks): Promise<UserCredential | null> =>
  runAuthFlow(() => signInWithEmailAndPassword(auth, email, password), hooks);

/**
 * Create an account and send the verification email.
 *
 * @remarks
 * Bundles the two-step "create → send verification" sequence. Resolves the credential, or `null` on
 * failure. Any success toast is the caller's, via the `success` hook.
 */
export const kitSignUp = (auth: Auth, email: string, password: string, hooks?: KitAuthHooks): Promise<UserCredential | null> =>
  runAuthFlow(async () => {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(credential.user);
    return credential;
  }, hooks);

/**
 * Sign out.
 *
 * @remarks
 * App-specific cleanup (clearing stores, toasts, navigation, third-party logout) is the caller's,
 * done via the hooks — the kit only owns the Firebase op. `true` on success, `false` on failure.
 */
export const kitSignOut = (auth: Auth, hooks?: KitAuthHooks): Promise<boolean> => runAuthFlowVoid(() => signOut(auth), hooks);

/** Send a password-reset email. `true` on success, `false` on failure. */
export const kitSendPasswordReset = (auth: Auth, email: string, hooks?: KitAuthHooks): Promise<boolean> =>
  runAuthFlowVoid(() => sendPasswordResetEmail(auth, email), hooks);

/**
 * Unlink a linked auth provider (e.g. `'facebook.com'`, `'apple.com'`) from the current user.
 *
 * @remarks
 * Exposed from the core (not `/social`) so an app can unlink without importing `unlink` from
 * `firebase/auth` directly — keeping the invariant that the SDK is only imported inside the kit. Any
 * app-specific step around it (e.g. a backend DELETE before unlinking) goes in the `before` hook.
 * Resolves the updated `User`, or `null` on failure (including when there is no signed-in user).
 */
export const kitUnlinkProvider = (auth: Auth, providerId: string, hooks?: KitAuthHooks): Promise<User | null> =>
  runAuthFlow(() => {
    const user = auth.currentUser;
    if (!user) {
      throw new Error('kitUnlinkProvider: no signed-in user');
    }
    return unlink(user, providerId);
  }, hooks);

/**
 * (Re-)send the verification email to the signed-in user (a no-op when signed out).
 *
 * @remarks
 * `true` on success (including the signed-out no-op), `false` on failure.
 */
export const kitSendEmailVerification = (auth: Auth, hooks?: KitAuthHooks): Promise<boolean> =>
  runAuthFlowVoid(async () => {
    const user = auth.currentUser;
    if (user) {
      await sendEmailVerification(user);
    }
  }, hooks);

/**
 * Change the signed-in user's email and send a verification message to the new address.
 *
 * @remarks
 * For use inside {@link kitReauthWithRetry}'s `mutate` callback (after re-authentication). Uses the
 * same `firebase/auth` copy as {@link KIT_FIREBASE_AUTH} so the dual-firebase-sdk mismatch cannot
 * silently no-op.
 */
export const kitUpdateEmail = async (user: User, newEmail: string): Promise<void> => {
  await updateEmail(user, newEmail);
  await sendEmailVerification(user);
};

/**
 * Change the signed-in user's password.
 *
 * @remarks
 * For use inside {@link kitReauthWithRetry}'s `mutate` callback (after re-authentication).
 */
export const kitUpdatePassword = async (user: User, newPassword: string): Promise<void> => {
  await updatePassword(user, newPassword);
};

/**
 * Sign in anonymously.
 *
 * @remarks
 * Reloads the user after sign-in so `isAnonymous` and provider data are fresh. Resolves the
 * credential, or `null` on failure (handed to the `error` hook).
 */
export const kitSignInAnonymously = (auth: Auth, hooks?: KitAuthHooks): Promise<UserCredential | null> =>
  runAuthFlow(async () => {
    const credential = await signInAnonymously(auth);
    await credential.user.reload();
    return credential;
  }, hooks);

/**
 * Link an email/password credential to the current user (e.g. upgrade an anonymous account).
 *
 * @remarks
 * Reloads the linked user before resolving. Resolves the updated `User`, or `null` on failure.
 */
export const kitLinkEmailPassword = (auth: Auth, email: string, password: string, hooks?: KitAuthHooks): Promise<User | null> =>
  runAuthFlow(async () => {
    const user = auth.currentUser;
    if (!user) {
      throw new Error('kitLinkEmailPassword: no signed-in user');
    }
    const linked = await linkWithCredential(user, EmailAuthProvider.credential(email, password));
    await linked.user.reload();
    return linked.user;
  }, hooks);

// Ops and types come from `firebase/auth` (the single peer-installed copy shared with
// KIT_FIREBASE_AUTH) so apps never import the SDK for covered operations.

/**
 * The current Firebase user as an Observable (emits on every auth-state change; `null` when signed out).
 *
 * @remarks
 * Wraps `firebase/auth`'s `onAuthStateChanged` so consumers get an rxjs stream without pulling in
 * `rxfire`. Emits the current value on subscribe and completes its listener on teardown.
 *
 * @param auth - the Firebase `Auth` instance (inject `KIT_FIREBASE_AUTH`)
 */
export const kitAuthState = (auth: Auth): Observable<User | null> =>
  new Observable<User | null>((subscriber) =>
    onAuthStateChanged(
      auth,
      (user) => subscriber.next(user),
      (err) => subscriber.error(err),
    ),
  );

/**
 * The current user's ID token, or `null` when signed out.
 *
 * @remarks
 * For building `Authorization` / bearer headers in interceptors and services. Failure to fetch a
 * token is **thrown, not swallowed** — the caller decides the fallback (e.g. an empty header) as its
 * own side effect, so the kit never silently hides an auth failure.
 *
 * @param auth - the Firebase `Auth` instance (inject `KIT_FIREBASE_AUTH`)
 * @param forceRefresh - force a token refresh (default `false`)
 * @returns the ID token, or `null` if there is no signed-in user
 * @throws if the token fetch fails for a signed-in user
 */
export const kitGetIdToken = (auth: Auth, forceRefresh = false): Promise<string | null> => {
  const user = auth.currentUser;
  return user ? user.getIdToken(forceRefresh) : Promise.resolve(null);
};

/**
 * Thrown by {@link kitReauthenticateThenMutate} when re-authentication fails.
 *
 * @remarks
 * Carries the underlying Firebase error as {@link cause}. A re-auth failure is not always a wrong
 * password (it can be a lockout, an offline network, or an expired session) — use
 * {@link kitIsWrongPasswordError} to tell them apart.
 */
export class KitReauthError extends Error {
  constructor(cause?: unknown) {
    super('re-authentication failed');
    this.name = 'KitReauthError';
    this.cause = cause;
  }
}

/**
 * Firebase error codes that mean "the current password was wrong".
 *
 * @remarks
 * Any other re-auth failure (lockout, offline, expired session) must NOT be treated as a wrong
 * password. With email enumeration protection (Firebase v10+) a wrong password is reported as
 * `auth/invalid-credential` rather than `auth/wrong-password`, so both are listed.
 */
export const KIT_WRONG_PASSWORD_CODES: ReadonlySet<string> = new Set([
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/missing-password',
]);

/**
 * Whether an error (typically a {@link KitReauthError}) represents a wrong current password.
 *
 * @param e - the caught error
 */
export const kitIsWrongPasswordError = (e: unknown): boolean => {
  const cause = e instanceof KitReauthError ? e.cause : e;
  const code = (cause as { code?: string } | undefined)?.code;
  return code !== undefined && KIT_WRONG_PASSWORD_CODES.has(code);
};

/**
 * Re-authenticate the current user with their email/password, then run a sensitive mutation.
 *
 * @remarks
 * The one non-trivial mechanic every app cloned before changing email/password: build the
 * `EmailAuthProvider` credential, `reauthenticateWithCredential`, and only on success run `mutate`.
 * Pure — no DI, no UI. A re-auth failure throws {@link KitReauthError}; `mutate`'s own error
 * propagates unwrapped.
 *
 * @param auth - the Firebase `Auth` instance
 * @param currentEmail - the current email (for the re-auth credential)
 * @param currentPassword - the current password (for the re-auth credential)
 * @param mutate - the change to run once re-authenticated, receiving the current `User`
 * @throws {@link KitReauthError} if there is no signed-in user or re-authentication fails
 */
export const kitReauthenticateThenMutate = async (
  auth: Auth,
  currentEmail: string,
  currentPassword: string,
  mutate: (user: User) => Promise<void>,
): Promise<void> => {
  const user = auth.currentUser;
  if (!user) {
    throw new KitReauthError('no current user');
  }
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(currentEmail, currentPassword));
  } catch (e) {
    throw new KitReauthError(e);
  }
  await mutate(user);
};

/**
 * The app-supplied side effects for {@link kitReauthWithRetry}.
 *
 * @remarks
 * The kit owns the *control flow* but generates no UI; every user-facing effect (the prompt, the
 * loading overlay) is a callback the app implements, rendering from its own dictionary.
 */
export interface KitReauthWithRetryOptions {
  /**
   * Present the current-password prompt.
   *
   * @remarks
   * A side effect — the app presents whatever it likes (e.g. an `ion-alert` with a masked input and
   * dictionary text). Receives `true` when re-prompting after a wrong password.
   *
   * @returns the entered password, or `null` if the user cancels/dismisses
   */
  prompt: (wrongPasswordRetry: boolean) => Promise<string | null>;
  /**
   * The sensitive change to run once re-authenticated.
   *
   * @remarks
   * Keep this pure — just the Firebase op(s) (e.g. `updatePassword(user, next)`). Loading and other
   * UI are side effects handled by {@link withLoading}, not here.
   */
  mutate: (user: User) => Promise<void>;
  /**
   * Wrap the re-authentication + mutation with a loading indicator (a side effect).
   *
   * @remarks
   * Optional. Runs only after a password is entered, around each attempt — so no loading flashes on a
   * cancelled prompt, and it re-shows on a wrong-password retry. The app implements it (e.g.
   * present/dismiss an `ion-loading`).
   */
  withLoading?: (run: () => Promise<void>) => Promise<void>;
}

/**
 * Run the fleet's canonical "confirm current password → change" flow, re-prompting in place on a
 * wrong password.
 *
 * @remarks
 * Owns the drift-prone *control flow* (the retry loop, the wrong-password classification every app
 * once got wrong, and when to show loading) while generating **no UI** — the prompt and the loading
 * overlay are {@link KitReauthWithRetryOptions | side-effect callbacks} the app supplies. On a wrong
 * password the loop re-prompts instead of dropping the user out of the flow. Any non-wrong-password
 * re-auth failure (lockout, offline, expired session) and any error from `mutate` are re-thrown —
 * re-auth failures unwrapped to the underlying Firebase error so the caller's error dictionary can
 * read its `code`.
 *
 * @param auth - the Firebase `Auth` instance
 * @param currentEmail - the current email (for the re-auth credential)
 * @param options - the pure mutation plus the app's prompt / loading side effects
 * @returns `true` if the mutation completed, `false` if the user cancelled
 * @throws the underlying Firebase error on a non-wrong-password failure, or `mutate`'s own error
 */
export const kitReauthWithRetry = async (auth: Auth, currentEmail: string, options: KitReauthWithRetryOptions): Promise<boolean> => {
  const run = options.withLoading ?? ((fn) => fn());
  let wrongPasswordRetry = false;
  for (;;) {
    const password = await options.prompt(wrongPasswordRetry);
    if (password === null) {
      return false;
    }
    try {
      await run(() => kitReauthenticateThenMutate(auth, currentEmail, password, options.mutate));
      return true;
    } catch (e) {
      if (kitIsWrongPasswordError(e)) {
        wrongPasswordRetry = true;
        continue;
      }
      throw e instanceof KitReauthError && e.cause instanceof Error ? e.cause : e;
    }
  }
};

/** The fleet's 3-state auth status derived from the Firebase user. */
export type KitAuthStatus = 'user' | 'confirm' | 'required';

/** Options for {@link kitResolveAuthStatus}. */
export interface KitResolveAuthStatusOptions {
  /**
   * Provider IDs that count as verified even without `emailVerified` — a social login (e.g.
   * `'facebook.com'`, `'apple.com'`) has no email-verification step but is a real, trusted account.
   */
  readonly verifiedProviders?: readonly string[];
  /**
   * Extra predicate to treat a signed-in user as fully authed regardless of verification — for an
   * e2e bypass or an anonymous-allowed app. Receives the current user.
   */
  readonly allowWhen?: (user: User) => boolean;
}

/**
 * Classify a Firebase user into the fleet's 3-state auth status.
 *
 * @remarks
 * `null` (signed out) → `'required'`. A signed-in user is `'user'` when their email is verified, OR
 * they signed in with one of `verifiedProviders`, OR `allowWhen` returns true; otherwise `'confirm'`
 * (signed in but unverified). This is only the shared classification — app-specific side effects
 * around it (reloading the user to refresh `emailVerified`, caching a token) stay in the app.
 *
 * @example
 * ```ts
 * kitResolveAuthStatus(user, {
 *   verifiedProviders: ['facebook.com', 'apple.com'],
 *   allowWhen: () => environment.e2e,
 * });
 * ```
 */
export const kitResolveAuthStatus = (user: User | null, options?: KitResolveAuthStatusOptions): KitAuthStatus => {
  if (user === null) {
    return 'required';
  }
  const verifiedByProvider = options?.verifiedProviders?.some((id) => user.providerData.some((p) => p.providerId === id)) ?? false;
  const verified = user.emailVerified || verifiedByProvider || (options?.allowWhen?.(user) ?? false);
  return verified ? 'user' : 'confirm';
};
