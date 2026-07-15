import { inject, Injectable } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';

/**
 * Content for {@link KitMaintenanceController.present}.
 */
export interface KitMaintenanceOptions {
  /** Alert header, e.g. "メンテナンス中です". */
  header: string;
  /** Alert body; keep short — the user cannot dismiss until maintenance ends. */
  message: string;
  /**
   * Absolute URL of the fleet maintenance wait SSE (`GET /public/maintenance/wait`).
   *
   * @remarks
   * Typically `environment.api + 'public/maintenance/wait'`. While the overlay is shown the
   * controller opens an {@link EventSource} on this URL and dismisses on `event: ended`.
   */
  waitUrl: string;
}

/**
 * Singleton "maintenance lock" overlay: backdrop-locked, no dismiss buttons, auto-clears via SSE.
 *
 * @remarks
 * Mirrors {@link KitReloadAlertController} as a de-duped stateful controller, but the user cannot
 * cancel or reload out of it — only the server `event: ended` on {@link KitMaintenanceOptions.waitUrl}
 * (or an explicit {@link dismiss}) clears it. Uses Ionic's `AlertController` (not a feature modal)
 * so the kit stays free of page components / i18n; all copy is supplied by the caller.
 *
 * Wire from {@link KitHttpConfig.onMaintenance} when the API returns `503` with
 * `error.error?.code === 'MAINTENANCE'`.
 *
 * @example
 * ```ts
 * provideKitHttp(() => {
 *   const maintenance = inject(KitMaintenanceController);
 *   return {
 *     getAuthHeaders: async () => ({}),
 *     onMaintenance: () =>
 *       void maintenance.present({
 *         header: 'メンテナンス中です',
 *         message: 'しばらくお待ちください。終了次第、自動で閉じます。',
 *         waitUrl: environment.api + 'public/maintenance/wait',
 *       }),
 *   };
 * });
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitMaintenanceController {
  readonly #alertCtrl = inject(AlertController);
  #alert: HTMLIonAlertElement | null = null;
  #source: EventSource | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #waitUrl: string | null = null;
  /** When true, EventSource errors must not schedule reconnect (ended / dismiss). */
  #closed = false;

  /**
   * Present the lock overlay and start waiting on the maintenance SSE, unless one is already showing.
   *
   * @param options - overlay copy plus the wait SSE URL
   */
  async present(options: KitMaintenanceOptions): Promise<void> {
    if (this.#alert || document.querySelector('ion-alert.kit-maintenance-alert')) {
      return;
    }
    this.#closed = false;
    this.#waitUrl = options.waitUrl;
    const alert = await this.#alertCtrl.create({
      header: options.header,
      message: options.message,
      backdropDismiss: false,
      // No buttons — dismissal is server-driven via SSE (or an explicit dismiss()).
      buttons: [],
      cssClass: 'kit-maintenance-alert',
    });
    this.#alert = alert;
    void alert.onDidDismiss().then(() => {
      if (this.#alert === alert) {
        this.#alert = null;
      }
      this.#stopWait();
    });
    await alert.present();
    this.#startWait(options.waitUrl);
  }

  /**
   * Dismiss the tracked overlay and tear down the wait SSE.
   *
   * @remarks
   * Normally called when the wait stream emits `ended`. A no-op when nothing is showing.
   */
  async dismiss(): Promise<void> {
    this.#stopWait();
    const alert = this.#alert;
    this.#alert = null;
    await alert?.dismiss();
  }

  #startWait(waitUrl: string): void {
    this.#stopSourceOnly();
    if (this.#closed) {
      return;
    }
    const source = new EventSource(waitUrl);
    this.#source = source;

    source.addEventListener('ended', () => {
      void this.dismiss();
    });

    source.addEventListener('ping', () => {
      // Keepalive — resets reconnect backoff so a lively stream does not treat the next pause as failure.
      this.#reconnectAttempt = 0;
    });

    source.onerror = () => {
      // EventSource auto-reconnects, but after a deploy the old isolate may hang; force a clean
      // reconnect with exponential backoff once the browser surfaces an error.
      if (this.#closed || this.#waitUrl !== waitUrl) {
        return;
      }
      this.#stopSourceOnly();
      this.#scheduleReconnect();
    };

    source.onopen = () => {
      this.#reconnectAttempt = 0;
    };
  }

  #scheduleReconnect(): void {
    if (this.#closed || !this.#waitUrl) {
      return;
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
    }
    const delay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    const waitUrl = this.#waitUrl;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#closed && this.#waitUrl === waitUrl) {
        this.#startWait(waitUrl);
      }
    }, delay);
  }

  #stopWait(): void {
    this.#closed = true;
    this.#waitUrl = null;
    this.#reconnectAttempt = 0;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#stopSourceOnly();
  }

  #stopSourceOnly(): void {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.onerror = null;
      source.onopen = null;
      source.close();
    }
  }
}
