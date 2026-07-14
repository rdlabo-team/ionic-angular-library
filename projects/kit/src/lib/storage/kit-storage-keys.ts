/**
 * Canonical storage keys persisted via {@link KitStorageService} that fleet apps often need to
 * keep across a sign-out `clear()`.
 *
 * @remarks
 * `KIT_LAST_AUTH_EMAIL_KEY` lives in `kit-auth-email-store` and is exported from the package root.
 * Import both keys from `@rdlabo/ionic-angular-kit` alongside {@link kitClearStoragePreservingKeys}.
 */

/**
 * Light/dark preference for `provideKitTheme` / `KitThemeController`.
 *
 * @remarks
 * Pass this as `provideKitTheme({ storageKey: KIT_THEME_STORAGE_KEY, … })` and include it in
 * {@link kitClearStoragePreservingKeys} so logout does not reset the user's theme.
 */
export const KIT_THEME_STORAGE_KEY = 'theme';
