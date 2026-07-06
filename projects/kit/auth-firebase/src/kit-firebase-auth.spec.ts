import { firstValueFrom } from 'rxjs';
import type { Auth } from 'firebase/auth';
import {
  KIT_WRONG_PASSWORD_CODES,
  KitReauthError,
  kitAuthState,
  kitGetIdToken,
  kitIsWrongPasswordError,
  kitReauthWithRetry,
  kitReauthenticateThenMutate,
  kitResolveAuthStatus,
  kitSendEmailVerification,
  kitSendPasswordReset,
  kitSignIn,
  kitSignOut,
  kitSignUp,
  kitUnlinkProvider,
} from './kit-firebase-auth';

const reauthenticateWithCredential = vi.fn();
const onAuthStateChanged = vi.fn();
const signInWithEmailAndPassword = vi.fn();
const createUserWithEmailAndPassword = vi.fn();
const sendEmailVerification = vi.fn();
const sendPasswordResetEmail = vi.fn();
const signOut = vi.fn();
const unlink = vi.fn();

vi.mock('@angular/fire/auth', () => ({
  reauthenticateWithCredential: (...a: unknown[]) => reauthenticateWithCredential(...a),
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  onAuthStateChanged: (...a: unknown[]) => onAuthStateChanged(...a),
  signInWithEmailAndPassword: (...a: unknown[]) => signInWithEmailAndPassword(...a),
  createUserWithEmailAndPassword: (...a: unknown[]) => createUserWithEmailAndPassword(...a),
  sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...a),
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
  signOut: (...a: unknown[]) => signOut(...a),
  unlink: (...a: unknown[]) => unlink(...a),
}));

/** A Firebase-shaped error (extends Error, carries a `code`). */
const fbError = (code: string) => Object.assign(new Error(code), { code });
const authWith = (currentUser: unknown): Auth => ({ currentUser }) as unknown as Auth;

afterEach(() => vi.clearAllMocks());

