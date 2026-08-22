import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

import { kitImpact } from './haptics';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: vi.fn(),
  },
  ImpactStyle: {
    Light: 'LIGHT',
    Medium: 'MEDIUM',
    Heavy: 'HEAVY',
  },
}));

describe('kitImpact', () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(Haptics.impact).mockReset().mockResolvedValue(undefined);
  });

  it('is a no-op on the web', async () => {
    await kitImpact(ImpactStyle.Heavy);

    expect(Haptics.impact).not.toHaveBeenCalled();
  });

  it('requests light impact by default on native platforms', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);

    await kitImpact();

    expect(Haptics.impact).toHaveBeenCalledExactlyOnceWith({ style: ImpactStyle.Light });
  });

  it('forwards the requested impact style on native platforms', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);

    await kitImpact(ImpactStyle.Heavy);

    expect(Haptics.impact).toHaveBeenCalledExactlyOnceWith({ style: ImpactStyle.Heavy });
  });

  it('propagates a native plugin failure to direct callers', async () => {
    const error = new Error('haptics unavailable');
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Haptics.impact).mockRejectedValueOnce(error);

    await expect(kitImpact()).rejects.toBe(error);
  });
});
