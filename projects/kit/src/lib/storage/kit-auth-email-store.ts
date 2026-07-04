/**
 * Remember the email a user last entered on the sign-in form so the field can be prefilled next
 * time (the password is never stored).
 *
 * @remarks
 * Storage-agnostic: the helpers take a minimal async key/value store that {@link KitStorageService}
 * satisfies structurally, so they stay pure and unit-testable without DI. `kitRememberEmail`
 * **validates the address before persisting** — a malformed or partial string is silently ignored,
 * so a garbage entry (or a fat-fingered attempt) never becomes the next prefill. A well-formed email
 * that later fails to sign in is still remembered by design: the user simply re-enters/corrects it.
 *
 * These live in the main entry (next to {@link KitStorageService}) rather than in `auth-firebase`,
 * so the `KitAutofillDirective` can consume them without the main entry depending on the Firebase
 * entry.
 */

/** Minimal async key/value store — structurally satisfied by `KitStorageService`. */
export interface KitEmailStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Storage key under which the last entered sign-in email is kept. */
export const KIT_LAST_AUTH_EMAIL_KEY = 'kit:last-auth-email';

/**
 * Angular's `Validators.email` pattern — a pragmatic, RFC-5322-inspired address check. Kept in sync
 * with `@angular/forms` so a value we persist would also pass the form's own email validation.
 */
const EMAIL_REGEXP =
  /^(?=.{1,254}$)(?=.{1,64}@)[-!#$%&'*+/0-9=?A-Z^_`a-z{|}~]+(?:\.[-!#$%&'*+/0-9=?A-Z^_`a-z{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Whether `email` is a well-formed address (matches `@angular/forms` `Validators.email`). */
export const kitIsValidEmail = (email: string): boolean => EMAIL_REGEXP.test(email);

/**
 * Persist the entered email for next time — but only when it is a well-formed address.
 *
 * @param store - the app's storage (e.g. `KitStorageService`)
 * @param email - the entered email; ignored (not stored) when malformed
 * @returns `true` when the value passed validation and was stored, `false` when it was ignored
 */
export const kitRememberEmail = async (store: KitEmailStore, email: string): Promise<boolean> => {
  if (!kitIsValidEmail(email)) {
    return false;
  }
  await store.set(KIT_LAST_AUTH_EMAIL_KEY, email);
  return true;
};

/**
 * Recall the last remembered email.
 *
 * @param store - the app's storage (e.g. `KitStorageService`)
 * @returns the stored email, or `null` when none has been remembered
 */
export const kitRecallEmail = (store: KitEmailStore): Promise<string | null> =>
  store.get<string>(KIT_LAST_AUTH_EMAIL_KEY);

/**
 * Forget the remembered email.
 *
 * @remarks
 * Called when the user intentionally clears or invalidates the field, so a stale prefill is not
 * resurrected next time.
 *
 * @param store - the app's storage (e.g. `KitStorageService`)
 */
export const kitForgetEmail = (store: KitEmailStore): Promise<void> =>
  store.remove(KIT_LAST_AUTH_EMAIL_KEY);