describe('kitReauthenticateThenMutate', () => {
  it('re-authenticates then runs the mutation with the current user', async () => {
    const user = { uid: 'u1' };
    reauthenticateWithCredential.mockResolvedValueOnce({});
    const mutate = vi.fn().mockResolvedValue(undefined);
    await kitReauthenticateThenMutate(authWith(user), 'me@x.com', 'pw', mutate);
    expect(reauthenticateWithCredential).toHaveBeenCalledWith(user, { email: 'me@x.com', password: 'pw' });
    expect(mutate).toHaveBeenCalledWith(user);
  });

  it('throws KitReauthError and skips the mutation when re-auth fails', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/wrong-password'));
    const mutate = vi.fn();
    await expect(kitReauthenticateThenMutate(authWith({ uid: 'u1' }), 'me@x.com', 'bad', mutate)).rejects.toBeInstanceOf(
      KitReauthError,
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it('throws KitReauthError when there is no signed-in user', async () => {
    await expect(kitReauthenticateThenMutate(authWith(null), 'me@x.com', 'pw', vi.fn())).rejects.toBeInstanceOf(
      KitReauthError,
    );
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it("propagates the mutation's own error unwrapped", async () => {
    reauthenticateWithCredential.mockResolvedValueOnce({});
    const boom = fbError('auth/email-already-in-use');
    await expect(
      kitReauthenticateThenMutate(authWith({ uid: 'u1' }), 'me@x.com', 'pw', () => Promise.reject(boom)),
    ).rejects.toBe(boom);
  });
});

describe('kitIsWrongPasswordError', () => {
  it('is true for the credential-mismatch codes (incl. invalid-credential)', () => {
    for (const code of KIT_WRONG_PASSWORD_CODES) {
      expect(kitIsWrongPasswordError(new KitReauthError(fbError(code)))).toBe(true);
    }
  });
  it('is false for a lockout / offline / unrelated error', () => {
    expect(kitIsWrongPasswordError(new KitReauthError(fbError('auth/too-many-requests')))).toBe(false);
    expect(kitIsWrongPasswordError(new KitReauthError(fbError('auth/network-request-failed')))).toBe(false);
    expect(kitIsWrongPasswordError(new KitReauthError('no current user'))).toBe(false);
  });
  it('reads a bare FirebaseError too', () => {
    expect(kitIsWrongPasswordError(fbError('auth/wrong-password'))).toBe(true);
  });
});

describe('kitReauthWithRetry', () => {
  it('runs the flow on the first correct password', async () => {
    reauthenticateWithCredential.mockResolvedValueOnce({});
    const mutate = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.fn().mockResolvedValueOnce('pw');
    const ok = await kitReauthWithRetry(authWith({ uid: 'u1' }), 'me@x.com', { prompt, mutate });
    expect(ok).toBe(true);
    expect(prompt).toHaveBeenCalledWith(false);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('returns false and never re-auths when the prompt is cancelled', async () => {
    const mutate = vi.fn();
    const ok = await kitReauthWithRetry(authWith({ uid: 'u1' }), 'me@x.com', { prompt: async () => null, mutate });
    expect(ok).toBe(false);
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('re-prompts (with wrongPasswordRetry=true) on a wrong password, then succeeds', async () => {
    reauthenticateWithCredential.mockRejectedValueOnce(fbError('auth/invalid-credential')).mockResolvedValueOnce({});
    const mutate = vi.fn().mockResolvedValue(undefined);
    const prompt = vi.fn().mockResolvedValueOnce('bad').mockResolvedValueOnce('good');
    const ok = await kitReauthWithRetry(authWith({ uid: 'u1' }), 'me@x.com', { prompt, mutate });
    expect(ok).toBe(true);
    expect(prompt.mock.calls).toEqual([[false], [true]]);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a lockout; re-throws the underlying FirebaseError (with code)', async () => {
    const lockout = fbError('auth/too-many-requests');
    reauthenticateWithCredential.mockRejectedValueOnce(lockout);
    const prompt = vi.fn().mockResolvedValueOnce('pw');
    await expect(kitReauthWithRetry(authWith({ uid: 'u1' }), 'me@x.com', { prompt, mutate: vi.fn() })).rejects.toBe(lockout);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('wraps re-auth+mutation with withLoading (a side effect), not the prompt', async () => {
    reauthenticateWithCredential.mockResolvedValueOnce({});
    const order: string[] = [];
    const prompt = vi.fn(async () => {
      order.push('prompt');
      return 'pw';
    });
    const mutate = vi.fn(async () => {
      order.push('mutate');
    });
    const withLoading = vi.fn(async (run: () => Promise<void>) => {
      order.push('loading:on');
      await run();
      order.push('loading:off');
    });
    const ok = await kitReauthWithRetry(authWith({ uid: 'u1' }), 'me@x.com', { prompt, mutate, withLoading });
    expect(ok).toBe(true);
    expect(order).toEqual(['prompt', 'loading:on', 'mutate', 'loading:off']);
  });
});

describe('bundled email/password flows (uniform hooks + no-throw null/false)', () => {
  it('kitSignIn resolves the credential and runs before/success/finally on success', async () => {
    signInWithEmailAndPassword.mockResolvedValueOnce({ user: { uid: 'u1' } });
    const order: string[] = [];
    const hooks = {
      before: () => void order.push('before'),
      success: () => void order.push('success'),
      error: () => void order.push('error'),
      finally: () => void order.push('finally'),
    };
    expect(await kitSignIn(authWith(null), 'a@b.com', 'pw', hooks)).toEqual({ user: { uid: 'u1' } });
    expect(order).toEqual(['before', 'success', 'finally']);
  });

  it('kitSignIn hands the raw error to the error hook, runs finally, and resolves null (no throw)', async () => {
    const boom = fbError('auth/wrong-password');
    signInWithEmailAndPassword.mockRejectedValueOnce(boom);
    const error = vi.fn();
    const fin = vi.fn();
    expect(await kitSignIn(authWith(null), 'a@b.com', 'bad', { error, finally: fin })).toBeNull();
    expect(error).toHaveBeenCalledWith(boom);
    expect(fin).toHaveBeenCalledTimes(1);
  });

  it('kitSignUp creates the account then sends verification', async () => {
    const user = { uid: 'u1' };
    createUserWithEmailAndPassword.mockResolvedValueOnce({ user });
    sendEmailVerification.mockResolvedValueOnce(undefined);
    expect(await kitSignUp(authWith(null), 'a@b.com', 'pw')).toEqual({ user });
    expect(sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it('kitSignUp resolves null and does not send verification when creation fails', async () => {
    const boom = fbError('auth/email-already-in-use');
    createUserWithEmailAndPassword.mockRejectedValueOnce(boom);
    const error = vi.fn();
    expect(await kitSignUp(authWith(null), 'a@b.com', 'pw', { error })).toBeNull();
    expect(error).toHaveBeenCalledWith(boom);
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it('kitSignOut / kitSendPasswordReset resolve true and delegate to the SDK', async () => {
    signOut.mockResolvedValueOnce(undefined);
    expect(await kitSignOut(authWith(null))).toBe(true);
    expect(signOut).toHaveBeenCalled();

    sendPasswordResetEmail.mockResolvedValueOnce(undefined);
    expect(await kitSendPasswordReset(authWith(null), 'a@b.com')).toBe(true);
    expect(sendPasswordResetEmail).toHaveBeenCalled();
  });

  it('kitSignOut resolves false and calls the error hook on failure', async () => {
    const boom = fbError('auth/network-request-failed');
    signOut.mockRejectedValueOnce(boom);
    const error = vi.fn();
    expect(await kitSignOut(authWith(null), { error })).toBe(false);
    expect(error).toHaveBeenCalledWith(boom);
  });

  it('kitSendEmailVerification is a no-op (still true) when signed out, sends otherwise', async () => {
    expect(await kitSendEmailVerification(authWith(null))).toBe(true);
    expect(sendEmailVerification).not.toHaveBeenCalled();

    const user = { uid: 'u1' };
    sendEmailVerification.mockResolvedValueOnce(undefined);
    expect(await kitSendEmailVerification(authWith(user))).toBe(true);
    expect(sendEmailVerification).toHaveBeenCalledWith(user);
  });

  it('kitUnlinkProvider unlinks the current user; resolves null (via error hook) when signed out', async () => {
    const user = { uid: 'u1' };
    unlink.mockResolvedValueOnce(user);
    expect(await kitUnlinkProvider(authWith(user), 'facebook.com')).toBe(user);
    expect(unlink).toHaveBeenCalledWith(user, 'facebook.com');

    const error = vi.fn();
    expect(await kitUnlinkProvider(authWith(null), 'apple.com', { error })).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe('kitResolveAuthStatus', () => {
  const user = (over: Partial<{ emailVerified: boolean; providerData: { providerId: string }[] }> = {}) =>
    ({ emailVerified: false, providerData: [], ...over }) as unknown as import('firebase/auth').User;

  it("is 'required' when signed out", () => {
    expect(kitResolveAuthStatus(null)).toBe('required');
  });

  it("is 'user' when the email is verified", () => {
    expect(kitResolveAuthStatus(user({ emailVerified: true }))).toBe('user');
  });

  it("is 'confirm' when signed in but unverified", () => {
    expect(kitResolveAuthStatus(user({ emailVerified: false }))).toBe('confirm');
  });

  it("treats a verifiedProviders login as 'user' even when unverified", () => {
    const u = user({ emailVerified: false, providerData: [{ providerId: 'facebook.com' }] });
    expect(kitResolveAuthStatus(u, { verifiedProviders: ['facebook.com', 'apple.com'] })).toBe('user');
    // a provider not in the list does not count
    expect(kitResolveAuthStatus(u, { verifiedProviders: ['apple.com'] })).toBe('confirm');
  });

  it("treats allowWhen()===true as 'user' (e.g. e2e bypass)", () => {
    expect(kitResolveAuthStatus(user(), { allowWhen: () => true })).toBe('user');
    expect(kitResolveAuthStatus(user(), { allowWhen: () => false })).toBe('confirm');
  });
});

describe('kitAuthState / kitGetIdToken', () => {
  it('emits the current user from onAuthStateChanged', async () => {
    const user = { uid: 'u1' };
    onAuthStateChanged.mockImplementation((_auth: Auth, next: (u: unknown) => void) => {
      next(user);
      return () => {};
    });
    expect(await firstValueFrom(kitAuthState(authWith(user)))).toBe(user);
  });

  it('returns the id token for a signed-in user, null when signed out', async () => {
    const getIdToken = vi.fn().mockResolvedValue('tok');
    expect(await kitGetIdToken(authWith({ getIdToken }), true)).toBe('tok');
    expect(getIdToken).toHaveBeenCalledWith(true);
    expect(await kitGetIdToken(authWith(null))).toBeNull();
  });

  it('throws (does not swallow) when the token fetch fails', async () => {
    const boom = fbError('auth/network-request-failed');
    await expect(kitGetIdToken(authWith({ getIdToken: () => Promise.reject(boom) }))).rejects.toBe(boom);
  });
});
