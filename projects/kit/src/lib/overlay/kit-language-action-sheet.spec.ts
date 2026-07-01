import { ActionSheetController } from '@ionic/angular/standalone';

import { kitPresentLanguageActionSheet } from './kit-language-action-sheet';

function fakeActionSheet(dismissData: unknown) {
  return {
    present: vi.fn().mockResolvedValue(undefined),
    onDidDismiss: vi.fn().mockResolvedValue({ data: dismissData }),
  };
}

function setup(dismissData: unknown) {
  const sheet = fakeActionSheet(dismissData);
  const ctrl = { create: vi.fn().mockResolvedValue(sheet) } as unknown as ActionSheetController;
  return { ctrl, sheet, create: (ctrl as unknown as { create: ReturnType<typeof vi.fn> }).create };
}

const baseOptions = {
  header: 'Language',
  locales: [
    { text: 'English', data: 'en-US' },
    { text: '日本語', data: 'ja' },
  ],
  cancelText: 'Cancel',
  currentLocale: 'ja',
  currentPath: '/home',
  pathnameStorageKey: 'pathnameBeforeRedirect',
  buildRedirectUrl: (locale: string) => `https://app.test/${locale.toLowerCase()}/index.html`,
  enabled: true,
};

describe('kitPresentLanguageActionSheet', () => {
  let replace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, origin: 'https://app.test', replace },
    });
    sessionStorage.clear();
    localStorage.clear();
  });

  it('builds locale buttons plus a cancel(role) button', async () => {
    const { ctrl, create } = setup(undefined);
    await kitPresentLanguageActionSheet(ctrl, baseOptions);
    const args = create.mock.calls[0][0];
    expect(args.header).toBe('Language');
    expect(args.buttons).toHaveLength(3);
    expect(args.buttons[0]).toMatchObject({ text: 'English', data: 'en-US' });
    expect(args.buttons[2]).toMatchObject({ text: 'Cancel', role: 'cancel' });
  });

  it('redirects and records state on a new selection', async () => {
    const { ctrl } = setup('en-US');
    await kitPresentLanguageActionSheet(ctrl, baseOptions);
    expect(sessionStorage.getItem('pathnameBeforeRedirect')).toBe('/home');
    expect(localStorage.getItem('locale')).toBe('en-US');
    expect(replace).toHaveBeenCalledWith('https://app.test/en-us/index.html');
  });

  it('does nothing when the same locale is chosen', async () => {
    const { ctrl } = setup('ja'); // equals currentLocale
    await kitPresentLanguageActionSheet(ctrl, baseOptions);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does nothing on cancel (no data)', async () => {
    const { ctrl } = setup(undefined);
    await kitPresentLanguageActionSheet(ctrl, baseOptions);
    expect(replace).not.toHaveBeenCalled();
  });

  it('presents without navigating when disabled', async () => {
    const { ctrl, sheet } = setup('en-US');
    await kitPresentLanguageActionSheet(ctrl, { ...baseOptions, enabled: false });
    expect(sheet.present).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });
});
