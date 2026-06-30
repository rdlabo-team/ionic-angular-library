import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

/**
 * Trigger native haptic impact feedback.
 *
 * Delegates to `@capacitor/haptics` `Haptics.impact()` when running on a native platform. On the
 * web (or any non-native platform) it is a no-op and resolves without doing anything.
 *
 * @remarks
 * This haptic side effect was previously bundled implicitly into toast/modal presentation. It has
 * been decoupled into this explicit function so callers opt in to the feedback deliberately, rather
 * than receiving it as a hidden side effect of presenting UI.
 *
 * @param style - The impact intensity to play. Defaults to {@link ImpactStyle.Light}.
 * @returns A promise that resolves once the feedback has been requested (immediately on the web).
 * @example
 * ```ts
 * import { ImpactStyle } from '@capacitor/haptics';
 *
 * // Light tap (default)
 * await kitImpact();
 *
 * // Stronger feedback, e.g. on a confirming action
 * await kitImpact(ImpactStyle.Heavy);
 * ```
 */
export const kitImpact = async (style: ImpactStyle = ImpactStyle.Light): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    await Haptics.impact({ style });
  }
};
