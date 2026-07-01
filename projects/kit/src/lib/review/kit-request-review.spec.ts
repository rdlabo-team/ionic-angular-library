import { kitRequestReview } from './kit-request-review';

const isNativePlatform = vi.fn();
const prefGet = vi.fn();
const prefSet = vi.fn();
const requestReview = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform() },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (...args: unknown[]) => prefGet(...args),
    set: (...args: unknown[]) => prefSet(...args),
  },
}));

vi.mock('@capacitor-community/in-app-review', () => ({
  InAppReview: { requestReview: () => requestReview() },
}));

const OPTS = { storageKey: 'lastRequestRate', throttleMonths: 3 };
const monthsAgo = (n: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.getTime().toString();
};

describe('kitRequestReview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prefSet.mockResolvedValue(undefined);
    requestReview.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('is a no-op on non-native (web) platforms', async () => {
    isNativePlatform.mockReturnValue(false);
    await kitRequestReview(OPTS);
    expect(requestReview).not.toHaveBeenCalled();
    expect(prefGet).not.toHaveBeenCalled();
  });

  it('requests and records when there is no prior timestamp', async () => {
    isNativePlatform.mockReturnValue(true);
    prefGet.mockResolvedValue({ value: null });
    const p = kitRequestReview(OPTS);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(requestReview).toHaveBeenCalledOnce();
    expect(prefSet).toHaveBeenCalledWith({ key: 'lastRequestRate', value: expect.any(String) });
  });

  it('requests again once the throttle window has elapsed', async () => {
    isNativePlatform.mockReturnValue(true);
    prefGet.mockResolvedValue({ value: monthsAgo(6) });
    const p = kitRequestReview(OPTS);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(requestReview).toHaveBeenCalledOnce();
  });

  it('stays silent within the throttle window', async () => {
    isNativePlatform.mockReturnValue(true);
    prefGet.mockResolvedValue({ value: monthsAgo(1) });
    const p = kitRequestReview(OPTS);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(requestReview).not.toHaveBeenCalled();
    expect(prefSet).not.toHaveBeenCalled();
  });
});
