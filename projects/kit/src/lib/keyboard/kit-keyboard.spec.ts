import type { ElementRef } from '@angular/core';

import { kitKeyboardInit } from './kit-keyboard';

const isNativePlatform = vi.fn();
const getPlatform = vi.fn();
const addListener = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
    getPlatform: () => getPlatform(),
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: { addListener: (...args: unknown[]) => addListener(...args) },
}));

type KeyboardEventName = 'keyboardWillShow' | 'keyboardWillHide' | 'keyboardDidShow' | 'keyboardDidHide';
type KeyboardCallback = (info: { keyboardHeight: number }) => void;

function elementRef(tagName = 'div'): ElementRef<HTMLElement> {
  return { nativeElement: document.createElement(tagName) };
}

describe('kitKeyboardInit', () => {
  const listeners = new Map<KeyboardEventName, KeyboardCallback>();

  beforeEach(() => {
    listeners.clear();
    addListener.mockImplementation((event: KeyboardEventName, callback: KeyboardCallback) => {
      listeners.set(event, callback);
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) });
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    document.body.style.setProperty('--ion-safe-area-bottom', '20px');
  });

  afterEach(() => {
    document.body.style.removeProperty('--ion-safe-area-bottom');
    vi.unstubAllGlobals();
  });

  it('returns no handles on non-native (web) platforms — no DI required', async () => {
    isNativePlatform.mockReturnValue(false);
    expect(await kitKeyboardInit(elementRef(), 'transform')).toEqual([]);
  });

  it('registers four keyboard listeners on native platforms', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    const handles = await kitKeyboardInit(elementRef(), 'offset');
    expect(handles).toHaveLength(4);
    expect(addListener.mock.calls.map(([event]) => event)).toEqual([
      'keyboardWillShow',
      'keyboardWillHide',
      'keyboardDidShow',
      'keyboardDidHide',
    ]);
  });

  it.each([
    ['offset', '--offset-bottom', '-300px'],
    ['keyboard-offset', '--padding-bottom', '300px'],
  ] as const)('applies and resets the %s CSS property on iOS', async (type, property, value) => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    const ref = elementRef();
    await kitKeyboardInit(ref, type);

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 300 });
    expect(ref.nativeElement.classList.contains('show-keyboard')).toBe(true);
    expect(ref.nativeElement.style.getPropertyValue(property)).toBe(value);

    listeners.get('keyboardWillHide')?.({ keyboardHeight: 0 });
    expect(ref.nativeElement.classList.contains('show-keyboard')).toBe(false);
    expect(ref.nativeElement.style.getPropertyValue(property)).toBe('0px');
  });

  it('applies the safe-area-adjusted transform and resets it on iOS', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    const ref = elementRef();
    await kitKeyboardInit(ref, 'transform');

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 300 });
    expect(ref.nativeElement.style.transition).toBe('transform 420ms');
    expect(ref.nativeElement.style.willChange).toBe('transform');
    expect(ref.nativeElement.style.transform).toBe('translateY(-280px)');

    listeners.get('keyboardWillHide')?.({ keyboardHeight: 0 });
    expect(ref.nativeElement.style.transition).toBe('transform 0ms');
    expect(ref.nativeElement.style.transform).toBe('translateY(0px)');
  });

  it('preserves an explicit keyboard offset instead of applying a second inset', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('ios');
    const ref = elementRef();
    ref.nativeElement.style.setProperty('--keyboard-offset', '12px');
    await kitKeyboardInit(ref, 'offset');

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 300 });
    expect(ref.nativeElement.style.getPropertyValue('--offset-bottom')).toBe('');
  });

  it('only toggles the Ionic footer workaround on Android transform mode', async () => {
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('android');
    const ref = elementRef('ion-footer');
    ref.nativeElement.classList.add('footer-toolbar-padding');
    await kitKeyboardInit(ref, 'transform');

    listeners.get('keyboardWillShow')?.({ keyboardHeight: 300 });
    expect(ref.nativeElement.classList.contains('footer-toolbar-padding')).toBe(false);
    expect(ref.nativeElement.classList.contains('show-keyboard')).toBe(false);

    listeners.get('keyboardWillHide')?.({ keyboardHeight: 0 });
    expect(ref.nativeElement.classList.contains('footer-toolbar-padding')).toBe(true);
  });
});
