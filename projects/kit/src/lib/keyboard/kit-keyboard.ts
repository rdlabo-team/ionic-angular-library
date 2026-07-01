import type { ElementRef } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

/**
 * How {@link kitKeyboardInit} adjusts the target element when the native keyboard appears.
 *
 * - `transform` — CSS `translateY(-keyboardHeight + safeAreaBottom)` for a smooth iOS animation
 *   (typical for an `ion-footer`).
 * - `offset` — set the `--offset-bottom` custom property to the negative keyboard height.
 * - `keyboard-offset` — set the `--padding-bottom` custom property to the keyboard height.
 */
export type KitKeyboardAdjust = 'transform' | 'offset' | 'keyboard-offset';

const keyboardWillShow = (elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle> =>
  Keyboard.addListener('keyboardWillShow', (info) => {
    if (Capacitor.getPlatform() === 'android') {
      if (elementRef.nativeElement.tagName === 'ION-FOOTER' && type === 'transform') {
        // https://github.com/ionic-team/ionic-framework/blob/main/core/src/components/footer/footer.tsx
        elementRef.nativeElement.classList.remove('footer-toolbar-padding');
      }
      return;
    }

    elementRef.nativeElement.classList.add('show-keyboard');
    // SSR-safe: this callback only runs on a native keyboard event, so the global `document` /
    // `window` are never touched on the server (kitKeyboardInit returns early when not native).
    const bodyStyleDeclaration = window.getComputedStyle(document.querySelector('body') as Element);
    const safeArea = parseInt(bodyStyleDeclaration.getPropertyValue('--ion-safe-area-bottom'), 10);

    if (type === 'transform') {
      elementRef.nativeElement.style.transition = 'transform 420ms';
      elementRef.nativeElement.style.willChange = 'transform';
      requestAnimationFrame(
        () => (elementRef.nativeElement.style.transform = `translateY(${info.keyboardHeight * -1 + safeArea}px)`),
      );
    } else if (type === 'offset') {
      requestAnimationFrame(() => {
        const keyboardOffset = elementRef.nativeElement.style.getPropertyValue('--keyboard-offset');
        if (!keyboardOffset || parseInt(keyboardOffset, 10) === 0) {
          elementRef.nativeElement.style.setProperty('--offset-bottom', `${info.keyboardHeight * -1}px`);
        }
      });
    } else {
      requestAnimationFrame(() => {
        const keyboardOffset = elementRef.nativeElement.style.getPropertyValue('--keyboard-offset');
        if (!keyboardOffset || parseInt(keyboardOffset, 10) === 0) {
          elementRef.nativeElement.style.setProperty('--padding-bottom', `${info.keyboardHeight}px`);
        }
      });
    }
  });

const keyboardWillHide = (elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle> =>
  Keyboard.addListener('keyboardWillHide', () => {
    if (Capacitor.getPlatform() === 'android') {
      if (elementRef.nativeElement.tagName === 'ION-FOOTER' && type === 'transform') {
        elementRef.nativeElement.classList.add('footer-toolbar-padding');
      }
      return;
    }

    elementRef.nativeElement.classList.remove('show-keyboard');

    if (type === 'transform') {
      elementRef.nativeElement.style.transition = 'transform 0ms';
      elementRef.nativeElement.style.transform = `translateY(0px)`;
      elementRef.nativeElement.style.willChange = 'transform';
    } else if (type === 'offset') {
      elementRef.nativeElement.style.setProperty('--offset-bottom', '0px');
    } else {
      elementRef.nativeElement.style.setProperty('--padding-bottom', '0px');
    }
  });

const keyboardDidShow = (elementRef: ElementRef): Promise<PluginListenerHandle> =>
  Keyboard.addListener('keyboardDidShow', () => {
    elementRef.nativeElement.style.willChange = 'auto';
  });

const keyboardDidHide = (elementRef: ElementRef): Promise<PluginListenerHandle> =>
  Keyboard.addListener('keyboardDidHide', () => {
    elementRef.nativeElement.style.willChange = 'auto';
  });

/**
 * Register native keyboard listeners that reposition an element when the keyboard shows/hides.
 *
 * @remarks
 * A plain function — no DI needed (it reads the platform from `Capacitor` and uses the global
 * `document`), so a component calls it directly instead of injecting a controller. SSR-safe: the
 * global `document` / `window` are only read inside native keyboard-event callbacks, which never
 * fire on the server — the `Capacitor.isNativePlatform()` guard returns `[]` first, and nothing is
 * touched at module load. A no-op on non-native platforms (returns `[]`). On native it handles the
 * iOS/Android differences (Android
 * only toggles the `footer-toolbar-padding` class on an `ion-footer` for the `transform` mode,
 * working around an Ionic footer bug). The caller owns the returned handles and must `remove()`
 * them when the view is destroyed.
 *
 * @param elementRef - The element to reposition (e.g. an `ion-footer`).
 * @param type - The adjustment strategy; see {@link KitKeyboardAdjust}.
 * @returns The registered listener handles (empty on non-native platforms).
 * @example
 * ```ts
 * export class ComposePage {
 *   readonly #footer = viewChild.required<ElementRef>('footer');
 *   #handles: PluginListenerHandle[] = [];
 *
 *   async ngAfterViewInit() {
 *     this.#handles = await kitKeyboardInit(this.#footer(), 'transform');
 *   }
 *   ngOnDestroy() {
 *     this.#handles.forEach((h) => h.remove());
 *   }
 * }
 * ```
 */
export const kitKeyboardInit = async (elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle[]> => {
  if (!Capacitor.isNativePlatform()) {
    return [];
  }
  return [
    await keyboardWillShow(elementRef, type),
    await keyboardWillHide(elementRef, type),
    await keyboardDidShow(elementRef),
    await keyboardDidHide(elementRef),
  ];
};
