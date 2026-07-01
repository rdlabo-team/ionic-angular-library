import { inject, Injectable } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import { KIT_OVERLAY_CONFIG } from './overlay-config';

/**
 * Content for {@link KitReloadAlertController.present}.
 */
export interface KitReloadAlertOptions {
  /** Alert header text. */
  header: string;
  /** Alert body message. */
  message: string;
  /**
   * Text for the reload (confirm) button, e.g. "リフレッシュ".
   *
   * @remarks
   * Action-specific, so it is supplied by the caller rather than taken from the shared labels.
   * The cancel button uses the configured {@link KitLabels.cancel}.
   */
  okText: string;
}

/**
 * The fleet's canonical "network error → offer to reload" alert, as a stateful controller.
 *
 * @remarks
 * Consolidates the good-UX variant that had drifted across the fleet into one behavior:
 *
 * - **De-dup** — never stacks; a second {@link present} while an alert is already shown is a no-op.
 * - **Backdrop lock** — `backdropDismiss: false`, so a critical network error can't be dismissed by
 *   an accidental backdrop tap; the user consciously chooses cancel or reload.
 * - **Auto-dismiss on reconnect** — the presented alert is tracked, so {@link dismiss} (called from a
 *   later successful response) clears a now-stale error alert instead of leaving it on screen.
 * - **Reload on confirm** — the confirm button calls `location.reload()`.
 *
 * All user-facing text is supplied by the caller so the kit stays free of any hardcoded i18n; the
 * cancel button reuses {@link KitOverlayConfig.labels}. Because it performs navigation
 * (`location.reload()`) and holds state, it is a dedicated controller rather than part of
 * {@link KitOverlayController}, which stays free of navigation policy.
 *
 * @example
 * ```ts
 * // In an HTTP interceptor:
 * const reload = inject(KitReloadAlertController);
 * // ...on a network-class error while connected:
 * await reload.present({ header: 'ネットワークエラー', message: `…（${status}）`, okText: 'リフレッシュ' });
 * // ...on any later successful response:
 * await reload.dismiss();
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitReloadAlertController {
  readonly #alertCtrl = inject(AlertController);
  readonly #labels = inject(KIT_OVERLAY_CONFIG).labels;
  #alert: HTMLIonAlertElement | null = null;

  /**
   * Present the reload alert, unless one is already on screen.
   *
   * @param options - alert content plus the reload-button text
   * @returns a Promise that resolves once the alert has been presented (or immediately if suppressed)
   */
  async present(options: KitReloadAlertOptions): Promise<void> {
    // この controller 経由でも直書き ion-alert でも、多重表示しない。
    if (this.#alert || document.querySelector('ion-alert')) {
      return;
    }
    const alert = await this.#alertCtrl.create({
      header: options.header,
      message: options.message,
      backdropDismiss: false,
      buttons: [
        { text: this.#labels.cancel, role: 'cancel' },
        {
          text: options.okText,
          handler: () => {
            location.reload();
          },
        },
      ],
    });
    this.#alert = alert;
    void alert.onDidDismiss().then(() => {
      // 別の present で置き換わっていない限り、追跡を解除する。
      if (this.#alert === alert) {
        this.#alert = null;
      }
    });
    await alert.present();
  }

  /**
   * Dismiss the tracked reload alert if one is showing.
   *
   * @remarks
   * Typically called from a later successful response so a stale "network error" alert clears once
   * connectivity is restored. A no-op when nothing is showing.
   *
   * @returns a Promise that resolves once the alert has been dismissed (or immediately if none)
   */
  async dismiss(): Promise<void> {
    const alert = this.#alert;
    this.#alert = null;
    await alert?.dismiss();
  }
}
