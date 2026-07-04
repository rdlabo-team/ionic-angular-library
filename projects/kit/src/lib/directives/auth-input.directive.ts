import type { OnInit } from '@angular/core';
import { computed, Directive, ElementRef, HostListener, inject, Injector, input } from '@angular/core';
import { FORM_FIELD } from '@angular/forms/signals';
import { Capacitor } from '@capacitor/core';
import { KitStorageService } from '../storage/kit-storage.service';
import { kitForgetEmail, kitIsValidEmail, kitRecallEmail, kitRememberEmail } from '../storage/kit-auth-email-store';

/**
 * The mode of {@link KitAuthInputDirective}.
 *
 * - `'autofill'` — iOS autofill propagation only (use on the password input).
 * - `'email'` — sign-in email: prefill from storage + remember on change + forget when cleared.
 * - `'email-remember'` — sign-up email: remember on change only (no prefill, no forget).
 */
export type KitAuthInputMode = 'autofill' | 'email' | 'email-remember';

/**
 * Input conveniences for an `ion-input` in a sign-in / sign-up form, applied via the `kitAuthInput`
 * attribute. The mode is a typed union so a typo is a compile-time error.
 *
 * 1. **iOS autofill propagation (always on, every mode).** On iOS, when the browser autofills an
 *    `ion-input` (e.g. a saved password) the value is written to the underlying native `<input>`
 *    but the `change` event is not forwarded to the host `ion-input`, so the Angular form model
 *    never sees it. This directive mirrors the first inner-input `change` back onto the host,
 *    restoring two-way binding. It is a no-op on every other platform.
 *
 * 2. **Remember / prefill the email (`'email'` and `'email-remember'`).**
 *    - `'email'` (sign-in) — on init recalls the last entered email and, *only while the field is
 *      still empty*, seeds it via the bound Signal Forms field, so a browser/OS autofill the user
 *      actually picks always wins over the prefill. On every committed change (`ionChange`) it
 *      remembers a well-formed address, or **forgets** the stored one when the field is cleared
 *      (empty after trim) or holds an invalid address — the user intentionally removing the prefill.
 *    - `'email-remember'` (sign-up) — remembers a well-formed address on change, but never prefills
 *      and never forgets. So the first-sign-up address is captured without pre-populating a
 *      stranger's email into a new-account form, and clearing the field does not wipe an email
 *      remembered elsewhere.
 *
 *    A well-formed email is persisted even if it later fails to sign in — by design; the user simply
 *    re-enters it. A malformed/partial entry is never stored (see {@link kitRememberEmail}).
 *
 * @example
 * ```html
 * <!-- sign-in email: iOS autofill + prefill + remember/forget -->
 * <ion-input type="email" autocomplete="email" kitAuthInput="email" [formField]="form.email" />
 * <!-- sign-up email: remember only -->
 * <ion-input type="email" autocomplete="email" kitAuthInput="email-remember" [formField]="form.email" />
 * <!-- password: iOS autofill propagation only -->
 * <ion-input type="password" autocomplete="current-password" kitAuthInput="autofill" [formField]="form.password" />
 * ```
 *
 * @remarks
 * Prefill writes through the Signal Forms `FORM_FIELD` bound on the same element; with no such field
 * (e.g. `ngModel` / reactive forms) prefill is skipped — remember/forget still work off the DOM
 * event. Storage is resolved lazily so the iOS mirror still works in apps without `@ionic/storage`.
 */
@Directive({
  selector: '[kitAuthInput]',
  standalone: true,
})
export class KitAuthInputDirective implements OnInit {
  readonly #el = inject(ElementRef);
  readonly #injector = inject(Injector);
  /** The Signal Forms field bound on this same element, if any (used to seed the prefill). */
  readonly #field = inject(FORM_FIELD, { optional: true, self: true });

  /** Mode selector; see {@link KitAuthInputMode}. */
  readonly kitAuthInput = input<KitAuthInputMode>('autofill');

  constructor() {}

  /**
   * Register the iOS autofill workaround and, in `'email'` mode, seed the field from storage.
   */
  ngOnInit(): void {
    if (this.#prefills()) {
      void this.#prefillEmail();
    }
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

  /**
   * On every committed change (`ionChange`): remember a well-formed email, or — only in the
   * prefilling `'email'` (sign-in) mode — forget the stored one when the field is cleared or invalid,
   * which is the user intentionally removing the prefill. `'email-remember'` never forgets, so
   * editing the sign-up field cannot wipe an email remembered from sign-in.
   */
  @HostListener('ionChange', ['$event'])
  onIonChange(event: Event): void {
    if (!this.#remembers()) {
      return;
    }
    const storage = this.#resolveStorage();
    if (!storage) {
      return;
    }
    const value = (event as CustomEvent<{ value?: string | null }>).detail?.value ?? '';
    if (value.trim().length > 0 && kitIsValidEmail(value)) {
      void kitRememberEmail(storage, value);
    } else if (this.#forgetsOnClear()) {
      void kitForgetEmail(storage);
    }
  }

  /** Whether this instance persists the entered email (`'email'` or `'email-remember'`). */
  readonly #remembers = computed(() => {
    const mode = this.kitAuthInput();
    return mode === 'email' || mode === 'email-remember';
  });

  /** Whether this instance prefills the field from storage (`'email'` only). */
  readonly #prefills = computed(() => this.kitAuthInput() === 'email');

  /** Whether clearing/invalidating the field forgets the stored email (`'email'` only). */
  readonly #forgetsOnClear = computed(() => this.kitAuthInput() === 'email');

  /** Resolve `KitStorageService` lazily; returns `null` when storage is not configured. */
  #resolveStorage(): KitStorageService | null {
    try {
      return this.#injector.get(KitStorageService);
    } catch {
      return null;
    }
  }

  /**
   * Seed the bound field with the remembered email, but only while it is still empty — so a value
   * the browser/OS autofills during the async recall is not clobbered.
   */
  async #prefillEmail(): Promise<void> {
    const field = this.#field;
    if (!field) {
      return;
    }
    const storage = this.#resolveStorage();
    if (!storage) {
      return;
    }
    const last = await kitRecallEmail(storage);
    const state = field.state();
    if (last && !state.value()) {
      state.value.set(last);
    }
  }
}
