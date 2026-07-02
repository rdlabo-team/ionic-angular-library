import { DOCUMENT, inject, Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { BehaviorSubject } from 'rxjs';

import { KitStorageService } from '@rdlabo/ionic-angular-kit';

import { KIT_THEME_CONFIG } from './theme-config';

/** The active theme mode. */
export type KitThemeMode = 'light' | 'dark';

/**
 * Light/dark theme controller: persists the user's choice, follows the OS setting until the user
 * overrides it, toggles the configured palette classes, and syncs the native Android status bar.
 *
 * @remarks
 * Consolidates the theme logic that had drifted across the fleet into one behavior. Notably it fixes
 * a latent leak in one variant where the system-theme listener stayed registered after a manual
 * toggle: {@link changeTheme} always detaches the listener via {@link removeEventListener} before
 * applying the forced theme, so a later OS change can no longer silently flip an app the user pinned.
 *
 * - **Persistence** — the chosen mode is stored via {@link KitStorageService} under the configured key.
 * - **Follow OS until overridden** — on boot with nothing stored, it tracks
 *   `prefers-color-scheme` (idempotent registration); once the user calls {@link changeTheme} it stops
 *   following and honors the explicit choice.
 * - **Class toggling** — toggles {@link KitThemeConfig.darkClasses} on when dark and
 *   {@link KitThemeConfig.lightClasses} on when light, absorbing per-app CSS differences via config.
 * - **Native status bar** — on Android native only, mirrors the Ionic behavior of setting the status
 *   bar style to match (iOS derives it from the web content, so it is intentionally left untouched).
 *
 * Subscribe to {@link themeSubject} to reflect the current mode in the UI (e.g. a settings toggle).
 *
 * @example
 * ```ts
 * // On boot (app.component):
 * inject(KitThemeController).setDefaultThemeMode();
 *
 * // From a settings toggle:
 * const theme = inject(KitThemeController);
 * theme.themeSubject.subscribe((mode) => this.isDark.set(mode === 'dark'));
 * theme.changeTheme(true);
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitThemeController {
  readonly #storage = inject(KitStorageService);
  readonly #document = inject(DOCUMENT);
  readonly #config = inject(KIT_THEME_CONFIG);

  /**
   * Emits the active theme, seeded with `'light'`.
   *
   * @remarks
   * A `BehaviorSubject`, so a late subscriber immediately receives the current mode; it emits again
   * on every {@link setDefaultThemeMode} / {@link changeTheme} and on OS theme changes while following.
   */
  readonly themeSubject = new BehaviorSubject<KitThemeMode>('light');

  #prefersDark?: MediaQueryList;
  #onSystemThemeChange?: (e: MediaQueryListEvent) => void;

  /**
   * Apply the persisted theme, or start following the OS setting when nothing is stored yet.
   *
   * @remarks
   * Call once on boot (e.g. from `app.component`).
   *
   * @returns a Promise that resolves once the initial theme has been applied
   */
  async setDefaultThemeMode(): Promise<void> {
    const stored = await this.#storage.get<KitThemeMode>(this.#config.storageKey);
    if (stored) {
      // 保存済みの選択を強制し、OS 追従は解除する。
      this.#unwatchSystemTheme();
      return this.#applyTheme(stored === 'dark');
    }

    // 未保存 → OS の設定に追従する。
    this.#watchSystemTheme();
  }

  /**
   * Force a theme, persist it, and stop following the OS setting.
   *
   * @param isDark - `true` for the dark theme, `false` for light
   * @returns a Promise that resolves once the theme has been persisted and applied
   */
  async changeTheme(isDark: boolean): Promise<void> {
    this.#unwatchSystemTheme();
    await this.#storage.set(this.#config.storageKey, isDark ? 'dark' : 'light');
    await this.#applyTheme(isDark);
  }

  #watchSystemTheme(): void {
    if (this.#prefersDark) {
      // 既に監視中なら二重登録しない（冪等）。
      return;
    }
    this.#prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    this.#onSystemThemeChange = (e) => void this.#applyTheme(e.matches);
    this.#prefersDark.addEventListener('change', this.#onSystemThemeChange, { passive: true });
    void this.#applyTheme(this.#prefersDark.matches);
  }

  #unwatchSystemTheme(): void {
    if (this.#prefersDark && this.#onSystemThemeChange) {
      this.#prefersDark.removeEventListener('change', this.#onSystemThemeChange);
    }
    this.#prefersDark = undefined;
    this.#onSystemThemeChange = undefined;
  }

  async #applyTheme(isDark: boolean): Promise<void> {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
    }
    const root = this.#document.documentElement;
    for (const cls of this.#config.darkClasses) {
      root.classList.toggle(cls, isDark);
    }
    for (const cls of this.#config.lightClasses) {
      root.classList.toggle(cls, !isDark);
    }
    this.themeSubject.next(isDark ? 'dark' : 'light');
  }
}
