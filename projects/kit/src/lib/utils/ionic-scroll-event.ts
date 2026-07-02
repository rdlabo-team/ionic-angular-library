import { WritableSignal } from '@angular/core';

/**
 * Toggle the `disabled` flag of a signal-held `ion-infinite-scroll` / `ion-refresher` element.
 *
 * @remarks
 * A tiny pure helper for the common pattern of stashing the completing scroll/refresher element in a
 * signal (e.g. captured from the event) and later enabling/disabling it — for instance disabling
 * infinite scroll once the last page has loaded. A no-op when the signal holds no element.
 *
 * @param completeEvent - a writable signal holding the infinite-scroll / refresher element (or nullish)
 * @param disabled - the value to set on the element's `disabled` property
 * @example
 * ```ts
 * const infinite = signal<HTMLIonInfiniteScrollElement | null>(null);
 * // ...on ionInfinite: infinite.set(ev.target); ...when no more pages:
 * kitChangeEventDisabled(infinite, true);
 * ```
 */
export const kitChangeEventDisabled = (
  completeEvent: WritableSignal<HTMLIonInfiniteScrollElement | HTMLIonRefresherElement | null | undefined>,
  disabled: boolean,
): void => {
  const event = completeEvent();
  if (event) {
    event.disabled = disabled;
  }
};
