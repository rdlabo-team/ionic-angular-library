import { inject, Injectable } from '@angular/core';
import type { ModalOptions, PopoverOptions, ToastOptions } from '@ionic/angular/standalone';
import { AlertController, ModalController, PopoverController, ToastController } from '@ionic/angular/standalone';
import type { PluginListenerHandle } from '@capacitor/core';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { KIT_OVERLAY_CONFIG } from './overlay-config';
import { kitImpact } from '../utils/haptics';

/**
 * Options for {@link KitOverlayController.presentModal}.
 *
 * @remarks
 * Extends Ionic's `ModalOptions` but omits `component` and `componentProps`, which are passed as
 * dedicated arguments instead.
 */
export interface KitModalPresentOptions extends Omit<ModalOptions, 'component' | 'componentProps'> {
  /**
   * When `true`, expand the sheet to its maximum breakpoint while the native keyboard is shown.
   *
   * @remarks
   * Only has an effect on native platforms; ignored on the web.
   */
  watchKeyboard?: boolean;
}

/**
 * Options for {@link KitOverlayController.alertClose}.
 */
export interface KitAlertCloseOptions {
  /** Alert header text. */
  header: string;
  /** Alert body message. */
  message: string;
  /** Optional alert sub-header text shown beneath the header. */
  subHeader?: string;
}

/**
 * Options for {@link KitOverlayController.alertConfirm}.
 *
 * @remarks
 * Extends {@link KitAlertCloseOptions} with the confirm-button text.
 */
export interface KitAlertConfirmOptions extends KitAlertCloseOptions {
  /**
   * Text for the OK (confirm) button.
   *
   * @remarks
   * Action-specific, so it is supplied by the caller rather than taken from the shared labels.
   */
  okText: string;
}

/**
 * Attach a native keyboard listener that grows the modal to its maximum breakpoint when the
 * keyboard appears.
 *
 * @param modal - the presented modal element to resize
 * @returns a listener handle; on non-native platforms a no-op handle whose `remove()` does nothing
 * @internal
 */
const watchModalKeyboard = async (modal: HTMLIonModalElement): Promise<PluginListenerHandle> => {
  if (!Capacitor.isNativePlatform()) {
    return { remove: async () => undefined };
  }
  return Keyboard.addListener('keyboardDidShow', () => modal.setCurrentBreakpoint(1));
};

