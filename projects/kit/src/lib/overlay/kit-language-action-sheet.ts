import { ActionSheetController } from '@ionic/angular/standalone';

/** One selectable language in {@link kitPresentLanguageActionSheet}. */
export interface KitLanguageOption {
  /** Button label shown to the user (e.g. `English`, `日本語`). */
  readonly text: string;
  /** Locale identifier returned when this option is chosen (e.g. `en-US`, `ja`). */
  readonly data: string;
}

/**
 * Options for {@link kitPresentLanguageActionSheet}.
 *
 * @remarks
 * The kit ships no strings or URLs of its own: labels, the locale list, and the redirect-URL mapping
 * are all supplied by the caller, so a multilingual app passes `$localize`-resolved text and its own
 * per-locale build paths.
 */
export interface KitLanguageActionSheetOptions {
  /** Action-sheet header text. */
  readonly header: string;
  /** Selectable languages, in display order. */
  readonly locales: readonly KitLanguageOption[];
  /** Text for the cancel button. */
  readonly cancelText: string;
  /** The currently active locale; selecting the same value is a no-op. Normalize before passing. */
  readonly currentLocale: string;
  /** The current in-app path (e.g. `router.url`), stashed so the app can restore it after the reload. */
  readonly currentPath: string;
  /** `sessionStorage` key under which {@link currentPath} is stored. */
  readonly pathnameStorageKey: string;
  /** Maps a chosen locale to the URL to navigate to (the app's per-locale build entry point). */
  readonly buildRedirectUrl: (locale: string) => string;
  /** Gate for the redirect — pass `false` (e.g. outside production) to present without navigating. */
  readonly enabled: boolean;
}

/**
 * Present a language picker and, on a new selection, reload the app at that locale's entry point.
 *
 * @remarks
 * A plain function (the `ActionSheetController` is passed in, so nothing is injected) that unifies the
 * language-switch flow duplicated across apps. On a changed selection while {@link enabled} it stashes
 * the current path in `sessionStorage` (so the app can return the user to where they were), records the
 * chosen locale in `localStorage` under `'locale'`, and calls `window.location.replace()` with the
 * app-provided URL. Because it performs navigation, it is a standalone helper rather than part of a
 * controller (mirroring `kitPresentReloadAlert` / `kitPresentAuthFailedAlert`). Centralizing it means a
 * future improvement to the switch flow lands in every app at once.
 *
 * @param actionSheetCtrl - the Ionic `ActionSheetController`
 * @param options - labels, locale list, and redirect configuration; see {@link KitLanguageActionSheetOptions}
 * @returns a Promise that resolves once presented (and, on a new selection, after the reload is triggered)
 * @example
 * ```ts
 * await kitPresentLanguageActionSheet(inject(ActionSheetController), {
 *   header: $localize`言語設定`,
 *   locales: [{ text: 'English', data: 'en-US' }, { text: '日本語', data: 'ja' }],
 *   cancelText: $localize`キャンセル`,
 *   currentLocale: normalizedLocale,
 *   currentPath: this.#router.url,
 *   pathnameStorageKey: StorageKeyEnum.pathnameBeforeRedirect,
 *   buildRedirectUrl: (locale) => location.origin + (localePath[locale.toLowerCase()] ?? '/index.html'),
 *   enabled: environment.production,
 * });
 * ```
 */
export const kitPresentLanguageActionSheet = async (
  actionSheetCtrl: ActionSheetController,
  options: KitLanguageActionSheetOptions,
): Promise<void> => {
  const actionSheet = await actionSheetCtrl.create({
    header: options.header,
    buttons: [
      ...options.locales.map((locale) => ({ text: locale.text, data: locale.data })),
      { text: options.cancelText, role: 'cancel' },
    ],
  });
  await actionSheet.present();

  const { data } = await actionSheet.onDidDismiss();
  if (options.enabled && data && data !== options.currentLocale) {
    sessionStorage.setItem(options.pathnameStorageKey, options.currentPath);
    localStorage.setItem('locale', data);
    window.location.replace(options.buildRedirectUrl(data));
  }
};
