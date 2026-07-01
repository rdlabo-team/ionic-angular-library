import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { InAppReview } from '@capacitor-community/in-app-review';

/**
 * Options for {@link kitRequestReview}.
 */
export interface KitRequestReviewOptions {
  /**
   * Key under which the timestamp of the last review request is stored (via `@capacitor/preferences`).
   *
   * @remarks
   * Supplied by the caller so the kit ships no storage keys of its own; each app passes its own enum
   * value.
   */
  readonly storageKey: string;
  /**
   * Minimum number of months between review prompts.
   *
   * @remarks
   * A prompt is only shown when this much time has elapsed since the last one (or when there is no
   * record yet), so the OS review dialog is never nagged repeatedly.
   */
  readonly throttleMonths: number;
}

/**
 * Request the native in-app review dialog, throttled so the user is prompted at most once per window.
 *
 * @remarks
 * A plain function — no DI needed (`@capacitor/preferences`, `@capacitor-community/in-app-review` and
 * `Capacitor` are all static), so the caller invokes it directly and passes its own config rather
 * than injecting a controller. A no-op on non-native platforms. When enough time has elapsed since
 * the last prompt (per {@link KitRequestReviewOptions.throttleMonths}, tracked under
 * {@link KitRequestReviewOptions.storageKey}), it briefly waits for the app to settle, calls
 * `InAppReview.requestReview()`, and records the new timestamp. The wait/throttle/record sequence
 * was previously copy-pasted verbatim across the fleet; centralizing it means a single place to tune
 * the prompt cadence.
 *
 * @param options - the storage key and throttle window; see {@link KitRequestReviewOptions}
 * @returns a Promise that resolves once the request has been made (or immediately if throttled / on web)
 * @example
 * ```ts
 * await kitRequestReview({ storageKey: StorageEnum.lastRequestRate, throttleMonths: 3 });
 * ```
 */
export const kitRequestReview = async (options: KitRequestReviewOptions): Promise<void> => {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000));
  const threshold = new Date();
  threshold.setMonth(threshold.getMonth() - options.throttleMonths);

  const { value } = await Preferences.get({ key: options.storageKey });
  if (!value || new Date(Number(value)).getTime() < threshold.getTime()) {
    await InAppReview.requestReview();
    await Preferences.set({ key: options.storageKey, value: new Date().getTime().toString() });
  }
};
