import type { EnvironmentProviders } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';

/**
 * Theme configuration injected via `provideKitTheme()` and consumed by `KitThemeController`.
 *
 * @remarks
 * All fields are required; the consuming application supplies a complete configuration so every app
 * in the fleet has the same shape. The class lists absorb the per-app CSS drift: the kit toggles
 * `darkClasses` on when dark and `lightClasses` on when light, so an app that only uses Ionic's
 * palette passes `darkClasses: ['ion-palette-dark'], lightClasses: []`, while an app with an extra
 * design-system palette adds its own classes (e.g. `darkClasses: ['ion-palette-dark', 'a2ui-dark']`,
 * `lightClasses: ['a2ui-light']`).
 */
export interface KitThemeConfig {
  /** Key under which the chosen theme (`'light'` | `'dark'`) is persisted via `KitStorageService`. */
  readonly storageKey: string;
  /** Classes toggled **on** the document element when the dark theme is active. */
  readonly darkClasses: readonly string[];
  /** Classes toggled **on** the document element when the light theme is active. */
  readonly lightClasses: readonly string[];
}

/**
 * Injection token carrying the {@link KitThemeConfig} for `KitThemeController`.
 *
 * @remarks
 * Provide it through {@link provideKitTheme} rather than registering it directly.
 */
export const KIT_THEME_CONFIG = new InjectionToken<KitThemeConfig>('@rdlabo/ionic-angular-kit:theme');

/**
 * Wire `KitThemeController` into the application.
 *
 * @param config - theme configuration: the storage key and the light/dark class lists
 * @returns environment providers to add to the application's provider list
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideKitTheme({
 *       storageKey: StorageKeyEnum.theme,
 *       darkClasses: ['ion-palette-dark', 'a2ui-dark'],
 *       lightClasses: ['a2ui-light'],
 *     }),
 *   ],
 * });
 * ```
 */
export const provideKitTheme = (config: KitThemeConfig): EnvironmentProviders =>
  makeEnvironmentProviders([{ provide: KIT_THEME_CONFIG, useValue: config }]);
