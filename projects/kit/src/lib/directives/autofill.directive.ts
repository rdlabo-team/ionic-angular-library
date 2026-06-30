import type { OnInit } from '@angular/core';
import { Directive, ElementRef, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';

/**
 * Work around iOS `ion-input` autofill values not propagating to the Angular form model.
 *
 * On iOS, when the browser autofills an `ion-input` (for example a saved password), the value
 * is written to the underlying native `<input>` element but the corresponding `change` event is
 * not forwarded to the host `ion-input`, so the Angular form control (and `ngModel`) never sees
 * the autofilled value. This directive listens for the first `change` event on the inner input
 * element and mirrors its value back onto the host element, restoring two-way binding.
 *
 * Apply it to any `ion-input` that participates in a form and may be autofilled by attaching the
 * `rdlaboAutofill` attribute.
 *
 * @remarks
 * The directive is a no-op on every platform other than iOS, where the value already propagates
 * correctly. A short timeout is used because `ion-input` creates its inner `<input>` element
 * asynchronously after the host element is initialized.
 *
 * @example
 * ```html
 * <ion-input rdlaboAutofill type="password" [(ngModel)]="password"></ion-input>
 * ```
 */
@Directive({
  selector: '[rdlaboAutofill]',
  standalone: true,
})
export class KitAutofillDirective implements OnInit {
  readonly #el = inject(ElementRef);

  constructor() {}

  /**
   * Register the iOS autofill workaround once the directive is initialized.
   *
   * Returns immediately on non-iOS platforms. On iOS, after a short delay it attaches a one-shot,
   * passive `change` listener to the inner `<input>` element that `ion-input` renders, copying the
   * autofilled value back onto the host element so the Angular form model stays in sync. Any error
   * while locating the inner input (for example if the element is not yet present) is swallowed.
   *
   * @returns Nothing.
   */
  ngOnInit(): void {
    if (Capacitor.getPlatform() !== 'ios') {
      return;
    }
    setTimeout(() => {
      try {
        this.#el.nativeElement.children[0].addEventListener(
          'change',
          (e: Event) => {
            this.#el.nativeElement.value = (e.target as HTMLInputElement).value;
          },
          {
            capture: false,
            once: true,
            passive: true,
          },
        );
      } catch {
        /* empty */
      }
    }, 100); // Need some time for the ion-input to create the input element
  }
}
