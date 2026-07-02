import { inject, Injectable } from '@angular/core';
import type { InputSignalWithTransform } from '@angular/core';
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
 * Optional static metadata a modal component may declare to make {@link KitOverlayController.presentModal}
 * type-safe in its dismiss data: the value passed to `dismiss()` is inferred from `modalReturn`.
 *
 * @remarks
 * Props do *not* need to be declared here — {@link KitOverlayController.presentModal} infers them directly
 * from the component's `input()` fields (see {@link ModalPropsOf}), so `input()` stays the single source of
 * truth and can never drift from a hand-written declaration. Only the dismiss-data shape, which has no
 * counterpart on the component, is declared — as a `declare static modalReturn` phantom type with no runtime
 * value, so it adds nothing to the bundle.
 *
 * @example
 * ```ts
 * export class EditPage {
 *   declare static modalReturn: { saved: boolean };
 *   readonly id = input.required<number>();   // props are inferred from here
 *   readonly note = input<string>();          // default-less input() → optional prop
 * }
 *
 * // Caller — `id` is required (input.required), `note` optional; result is `{ saved: boolean } | undefined`:
 * const result = await overlay.presentModal(EditPage, { id: 1 });
 * ```
 */
export interface ModalMetadata<R = unknown> {
  /** Shape of the data the modal resolves with when dismissed. */
  modalReturn?: R;
}

/**
 * Write type of a signal `input()` field (unwraps `input.required`, `input()` and transform inputs).
 *
 * @remarks
 * Matched with `any` (not `unknown`): `InputSignalWithTransform`'s `TransformT` is contravariant, so
 * `InputSignal<number>` is not assignable to `InputSignalWithTransform<unknown, unknown>`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InputWriteType<F> = F extends InputSignalWithTransform<any, infer W> ? W : never;

/** Instance type of a component constructor; `never` for non-class components (string / HTMLElement refs). */
type InstanceOf<C> = C extends abstract new (...args: never[]) => infer I ? I : never;

/** Keys of the `input()` signal fields on a component instance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InputFieldKeys<I> = { [K in keyof I]-?: I[K] extends InputSignalWithTransform<any, any> ? K : never }[keyof I];

/**
 * Props object inferred from a component's `input()` fields. Required vs. optional is decided by the write
 * type: `input.required<T>()` / `input<T>(default)` yield `T` (no `undefined`) → required prop, while a
 * default-less `input<T>()` yields `T | undefined` → optional prop.
 *
 * @remarks
 * Angular's types cannot distinguish `input.required<T>()` from a defaulted `input<T>(default)` — both are
 * `InputSignal<T>` — so a defaulted input is (safely) treated as required. Declare inputs you want to omit at
 * the call site as default-less `input<T>()`.
 */
type ModalPropsOf<I> = { [K in InputFieldKeys<I> as undefined extends InputWriteType<I[K]> ? never : K]: InputWriteType<I[K]> } & {
  [K in InputFieldKeys<I> as undefined extends InputWriteType<I[K]> ? K : never]?: InputWriteType<I[K]>;
};

/** `input()` keys whose write type excludes `undefined` (required / defaulted inputs). Empty when none. */
type RequiredInputKeys<I> = { [K in InputFieldKeys<I>]: undefined extends InputWriteType<I[K]> ? never : K }[InputFieldKeys<I>];

/**
 * Dismiss-data type inferred from a component's static {@link ModalMetadata.modalReturn}. A component that
 * declares no `modalReturn` resolves to `void`: it is treated as returning no dismiss data, so the compiler
 * rejects any attempt to read the result. Declare `modalReturn` on modals that do resolve with data.
 */
type ModalReturnOf<C> = C extends { modalReturn: infer R } ? R : void;

/** Loose trailing args (optional, untyped props) — used when a component exposes no signal `input()` fields. */
type LooseModalPresentArgs = [componentProps?: ModalOptions['componentProps'], options?: KitModalPresentOptions];

/**
 * Trailing `presentModal` args derived from a component's `input()` fields: props are inferred and typed via
 * {@link ModalPropsOf}. When the component declares at least one required input the props argument is required;
 * when every input is optional the props argument itself is optional. Components with no signal inputs (plain
 * classes, `@Input()`-decorator components, or non-class refs) fall back to loose, untyped props.
 */
