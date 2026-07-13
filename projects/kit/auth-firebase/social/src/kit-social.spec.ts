import type { Auth } from 'firebase/auth';
import { kitAppleLogin, kitFacebookLogin, kitFacebookLogout } from './kit-social';

const signInWithCredential = vi.fn();
const linkWithCredential = vi.fn();
const reauthenticateWithCredential = vi.fn();
const signInWithPopup = vi.fn();
const linkWithPopup = vi.fn();
const reauthenticateWithPopup = vi.fn();

const isNativePlatform = vi.fn();
const getPlatform = vi.fn();
const facebookLogin = vi.fn();
const facebookLogout = vi.fn();
const facebookGetCurrentAccessToken = vi.fn();
const appleAuthorize = vi.fn();

vi.mock('firebase/auth', () => ({
  signInWithCredential: (...a: unknown[]) => signInWithCredential(...a),
  linkWithCredential: (...a: unknown[]) => linkWithCredential(...a),
  reauthenticateWithCredential: (...a: unknown[]) => reauthenticateWithCredential(...a),
  signInWithPopup: (...a: unknown[]) => signInWithPopup(...a),
  linkWithPopup: (...a: unknown[]) => linkWithPopup(...a),
  reauthenticateWithPopup: (...a: unknown[]) => reauthenticateWithPopup(...a),
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  FacebookAuthProvider: { credential: (t: string) => ({ fb: t }) },
  OAuthProvider: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
    credential(o: unknown) {
      return { oauth: o, providerId: this.id };
    }
    addScope() {}
    static credentialFromResult() {
      return { idToken: 'id-token', accessToken: 'access-token' };
    }
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform(), getPlatform: () => getPlatform() },
}));
vi.mock('@capacitor-community/facebook-login', () => ({
  FacebookLogin: {
    login: (...a: unknown[]) => facebookLogin(...a),
    logout: (...a: unknown[]) => facebookLogout(...a),
    getCurrentAccessToken: (...a: unknown[]) => facebookGetCurrentAccessToken(...a),
  },
}));
vi.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...a: unknown[]) => appleAuthorize(...a) },
}));

const fbError = (code: string) => Object.assign(new Error(code), { code });
const authWith = (currentUser: unknown): Auth => ({ currentUser }) as unknown as Auth;

const hooks = () => ({
  before: vi.fn().mockResolvedValue(undefined),
  success: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
  finally: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  isNativePlatform.mockReturnValue(true);
  getPlatform.mockReturnValue('android');
});
afterEach(() => vi.clearAllMocks());

