import { inject, Injectable } from '@angular/core';
import type { LoadingOptions } from '@ionic/angular/standalone';
import { LoadingController } from '@ionic/angular/standalone';

/**
 * Reference-counted wrapper around Ionic's `LoadingController` that keeps at most one loading
 * indicator on screen across concurrent async work.
 *
 * @remarks
 * Each {@link presentLoading} increments a counter and each {@link dismissLoading} decrements it; the
 * indicator is presented on the `0 → 1` transition and dismissed on the `N → 0` transition. This
 * removes the flicker / "stuck spinner" bugs that come from every service calling
 * `LoadingController.create/dismiss` independently.
 *
 * All operations are serialized through an internal promise chain, so a `create → present` sequence
 * can never interleave with a concurrent `dismiss`. That is what makes the counter race-safe: a
 * dismiss that arrives while the indicator is still being presented runs *after* `present()` settles
 * and therefore tears the element down instead of leaving it orphaned on screen.
 *
 * Always pair every `presentLoading()` with exactly one `dismissLoading()` — a `try/finally` is the
 * safest shape.
 *
 * @example
 * ```ts
 * constructor(private readonly loading: KitLoadingController) {}
 *
 * async save(): Promise<void> {
 *   await this.loading.presentLoading({ message: 'Saving…' });
 *   try {
 *     await this.api.save();
 *   } finally {
 *     await this.loading.dismissLoading();
 *   }
 * }
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class KitLoadingController {
  readonly #loadingCtrl = inject(LoadingController);

  /** Outstanding {@link presentLoading} calls not yet balanced by {@link dismissLoading}. */
  #count = 0;

  /** The single presented loading element, or `null` when none is on screen. */
  #loading: HTMLIonLoadingElement | null = null;

  /**
   * Serializes present/dismiss operations. Each call chains onto this promise, runs after the
   * previous operation has fully settled, then reads {@link #count} and acts accordingly.
   */
  #queue: Promise<void> = Promise.resolve();

  /**
   * Show the loading indicator, or join the one already on screen.
   *
   * @param options - Ionic loading options; only applied by the call that actually creates the
   *   indicator (the `0 → 1` transition). Ignored while an indicator is already present.
   * @returns a Promise that resolves once the indicator is on screen (or immediately when one already is)
   */
  async presentLoading(options: LoadingOptions = {}): Promise<void> {
    this.#count++;
    try {
      await this.#enqueue(async () => {
        // Create only on the transition into "something is loading"; concurrent callers ride the same
        // element. Re-check the count in case a dismiss already balanced this call while queued.
        if (this.#count > 0 && this.#loading === null) {
          const loading = await this.#loadingCtrl.create(options);
          await loading.present();
          this.#loading = loading;
        }
      });
    } catch (error) {
      // Roll back the reference this call took: a failed create/present must not leave the counter
      // elevated, otherwise a later cycle never reaches N → 0 and the spinner stays stuck on screen.
      this.#count--;
      throw error;
    }
  }

  /**
   * Release one reference; dismiss the indicator once the last reference is gone.
   *
   * @returns a Promise that resolves once the reference is released (and the indicator dismissed if
   *   this was the last one). No-ops when the counter is already at zero.
   */
  async dismissLoading(): Promise<void> {
    if (this.#count === 0) {
      return;
    }
    this.#count--;
    await this.#enqueue(async () => {
      // Tear down only when the last consumer is gone. Because this runs after any in-flight
      // present() has settled (via the queue), there is never an orphaned loading element.
      if (this.#count === 0 && this.#loading !== null) {
        const loading = this.#loading;
        this.#loading = null;
        await loading.dismiss();
      }
    });
  }

  /**
   * Append `task` to the serialization chain and return its completion.
   *
   * @remarks
   * The stored chain swallows rejections so a single failing operation cannot wedge every future
   * overlay; the returned promise still rejects so the caller observes the error.
   */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
