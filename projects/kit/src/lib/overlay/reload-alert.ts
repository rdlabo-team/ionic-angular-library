import type { KitAlertConfirmOptions } from './kit-overlay.controller';
import { KitOverlayController } from './kit-overlay.controller';

/**
 * Present the fleet's canonical "network error → offer to reload" confirmation.
 *
 * @remarks
 * Folds together the three copy-pasted concerns that every app duplicated around a network failure:
 *
 * 1. Suppress stacking — if an `ion-alert` is already on screen, do nothing.
 * 2. Ask the user to confirm via {@link KitOverlayController.alertConfirm}.
 * 3. Call `location.reload()` when the user confirms.
 *
 * All user-facing text (`header`, `message`, `okText`) is supplied by the caller so the kit stays
 * free of any hardcoded i18n. Typically wired from {@link KitHttpConfig.onNetworkError}, but it can
 * be called from anywhere an app wants the same behavior (e.g. an offline fallback).
 *
 * @param overlay - the kit overlay controller used to present the confirmation
 * @param options - alert content plus the confirm-button text (usually "Refresh")
 * @returns a Promise that resolves once the alert is dismissed (the page reloads on confirm)
 * @example
 * ```ts
 * provideKitHttp(() => {
 *   const overlay = inject(KitOverlayController);
 *   return {
 *     getAuthHeaders: async () => ({ ... }),
 *     onNetworkError: (status) =>
 *       kitPresentReloadAlert(overlay, {
 *         header: 'ネットワークエラー',
 *         message: `通信できませんでした。リフレッシュしますか？（${status}）`,
 *         okText: 'リフレッシュ',
 *       }),
 *   };
 * });
 * ```
 */
export const kitPresentReloadAlert = async (
  overlay: KitOverlayController,
  options: KitAlertConfirmOptions,
): Promise<void> => {
  // 既にアラート表示中なら多重表示しない。
  if (document.querySelector('ion-alert')) {
    return;
  }
  const reload = await overlay.alertConfirm(options);
  if (reload) {
    location.reload();
  }
};
