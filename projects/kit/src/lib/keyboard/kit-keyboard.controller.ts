import type { ElementRef } from '@angular/core';
import { DOCUMENT, inject, Injectable } from '@angular/core';
import { Platform } from '@ionic/angular/standalone';
import type { PluginListenerHandle } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

/**
 * How {@link KitKeyboardController.init} adjusts the target element when the native keyboard appears.
 *
 * - `transform` — CSS `translateY(-keyboardHeight + safeAreaBottom)` for a smooth iOS animation
 *   (typical for an `ion-footer`).
 * - `offset` — set the `--offset-bottom` custom property to the negative keyboard height.
 * - `keyboard-offset` — set the `--padding-bottom` custom property to the keyboard height.
 */
export type KitKeyboardAdjust = 'transform' | 'offset' | 'keyboard-offset';

/**
 * Registers native keyboard listeners that reposition an element when the keyboard shows/hides.
 *
 * @remarks
 * A no-op on non-hybrid (web) platforms — `init` returns an empty handle list. On native it handles
 * iOS and Android differences (Android only toggles the `footer-toolbar-padding` class on an
 * `ion-footer` for the `transform` mode, working around an Ionic footer bug). The caller owns the
 * returned handles and must `remove()` them when the view is destroyed.
 *
 * @example
 * ```ts
 * export class ComposePage {
 *   readonly #keyboard = inject(KitKeyboardController);
 *   readonly #footer = viewChild.required<ElementRef>('footer');
 *   #handles: PluginListenerHandle[] = [];
 *
 *   async ngAfterViewInit() {
 *     this.#handles = await this.#keyboard.init(this.#footer(), 'transform');
 *   }
 *   ngOnDestroy() {
 *     this.#handles.forEach((h) => h.remove());
 *   }
 * }
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitKeyboardController {
  readonly #platform = inject(Platform);
  readonly #document = inject(DOCUMENT);

  /**
   * Attach keyboard show/hide listeners that adjust `elementRef` per `type`.
   *
   * @param elementRef - The element to reposition (e.g. an `ion-footer`).
   * @param type - The adjustment strategy; see {@link KitKeyboardAdjust}.
   * @returns The registered listener handles (empty on non-native platforms).
   */
  async init(elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle[]> {
    if (!this.#platform.is('hybrid')) {
      return [];
    }
    return [
      await this.#keyboardWillShow(elementRef, type),
      await this.#keyboardWillHide(elementRef, type),
      await this.#keyboardDidShow(elementRef),
      await this.#keyboardDidHide(elementRef),
    ];
  }

  #keyboardWillShow(elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle> {
    return Keyboard.addListener('keyboardWillShow', (info) => {
      if (this.#platform.is('android')) {
        if (elementRef.nativeElement.tagName === 'ION-FOOTER' && type === 'transform') {
          // https://github.com/ionic-team/ionic-framework/blob/main/core/src/components/footer/footer.tsx
          elementRef.nativeElement.classList.remove('footer-toolbar-padding');
        }
        return;
      }

      elementRef.nativeElement.classList.add('show-keyboard');
      const bodyStyleDeclaration = window.getComputedStyle(this.#document.querySelector('body') as Element);
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
  }

  #keyboardWillHide(elementRef: ElementRef, type: KitKeyboardAdjust): Promise<PluginListenerHandle> {
    return Keyboard.addListener('keyboardWillHide', () => {
      if (this.#platform.is('android')) {
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
  }

  #keyboardDidShow(elementRef: ElementRef): Promise<PluginListenerHandle> {
    return Keyboard.addListener('keyboardDidShow', () => {
      elementRef.nativeElement.style.willChange = 'auto';
    });
  }

  #keyboardDidHide(elementRef: ElementRef): Promise<PluginListenerHandle> {
    return Keyboard.addListener('keyboardDidHide', () => {
      elementRef.nativeElement.style.willChange = 'auto';
    });
  }
}