describe('kitFacebookLogin', () => {
  it("mode 'new' signs in, then runs before → success (with payload) → finally", async () => {
    facebookLogin.mockResolvedValueOnce({ accessToken: { token: 'tok' } });
    signInWithCredential.mockResolvedValueOnce({ user: { uid: 'u1' } });
    const h = hooks();

    const res = await kitFacebookLogin(authWith(null), { mode: 'new', permissions: [], ...h });

    expect(res).toEqual({ status: true });
    expect(signInWithCredential).toHaveBeenCalled();
    expect(h.before).toHaveBeenCalledTimes(1);
    expect(h.success).toHaveBeenCalledWith({ accessToken: 'tok', mode: 'new' });
    expect(h.error).not.toHaveBeenCalled();
    expect(h.finally).toHaveBeenCalledTimes(1);
  });

  it('returns {status:false} when the plugin login is cancelled/fails', async () => {
    facebookLogin.mockResolvedValueOnce(undefined);
    const h = hooks();
    const res = await kitFacebookLogin(authWith(null), { mode: 'new', permissions: [], ...h });
    expect(res).toEqual({ status: false });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("classifies 'already-in-use' and calls error without success (finally still runs)", async () => {
    facebookLogin.mockResolvedValueOnce({ accessToken: { token: 'tok' } });
    signInWithCredential.mockRejectedValueOnce(fbError('auth/credential-already-in-use'));
    const h = hooks();
    const res = await kitFacebookLogin(authWith(null), { mode: 'new', permissions: [], ...h });
    expect(res).toEqual({ status: false });
    expect(h.error).toHaveBeenCalledWith('already-in-use', expect.anything());
    expect(h.success).not.toHaveBeenCalled();
    expect(h.finally).toHaveBeenCalledTimes(1);
  });

  it('uses the iOS OIDC nonce path (OAuthProvider) on native iOS', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    facebookLogin.mockResolvedValueOnce({ accessToken: { token: 'tok' } });
    signInWithCredential.mockResolvedValueOnce({});
    const h = hooks();
    await kitFacebookLogin(authWith(null), { mode: 'new', permissions: [], ...h });
    const cred = signInWithCredential.mock.calls[0][1] as { providerId?: string };
    expect(cred.providerId).toBe('facebook.com'); // OAuthProvider credential, not FacebookAuthProvider
  });

  it("mode 'link' links then afterCredential + onSuccess", async () => {
    facebookLogin.mockResolvedValueOnce({ accessToken: { token: 'tok' } });
    linkWithCredential.mockResolvedValueOnce({});
    const h = hooks();
    const res = await kitFacebookLogin(authWith({ uid: 'u1' }), { mode: 'link', permissions: [], ...h });
    expect(res).toEqual({ status: true });
    expect(linkWithCredential).toHaveBeenCalled();
    expect(h.success).toHaveBeenCalledWith({ accessToken: 'tok', mode: 'link' });
  });

  it("mode 'credential' re-auths then links the email credential", async () => {
    facebookLogin.mockResolvedValueOnce({ accessToken: { token: 'tok' } });
    reauthenticateWithCredential.mockResolvedValueOnce({});
    linkWithCredential.mockResolvedValueOnce({});
    const h = hooks();
    const res = await kitFacebookLogin(authWith({ uid: 'u1' }), {
      mode: 'credential',
      emailLogin: { email: 'e@x.com', password: 'pw' },
      permissions: [],
      ...h,
    });
    expect(res).toEqual({ status: true });
    expect(reauthenticateWithCredential).toHaveBeenCalled();
    expect(linkWithCredential).toHaveBeenCalledWith({ uid: 'u1' }, { email: 'e@x.com', password: 'pw' });
  });
});

describe('kitAppleLogin', () => {
  it('native: authorizes, applies credential, success gets the apple response', async () => {
    isNativePlatform.mockReturnValue(true);
    appleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'it', email: 'a@b.com' } });
    signInWithCredential.mockResolvedValueOnce({});
    const h = hooks();
    const res = await kitAppleLogin(authWith(null), { mode: 'new', ...h });
    expect(res).toEqual({ status: true });
    expect(h.success).toHaveBeenCalledWith({
      response: expect.objectContaining({ identityToken: 'it', email: 'a@b.com' }),
      mode: 'new',
    });
    expect(h.finally).toHaveBeenCalledTimes(1);
  });

  it('native: cancelled authorize → {status:false}', async () => {
    isNativePlatform.mockReturnValue(true);
    appleAuthorize.mockResolvedValueOnce(undefined);
    const h = hooks();
    expect(await kitAppleLogin(authWith(null), { mode: 'new', ...h })).toEqual({ status: false });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("web 'new': uses signInWithPopup, synthesizes the response, routes errors to error", async () => {
    isNativePlatform.mockReturnValue(false);
    signInWithPopup.mockResolvedValueOnce({ user: { email: 'a@b.com' } });
    const h = hooks();
    const res = await kitAppleLogin(authWith(null), { mode: 'new', ...h });
    expect(res).toEqual({ status: true });
    expect(signInWithPopup).toHaveBeenCalled();
    expect(h.success).toHaveBeenCalledWith({
      response: expect.objectContaining({ email: 'a@b.com', identityToken: 'id-token' }),
      mode: 'new',
    });

    signInWithPopup.mockRejectedValueOnce(fbError('auth/popup-closed-by-user'));
    const h2 = hooks();
    expect(await kitAppleLogin(authWith(null), { mode: 'new', ...h2 })).toEqual({ status: false });
    expect(h2.error).toHaveBeenCalledWith('other', expect.anything());
    expect(h2.finally).toHaveBeenCalledTimes(1);
  });
});

describe('kitFacebookLogout', () => {
  beforeEach(() => {
    facebookLogout.mockResolvedValue(undefined);
    facebookGetCurrentAccessToken.mockResolvedValue({ accessToken: { token: 'fb-token' } });
  });

  it('logs out when the Facebook SDK has an active session', async () => {
    await kitFacebookLogout();
    expect(facebookGetCurrentAccessToken).toHaveBeenCalled();
    expect(facebookLogout).toHaveBeenCalled();
  });

  it('skips logout when there is no Facebook access token', async () => {
    facebookGetCurrentAccessToken.mockRejectedValueOnce({ accessToken: { token: null } });
    await kitFacebookLogout();
    expect(facebookLogout).not.toHaveBeenCalled();
  });

  it('skips logout when getCurrentAccessToken returns a null token', async () => {
    facebookGetCurrentAccessToken.mockResolvedValueOnce({ accessToken: { token: null } });
    await kitFacebookLogout();
    expect(facebookLogout).not.toHaveBeenCalled();
  });
});
