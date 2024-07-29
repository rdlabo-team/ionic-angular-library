import { computed, Injectable, Signal } from '@angular/core';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { itemDynamicSize } from './dynamic-size-virtual-scroll.directive';

@Injectable({
  providedIn: 'root',
})
export class DynamicSizeVirtualScrollService {
  readonly mergeScrollY = 160;

  constructor() {}

  onInit(virtualScroll: CdkVirtualScrollViewport, latestScrollOffset: number) {
    if (latestScrollOffset > 0) {
      virtualScroll.scrollToOffset(latestScrollOffset);
    }
  }

  onDestroy(virtualScroll: CdkVirtualScrollViewport): number {
    return virtualScroll.measureScrollOffset('top');
  }

  getBindDynamicItemHeight($calcDynamicItemSize: Signal<itemDynamicSize[]>): Signal<string[]> {
    return computed<string[]>(() => {
      return $calcDynamicItemSize().map((item) => {
        return item['source'] === 'temporary' ? 'auto' : item.itemSize + 'px';
      });
    });
  }

  async scrollToTopSmooth(virtualScroll: CdkVirtualScrollViewport): Promise<void> {
    await this.scrollToPoint(virtualScroll, 0, 0, 400);
  }

  isEnableMerge(virtualScroll: CdkVirtualScrollViewport): boolean {
    return virtualScroll.getRenderedRange().start === 0 && virtualScroll.measureScrollOffset('top') < this.mergeScrollY;
  }

  refreshViewport(virtualScroll: CdkVirtualScrollViewport): void {
    virtualScroll.scrollToOffset(0);
    virtualScroll.setRenderedContentOffset(0);
    virtualScroll.setRenderedRange({ start: 0, end: 0 });
  }

  // https://github.com/ionic-team/ionic-framework/blob/main/core/src/components/content/content.tsx#L357C3-L404C4
  async scrollToPoint(
    el: CdkVirtualScrollViewport,
    x: number | undefined | null,
    y: number | undefined | null,
    duration = 0,
  ): Promise<void> {
    if (duration < 32) {
      if (y != null) {
        el.scrollToOffset(y);
      }
      if (x != null) {
        el.scrollToOffset(x);
      }
      return;
    }

    let resolve!: () => void;
    let startTime = 0;
    const promise = new Promise<void>((r) => (resolve = r));
    const fromY = el.measureScrollOffset('top');
    const fromX = el.measureScrollOffset('left');

    const deltaY = y != null ? y - fromY : 0;
    const deltaX = x != null ? x - fromX : 0;

    // scroll loop
    const step = (timeStamp: number) => {
      const linearTime = Math.min(1, (timeStamp - startTime) / duration) - 1;
      const easedT = Math.pow(linearTime, 3) + 1;

      if (deltaY !== 0) {
        el.scrollToOffset(Math.floor(easedT * deltaY + fromY));
      }
      if (deltaX !== 0) {
        el.scrollToOffset(Math.floor(easedT * deltaX + fromX));
      }

      if (easedT < 1) {
        // do not use DomController here
        // must use nativeRaf in order to fire in the next frame
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    // chill out for a frame first
    requestAnimationFrame((ts) => {
      startTime = ts;
      step(ts);
    });
    return promise;
  }
}
