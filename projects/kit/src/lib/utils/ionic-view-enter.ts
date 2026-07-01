import { ElementRef } from '@angular/core';
import { Observable, startWith } from 'rxjs';

/**
 * Observe an Ionic page's "is currently entered" state from its lifecycle DOM events.
 *
 * @remarks
 * Emits `true` on `ionViewDidEnter` and `false` on `ionViewWillEnter` / `ionViewWillLeave`, seeded
 * with `false` via `startWith`. Useful to pause/resume work (timers, video, expensive rendering)
 * while a page is off-screen in Ionic's stack navigation, without wiring the four lifecycle hooks by
 * hand. The listeners are removed when the Observable is unsubscribed.
 *
 * @param el - an `ElementRef` for the page host element (the `ion-page`)
 * @returns an Observable that emits whether the page is currently entered
 * @example
 * ```ts
 * export class FeedPage {
 *   readonly #host = inject(ElementRef);
 *   readonly isEntered = toSignal(kitCreateDidEnter(this.#host), { initialValue: false });
 * }
 * ```
 */
export const kitCreateDidEnter = (el: ElementRef): Observable<boolean> => {
  return new Observable<boolean>((observer) => {
    const willEnter = () => observer.next(false);
    const didEnter = () => observer.next(true);
    const willLeave = () => observer.next(false);

    el.nativeElement.addEventListener('ionViewWillEnter', willEnter);
    el.nativeElement.addEventListener('ionViewDidEnter', didEnter);
    el.nativeElement.addEventListener('ionViewWillLeave', willLeave);

    return () => {
      el.nativeElement.removeEventListener('ionViewWillEnter', willEnter);
      el.nativeElement.removeEventListener('ionViewDidEnter', didEnter);
      el.nativeElement.removeEventListener('ionViewWillLeave', willLeave);
    };
  }).pipe(startWith(false));
};
