import type { EnvironmentProviders } from '@angular/core';
import { InjectionToken, makeEnvironmentProviders } from '@angular/core';

/**
 * User-visible button labels consumed by `KitOverlayController`.
 *
 * @remarks
 * The kit deliberately ships no i18n strings of its own and has no hard dependency on
 * `@angular/localize`. The consuming application always provides these labels: multilingual apps
 * pass `$localize`-resolved strings, single-language apps pass plain literals.
 */
export interface KitLabels {
  /** Text for the "close" button used by alerts and toasts. */
  readonly close: string;
  /** Text for the "cancel" button used by confirmation alerts. */
  readonly cancel: string;
}

/**
 * Overlay configuration injected via `provideKitOverlay()`.
 *
 * @remarks
 * All fields are required; the consuming application must supply a complete configuration.
 */
export interface KitOverlayConfig {
  /** Button labels used across the overlays presented by `KitOverlayController`. */
  readonly labels: KitLabels;
}

/**
 * Injection token carrying the {@link KitOverlayConfig} for `KitOverlayController`.
 *
 * @remarks
 * Provide it through {@link provideKitOverlay} rather than registering it directly.
 */
export const KIT_OVERLAY_CONFIG = new InjectionToken<KitOverlayConfig>('@rdlabo/ionic-angular-kit:overlay');

/**
 * Wire `KitOverlayController` into the application by providing its button labels.
 *
 * @param config - overlay configuration, including the button labels to inject
 * @returns environment providers to add to the application's provider list
 * @example
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideKitOverlay({ labels: { close: $localize`Close`, cancel: $localize`Cancel` } }),
 *   ],
 * });
 * ```
 */
export const provideKitOverlay = (config: KitOverlayConfig): EnvironmentProviders =>
  makeEnvironmentProviders([{ provide: KIT_OVERLAY_CONFIG, useValue: config }]);
