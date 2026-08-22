import type { OnInit } from '@angular/core';
import { computed, Directive, HostListener, inject, Injector, input } from '@angular/core';
import { FORM_FIELD } from '@angular/forms/signals';
import { KitStorageService } from '../storage/kit-storage.service';
import { kitForgetEmail, kitIsValidEmail, kitRecallEmail, kitRememberEmail } from '../storage/kit-auth-email-store';

/**
 * The email persistence mode of {@link KitAuthInputDirective}.
 *
 * - `'email'` — sign-in email: prefill from storage, remember on change, and forget when cleared.
 * - `'email-remember'` — sign-up email: remember on change only, with no prefill or forget behavior.
 */
export type KitAuthInputMode = 'email' | 'email-remember';

/**
 * Email persistence conveniences for an `ion-input`, applied via the `kitAuthInput` attribute.
 *
 * The `'email'` mode recalls the last entered address and seeds an empty Signal Forms field. Both
 * modes remember a well-formed address on `ionChange`; only `'email'` forgets a stored value when
 * the field is cleared or invalid. Browser and OS autofill always wins over an asynchronous prefill.
 *
 * @example
 * ```html
 * <ion-input type="email" autocomplete="email" kitAuthInput="email" [formField]="form.email" />
 * <ion-input type="email" autocomplete="email" kitAuthInput="email-remember" [formField]="form.email" />
 * ```
 *
 * @remarks
 * Prefill writes through the Signal Forms `FORM_FIELD` bound on the same element. With no field,
 * prefill is skipped while remember/forget still work from the DOM event. Storage is resolved lazily
 * so applications that do not configure `@ionic/storage` remain unaffected.
 */
@Directive({
  selector: '[kitAuthInput]',
  standalone: true,
})
export class KitAuthInputDirective implements OnInit {
  readonly #injector = inject(Injector);
  readonly #field = inject(FORM_FIELD, { optional: true, self: true });

  /** Required persistence mode; see {@link KitAuthInputMode}. */
  readonly kitAuthInput = input.required<KitAuthInputMode>();

  /** Seeds an empty sign-in email field from storage. */
  ngOnInit(): void {
    if (this.#prefills()) {
      void this.#prefillEmail();
    }
  }

  /** Remembers a valid committed email and applies the selected clearing policy. */
  @HostListener('ionChange', ['$event'])
  onIonChange(event: Event): void {
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

  readonly #prefills = computed(() => this.kitAuthInput() === 'email');
  readonly #forgetsOnClear = computed(() => this.kitAuthInput() === 'email');

  #resolveStorage(): KitStorageService | null {
    try {
      return this.#injector.get(KitStorageService);
    } catch {
      return null;
    }
  }

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
