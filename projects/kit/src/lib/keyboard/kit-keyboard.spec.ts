import type { ElementRef } from '@angular/core';

import { kitKeyboardInit } from './kit-keyboard';

const isNativePlatform = vi.fn();
const getPlatform = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
    getPlatform: () => getPlatform(),
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }) },
}));

function elementRef(): ElementRef {
  return { nativeElement: document.createElement('div') } as unknown as ElementRef;
}

describe('kitKeyboardInit', () => {
  it('returns no handles on non-native (web) platforms — no DI required', async () => {
    isNativePlatform.mockReturnValue(false);
    expect(await kitKeyboardInit(elementRef(), 'transform')).toEqual([]);
  });

  it('registers four keyboard listeners on native platforms', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    const handles = await kitKeyboardInit(elementRef(), 'offset');
    expect(handles).toHaveLength(4);
  });
});