/**
 * Ergonomic wrapper that consolidates Ionic's overlay controllers (Modal / Toast / Alert).
 *
 * @remarks
 * Folds the repetitive create → present → onDidDismiss sequence into single calls and returns the
 * relevant result directly. It holds no application-specific policy such as navigation; compose
 * those concerns on the consuming side.
 *
 * @example
 * ```ts
 * constructor(private readonly overlay: KitOverlayController) {}
 *
 * async edit(): Promise<void> {
 *   const result = await this.overlay.presentModal<EditResult>(EditPage, { id: 1 });
 *   if (result) {
 *     await this.overlay.presentToast({ message: 'Saved' });
 *   }
 * }
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitOverlayController {
  readonly #modalCtrl = inject(ModalController);
  readonly #popoverCtrl = inject(PopoverController);
  readonly #toastCtrl = inject(ToastController);
  readonly #alertCtrl = inject(AlertController);
  readonly #labels = inject(KIT_OVERLAY_CONFIG).labels;

  /**
   * Present a modal and resolve with the data passed to its dismissal.
   *
   * @typeParam O - type of the data returned when the modal is dismissed
   * @param component - the component to render inside the modal
   * @param componentProps - props to pass to the modal component
   * @param options - additional modal options, including {@link KitModalPresentOptions.watchKeyboard}
   * @returns the dismiss data, or `undefined` when the modal is dismissed without data
   * @example
   * ```ts
   * const data = await overlay.presentModal<{ saved: boolean }>(EditPage, { id: 1 }, { watchKeyboard: true });
   * ```
   */
  async presentModal<O = unknown>(
    component: ModalOptions['component'],
    componentProps?: ModalOptions['componentProps'],
    options: KitModalPresentOptions = {},
  ): Promise<O | undefined> {
    const { watchKeyboard, ...modalOptions } = options;
    const modal = await this.#modalCtrl.create({ component, componentProps, ...modalOptions });
    await modal.present();
    const handle = watchKeyboard ? await watchModalKeyboard(modal) : null;
    const { data } = await modal.onDidDismiss<O>();
    await handle?.remove();
    return data;
  }

  /**
   * Present a popover and resolve with the data passed to its dismissal.
   *
   * @typeParam O - type of the data returned when the popover is dismissed
   * @param component - the component to render inside the popover
   * @param componentProps - props to pass to the popover component
   * @param options - additional popover options (for example `event` to anchor it, or `cssClass`)
   * @returns the dismiss data, or `undefined` when the popover is dismissed without data
   * @example
   * ```ts
   * const choice = await overlay.presentPopover<MenuChoice>(MenuPopover, { items }, { event });
   * ```
   */
  async presentPopover<O = unknown>(
    component: PopoverOptions['component'],
    componentProps?: PopoverOptions['componentProps'],
    options: Omit<PopoverOptions, 'component' | 'componentProps'> = {},
  ): Promise<O | undefined> {
    const popover = await this.#popoverCtrl.create({ component, componentProps, ...options });
    await popover.present();
    const { data } = await popover.onDidDismiss<O>();
    return data;
  }

  /**
   * Present a toast using kit defaults that the caller may override.
   *
   * @remarks
   * Defaults to a top position, a 2000ms duration, a vertical swipe gesture, and a close button
   * from the configured labels; any of these can be overridden via `options`. Presenting a toast
   * also triggers light native haptic feedback as an intentional kit UX choice.
   *
   * @param options - Ionic toast options that override the kit defaults
   * @returns the presented toast element
   * @example
   * ```ts
   * await overlay.presentToast({ message: 'Copied to clipboard' });
   * ```
   */
  async presentToast(options: ToastOptions): Promise<HTMLIonToastElement> {
    void kitImpact();
    const toast = await this.#toastCtrl.create({
      position: 'top',
      duration: 2000,
      buttons: [this.#labels.close],
      swipeGesture: 'vertical',
      ...options,
    });
    await toast.present();
    return toast;
  }

  /**
   * Present a notification alert with a single "close" button and wait for it to be dismissed.
   *
   * @param options - alert content (header, message, optional sub-header)
   * @returns a Promise that resolves once the alert has been dismissed
   * @example
   * ```ts
   * await overlay.alertClose({ header: 'Done', message: 'Your changes were saved.' });
   * ```
   */
  async alertClose(options: KitAlertCloseOptions): Promise<void> {
    const alert = await this.#alertCtrl.create({
      header: options.header,
      subHeader: options.subHeader,
      message: options.message,
      buttons: [this.#labels.close],
    });
    await alert.present();
    await alert.onWillDismiss();
  }

  /**
   * Present a confirmation alert with cancel and OK buttons.
   *
   * @param options - alert content plus the OK button text via {@link KitAlertConfirmOptions.okText}
   * @returns `true` when the user presses OK, `false` otherwise (cancel or backdrop dismissal)
   * @example
   * ```ts
   * const ok = await overlay.alertConfirm({
   *   header: 'Delete item?',
   *   message: 'This cannot be undone.',
   *   okText: 'Delete',
   * });
   * if (ok) {
   *   await remove();
   * }
   * ```
   */
  async alertConfirm(options: KitAlertConfirmOptions): Promise<boolean> {
    const alert = await this.#alertCtrl.create({
      header: options.header,
      subHeader: options.subHeader,
      message: options.message,
      buttons: [
        { text: this.#labels.cancel, role: 'cancel' },
        { text: options.okText, role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onWillDismiss();
    return role === 'confirm';
  }
}