type ModalPresentArgs<C, I = InstanceOf<C>> = [I] extends [never]
  ? LooseModalPresentArgs
  : [InputFieldKeys<I>] extends [never]
    ? LooseModalPresentArgs
    : [RequiredInputKeys<I>] extends [never]
      ? [componentProps?: ModalPropsOf<I>, options?: KitModalPresentOptions]
      : [componentProps: ModalPropsOf<I>, options?: KitModalPresentOptions];

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
   * Guards against stacking alerts: while one {@link alertClose} / {@link alertConfirm} is on screen,
   * a concurrent call resolves immediately (close: no-op, confirm: `false`) instead of presenting a
   * second alert on top of the first. Shared across both methods so a confirm cannot stack over a close.
   */
  #alertPresenting = false;

  /**
   * Present a modal and resolve with the data passed to its dismissal.
   *
   * @typeParam O - type of the data returned when the modal is dismissed
   * @param component - the component to render inside the modal
   * @param componentProps - props to pass to the modal component
   * @param options - additional modal options, including {@link KitModalPresentOptions.watchKeyboard}
   * @returns the dismiss data, or `undefined` when the modal is dismissed without data
   * @remarks
   * Presenting a modal triggers light native haptic feedback as an intentional kit UX choice,
   * consistent with {@link presentPopover} and {@link presentToast}.
   *
   * Props are inferred from the component's `input()` fields (see {@link ModalPropsOf}): required inputs
   * become required props, so the compiler rejects a call that omits them. The return type is inferred from
   * a static `modalReturn` (see {@link ModalMetadata}); a component with no `modalReturn` resolves to `void`
   * — the modal is treated as returning no dismiss data.
   * @example
   * ```ts
   * // Inferred — `id` required (input.required), `note` optional; result is `{ saved: boolean } | undefined`:
   * const result = await overlay.presentModal(EditPage, { id: 1 });
   * ```
   */
  presentModal<C extends ModalOptions['component']>(component: C, ...args: ModalPresentArgs<C>): Promise<ModalReturnOf<C> | undefined>;
  async presentModal(
    component: ModalOptions['component'],
    componentProps?: ModalOptions['componentProps'],
    options: KitModalPresentOptions = {},
  ): Promise<unknown> {
    void kitImpact();
    const { watchKeyboard, ...modalOptions } = options;
    const modal = await this.#modalCtrl.create({ component, componentProps, ...modalOptions });
    await modal.present();
    const handle = watchKeyboard ? await watchModalKeyboard(modal) : null;
    const { data } = await modal.onDidDismiss<unknown>();
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
   * @remarks
   * Presenting a popover triggers light native haptic feedback as an intentional kit UX choice,
   * consistent with {@link presentModal} and {@link presentToast}.
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
    void kitImpact();
    const popover = await this.#popoverCtrl.create({ component, componentProps, ...options });
    await popover.present();
    const { data } = await popover.onDidDismiss<O>();
    return data;
  }

  /**
   * Present a toast using kit defaults that the caller may override.
   *
   * @remarks
   * Defaults to a bottom position, a 2000ms duration, a vertical swipe gesture, and a close button
   * from the configured labels; any of these can be overridden via `options`. Presenting a toast
   * also triggers light native haptic feedback as an intentional kit UX choice.
   *
   * Bottom is the fleet-wide default (top left the toast fighting the tab bar and the keyboard).
   * For a bottom toast with no explicit `positionAnchor`, if a visible `ion-tab-bar` is present the
   * toast is automatically anchored above it (Ionic places a bottom toast above its `positionAnchor`),
   * so the toast never sits behind the tabs. Avoiding the on-screen keyboard is handled by the native
   * keyboard resize — the anchored/bottom toast rides the shrinking viewport above the keyboard;
   * Ionic itself has no toast keyboard-avoidance option. An app can override either via `options`.
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
    const merged: ToastOptions = {
      position: 'bottom',
      duration: 2000,
      buttons: [this.#labels.close],
      swipeGesture: 'vertical',
      ...options,
    };
    // Anchor a bottom toast above the tab bar when one is visibly present and the caller did not
    // set an explicit anchor, so the toast clears the tabs (and rides the keyboard-resized viewport).
    if (merged.position === 'bottom' && merged.positionAnchor === undefined) {
      const tabBar = document.querySelector('ion-tab-bar');
      if (tabBar && tabBar.getBoundingClientRect().height > 0) {
        merged.positionAnchor = tabBar as HTMLElement;
      }
    }
    const toast = await this.#toastCtrl.create(merged);
    await toast.present();
    return toast;
  }

  /**
   * Present a notification alert with a single "close" button and wait for it to be dismissed.
   *
   * @param options - alert content (header, message, optional sub-header)
   * @returns a Promise that resolves once the alert has been dismissed
   * @remarks
   * No-ops when another alert is already presenting (see {@link alertClose} / {@link alertConfirm}
   * stacking guard).
   * @example
   * ```ts
   * await overlay.alertClose({ header: 'Done', message: 'Your changes were saved.' });
   * ```
   */
  async alertClose(options: KitAlertCloseOptions): Promise<void> {
    if (this.#alertPresenting) {
      return;
    }
    this.#alertPresenting = true;
    try {
      const alert = await this.#alertCtrl.create({
        header: options.header,
        subHeader: options.subHeader,
        message: options.message,
        buttons: [this.#labels.close],
      });
      await alert.present();
      await alert.onWillDismiss();
    } finally {
      this.#alertPresenting = false;
    }
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
   * @remarks
   * Returns `false` immediately when another alert is already presenting (see {@link alertClose} /
   * {@link alertConfirm} stacking guard).
   */
  async alertConfirm(options: KitAlertConfirmOptions): Promise<boolean> {
    if (this.#alertPresenting) {
      return false;
    }
    this.#alertPresenting = true;
    try {
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
    } finally {
      this.#alertPresenting = false;
    }
  }
}
