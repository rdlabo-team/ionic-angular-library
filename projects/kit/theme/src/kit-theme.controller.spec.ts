import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { KitStorageService } from '@rdlabo/ionic-angular-kit';

import { KitThemeController } from './kit-theme.controller';
import { provideKitTheme } from './theme-config';

const isNativePlatform = vi.fn();
const getPlatform = vi.fn();
const setStyle = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
    getPlatform: () => getPlatform(),
  },
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: (...args: unknown[]) => setStyle(...args) },
  Style: { Dark: 'DARK', Light: 'LIGHT' },
}));

function fakeMediaQueryList(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  return {
    matches,
    addEventListener: vi.fn((_type: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb)),
    listenerCount: () => listeners.size,
    emit(next: boolean) {
      this.matches = next;
      listeners.forEach((cb) => cb({ matches: next }));
    },
  };
}

const CONFIG = {
  storageKey: 'theme',
  darkClasses: ['ion-palette-dark', 'a2ui-dark'],
  lightClasses: ['a2ui-light'],
};

function setup(stored: 'light' | 'dark' | null = null, mql = fakeMediaQueryList(false)) {
  isNativePlatform.mockReturnValue(false);
  const store = { get: vi.fn().mockResolvedValue(stored), set: vi.fn().mockResolvedValue(undefined) };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      KitThemeController,
      provideKitTheme(CONFIG),
      { provide: KitStorageService, useValue: store },
    ],
  });
  return { controller: TestBed.inject(KitThemeController), store, mql };
}

const cls = () => document.documentElement.classList;

describe('KitThemeController', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    document.documentElement.className = '';
    vi.clearAllMocks();
  });

  it('applies a stored dark theme without following the OS', async () => {
    const { controller, mql } = setup('dark');
    await controller.setDefaultThemeMode();
    expect(cls().contains('ion-palette-dark')).toBe(true);
    expect(cls().contains('a2ui-dark')).toBe(true);
    expect(cls().contains('a2ui-light')).toBe(false);
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });

  it('follows the OS setting when nothing is stored', async () => {
    const mql = fakeMediaQueryList(true);
    const { controller } = setup(null, mql);
    await controller.setDefaultThemeMode();
    expect(mql.addEventListener).toHaveBeenCalledOnce();
    expect(cls().contains('ion-palette-dark')).toBe(true);
    // A later OS change flips the theme while still following.
    mql.emit(false);
    expect(cls().contains('ion-palette-dark')).toBe(false);
    expect(cls().contains('a2ui-light')).toBe(true);
  });

  it('changeTheme persists the choice and detaches the OS listener (no leak)', async () => {
    const mql = fakeMediaQueryList(false);
    const { controller, store } = setup(null, mql);
    await controller.setDefaultThemeMode(); // starts following
    await controller.changeTheme(true);
    expect(store.set).toHaveBeenCalledWith('theme', 'dark');
    expect(mql.removeEventListener).toHaveBeenCalledOnce();
    expect(mql.listenerCount()).toBe(0);
    // A subsequent OS change must NOT override the pinned choice.
    mql.emit(false);
    expect(cls().contains('ion-palette-dark')).toBe(true);
  });

  it('emits the active mode on themeSubject', async () => {
    const { controller } = setup('light');
    const seen: string[] = [];
    controller.themeSubject.subscribe((m) => seen.push(m));
    await controller.setDefaultThemeMode();
    await controller.changeTheme(true);
    expect(seen).toEqual(['light', 'light', 'dark']); // seed, applied light, changed dark
  });

  it('syncs the Android native status bar only', async () => {
    const { controller } = setup('dark');
    isNativePlatform.mockReturnValue(true);
    getPlatform.mockReturnValue('android');
    await controller.changeTheme(true);
    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' });

    setStyle.mockClear();
    getPlatform.mockReturnValue('ios');
    await controller.changeTheme(false);
    expect(setStyle).not.toHaveBeenCalled();
  });
});
