/**
 *
 * https://github.com/angular/components/blob/main/src/cdk/scrolling/fixed-size-virtual-scroll.ts
 */

/* eslint-disable @rdlabo/rules/deny-soft-private-modifier  */
/* eslint-disable @angular-eslint/directive-selector */
/* eslint-disable @angular-eslint/directive-class-suffix */

import { coerceNumberProperty, NumberInput } from '@angular/cdk/coercion';
import { Directive, ElementRef, forwardRef, inject, Input, OnChanges } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { CdkVirtualScrollViewport, VIRTUAL_SCROLL_STRATEGY, VirtualScrollStrategy } from '@angular/cdk/scrolling';

/** Virtual scrolling strategy for lists with items of known fixed size. */
export class DynamicSizeVirtualScrollStrategy implements VirtualScrollStrategy {
  private readonly _scrolledIndexChange = new Subject<number>();

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  scrolledIndexChange: Observable<number> = this._scrolledIndexChange.pipe(distinctUntilChanged());

  /** The attached viewport. */
  private _viewport: CdkVirtualScrollViewport | null = null;

  /** The size of the items in the virtually scrolling list. */
  private _itemDynamicSize: itemDynamicSize[];

  /** The minimum amount of buffer rendered beyond the viewport (in pixels). */
  private _minBufferPx: number;

  /** The number of buffer items to render beyond the edge of the viewport (in pixels). */
  private _maxBufferPx: number;

  /** This is added for reverse virtual scroll **/
  private _isReverse: boolean;
  measureScrollOffset: number = 0;

  /** This is added for change dataLength **/
  private _latestDataLength: number = 0;

  /**
   * @param itemSize The size of the items in the virtually scrolling list.
   * @param minBufferPx The minimum amount of buffer (in pixels) before needing to render more
   * @param maxBufferPx The amount of buffer (in pixels) to render when rendering more.
   * @param isReverse Added from rdlabo for reverse
   */
  constructor(itemSize: itemDynamicSize[], minBufferPx: number, maxBufferPx: number, isReverse: boolean) {
    this._itemDynamicSize = itemSize;
    this._minBufferPx = minBufferPx;
    this._maxBufferPx = maxBufferPx;
    this._isReverse = isReverse;
  }

  /**
   * Attaches this scroll strategy to a viewport.
   * @param viewport The viewport to attach this strategy to.
   */
  attach(viewport: CdkVirtualScrollViewport) {
    this._viewport = viewport;
    this._updateTotalContentSize();
    this._updateRenderedRange();
  }

  /** Detaches this scroll strategy from the currently attached viewport. */
  detach() {
    this._scrolledIndexChange.complete();
    this._viewport = null;
  }

  /**
   * Update the item size and buffer size.
   * @param itemDynamicSize The size of the items in the virtually scrolling list.
   * @param minBufferPx The minimum amount of buffer (in pixels) before needing to render more
   * @param maxBufferPx The amount of buffer (in pixels) to render when rendering more.
   * @param isReverse
   */
  updateItemAndBufferSize(itemDynamicSize: itemDynamicSize[], minBufferPx: number, maxBufferPx: number, isReverse: boolean) {
    // if (maxBufferPx < minBufferPx && (typeof ngDevMode === 'undefined' || ngDevMode)) {
    if (maxBufferPx < minBufferPx) {
      throw Error('CDK virtual scroll: maxBufferPx must be greater than or equal to minBufferPx');
    }
    this._itemDynamicSize = itemDynamicSize;
    this._minBufferPx = minBufferPx;
    this._maxBufferPx = maxBufferPx;
    this._isReverse = isReverse;
    this._updateTotalContentSize();
    this._updateRenderedRange();
  }

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  onContentScrolled() {
    this._updateRenderedRange();
  }

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  onDataLengthChanged() {
    this._updateTotalContentSize();
    this._updateRenderedRange();
  }

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  onContentRendered() {
    /* no-op */
  }

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  onRenderedOffsetChanged() {
    /* no-op */
  }

  /**
   * Scroll to the offset for the given index.
   * @param index The index of the element to scroll to.
   * @param behavior The ScrollBehavior to use when scrolling.
   */
  scrollToIndex(index: number, behavior: ScrollBehavior): void {
    if (this._viewport) {
      const size = sumItemSize(this._itemDynamicSize, index);
      this._viewport.scrollToOffset(size, behavior);
    }
  }

  /** Update the viewport's total content size. */
  private _updateTotalContentSize() {
    if (!this._viewport) {
      return;
    }

    const size = sumItemSize(this._itemDynamicSize, this._viewport.getDataLength());
    this._viewport.setTotalContentSize(size);
  }

  /** Update the viewport's rendered range. */
  private _updateRenderedRange() {
    if (!this._viewport) {
      return;
    }
    if (this._viewport.getViewportSize() === 0) {
      // DOM is not ready yet. We should check again once the viewport is visible.
      requestAnimationFrame(() => this._viewport?.checkViewportSize());
      return;
    }

    const renderedRange = this._viewport.getRenderedRange();
    const newRange = { start: renderedRange.start, end: renderedRange.end };
    const viewportSize = this._viewport.getViewportSize();
    const dataLength = this._viewport.getDataLength();

    // Reverse offset if _isReverse
    let scrollOffset = !this._isReverse
      ? this._viewport.measureScrollOffset()
      : Math.max(0, this._viewport.getElementRef().nativeElement.scrollTop * -1);

    // let firstVisibleIndex = this._itemDynamicSize > 0 ? scrollOffset / this._itemDynamicSize : 0;
    let firstVisibleIndex = this._itemDynamicSize.length > 0 ? Math.floor(calcIndex(this._itemDynamicSize, scrollOffset)) : 0;

    // If user scrolls to the bottom of the list and data changes to a smaller list
    if (newRange.end > dataLength) {
      // We have to recalculate the first visible index based on new data length and viewport size.
      const maxVisibleItems = Math.ceil(calcIndex(this._itemDynamicSize, viewportSize));
      const newVisibleIndex = Math.max(0, Math.min(firstVisibleIndex, dataLength - maxVisibleItems));

      // If first visible index changed we must update scroll offset to handle start/end buffers
      // Current range must also be adjusted to cover the new position (bottom of new list).
      if (firstVisibleIndex != newVisibleIndex) {
        firstVisibleIndex = newVisibleIndex;
        // scrollOffset = newVisibleIndex * this._itemDynamicSize;
        scrollOffset = sumItemSize(this._itemDynamicSize, newVisibleIndex);
        newRange.start = Math.floor(firstVisibleIndex);
      }

      newRange.end = Math.max(0, Math.min(dataLength, newRange.start + maxVisibleItems));
    }

    // const startBuffer = scrollOffset - newRange.start * this._itemDynamicSize;
    const startBuffer = scrollOffset - sumItemSize(this._itemDynamicSize, newRange.start);
    if (startBuffer < this._minBufferPx && newRange.start != 0) {
      // const expandStart = Math.ceil((this._maxBufferPx - startBuffer) / this._itemDynamicSize);
      const expandStart = Math.ceil(calcIndex(this._itemDynamicSize, this._maxBufferPx - startBuffer, newRange.start, true));
      newRange.start = Math.max(0, newRange.start - expandStart);
      // newRange.end = Math.min(dataLength, Math.ceil(firstVisibleIndex + (viewportSize + this._minBufferPx) / this._itemDynamicSize));
      newRange.end = Math.min(
        dataLength,
        Math.ceil(firstVisibleIndex + calcIndex(this._itemDynamicSize, viewportSize + this._minBufferPx, firstVisibleIndex)) + 1, // firstVisibleIndexを削った影響
      );

      // console.log(
      //   'expandStart',
      //   firstVisibleIndex,
      //   '"' + newRange.start + '-' + newRange.end + '"',
      //   dataLength,
      //   viewportSize + this._minBufferPx,
      //   Math.ceil(firstVisibleIndex + calcIndex(this._itemDynamicSize, viewportSize + this._minBufferPx, firstVisibleIndex)),
      // );
    } else {
      // const endBuffer = newRange.end * this._itemSize - (scrollOffset + viewportSize);
      const endBuffer = Math.max(sumItemSize(this._itemDynamicSize, newRange.end) - (scrollOffset + viewportSize), 0);
      if (endBuffer < this._minBufferPx && newRange.end != dataLength) {
        // const expandEnd = Math.ceil((this._maxBufferPx - endBuffer) / this._itemDynamicSize);
        const expandEnd =
          endBuffer === 0 && newRange.start < newRange.end && dataLength > newRange.end && dataLength === this._latestDataLength
            ? // When endBuffer is 0, but not the last item:
              dataLength - newRange.end
            : Math.ceil(calcIndex(this._itemDynamicSize, this._maxBufferPx - endBuffer, newRange.end));

        if (expandEnd > 0) {
          newRange.end = Math.min(dataLength, newRange.end + expandEnd);
          // Math.floor(firstVisibleIndex - this._minBufferPx / this._itemSize),
          newRange.start = Math.max(
            0,
            Math.floor(firstVisibleIndex - calcIndex(this._itemDynamicSize, this._minBufferPx, firstVisibleIndex, true)),
          );
          // console.log(
          //   'expandEnd',
          //   firstVisibleIndex,
          //   '"' + newRange.start + '-' + newRange.end + '"',
          //   dataLength,
          //   Math.ceil(firstVisibleIndex + calcIndex(this._itemDynamicSize, viewportSize + this._minBufferPx, firstVisibleIndex)),
          // );
        }
      }
    }

    if (newRange.start === 0 && newRange.end === 0 && dataLength > 0) {
      // have items but not rendered, set start index to 0
      newRange.end = dataLength;
    }

    if (firstVisibleIndex === 0 && newRange.start > firstVisibleIndex) {
      // This is bug fix. If newRange.start > firstVisibleIndex, can't visible '0'
      newRange.start = firstVisibleIndex;
    }

    if (newRange.start > newRange.end) {
      // This is bug fix. If newRange.start > newRange.end, it will cause infinite loop.
      newRange.end = Math.min(
        dataLength,
        Math.ceil(newRange.start + calcIndex(this._itemDynamicSize, viewportSize + this._minBufferPx, newRange.start)),
      );
    }

    this._viewport.setRenderedRange(newRange);
    // this._viewport.setRenderedContentOffset(this._itemDynamicSize * newRange.start);
    if (!this._isReverse) {
      this._viewport.setRenderedContentOffset(sumItemSize(this._itemDynamicSize, newRange.start));
    } else {
      let offset = Math.min(0, sumItemSize(this._itemDynamicSize, newRange.start) * -1);
      if (offset === 0) {
        offset = 0;
      }
      this._viewport.setRenderedContentOffset(offset);
    }
    this.measureScrollOffset = scrollOffset;
    this._latestDataLength = dataLength;
    this._scrolledIndexChange.next(firstVisibleIndex);
  }
}

/**
 * Provider factory for `FixedSizeVirtualScrollStrategy` that simply extracts the already created
 * `FixedSizeVirtualScrollStrategy` from the given directive.
 * @param fixedSizeDir The instance of `CdkFixedSizeVirtualScroll` to extract the
 *     `FixedSizeVirtualScrollStrategy` from.
 */
export function _dynamicSizeVirtualScrollStrategyFactory(fixedSizeDir: CdkDynamicSizeVirtualScroll) {
  return fixedSizeDir._scrollStrategy;
}

export type itemDynamicSize = { itemSize: number } & Record<string, string | number>;

export const sumItemSize = (dynamicSize: itemDynamicSize[], endIndex: number): number => {
  return dynamicSize.slice(0, endIndex).reduce((acc, item) => acc + item.itemSize, 0);
};

/**
 * TODO: 計算方法の見直し
 * 0.5 = 0個目の半分はマイナスの計算が生まれるため、1個目からカウント
 */
export const calcIndex = (dynamicSize: itemDynamicSize[], itemSizeRange: number, startIndex = 0, isReverse = false): number => {
  let sum = 0;
  let diffIndex = 0;
  const item = isReverse ? structuredClone(dynamicSize).reverse() : dynamicSize;
  if (isReverse) {
    startIndex = dynamicSize.length - startIndex;
  }
  const calcIndex = item.reduce((acc, currentValue, index) => {
    if (index < startIndex) {
      return acc;
    }
    if (acc !== -1) {
      // 既に見つかった場合、何もしない
      return acc;
    }
    sum += currentValue.itemSize;
    if (sum >= itemSizeRange) {
      if (sum === itemSizeRange) {
        return index - startIndex;
      }

      const diff = sum - itemSizeRange;
      const getOver = item[index].itemSize - diff;
      diffIndex = getOver / item[index].itemSize;
      return Math.max(0, index - 1 + diffIndex - startIndex);
    } else if (index === item.length - 1) {
      return index - startIndex;
    }
    return acc;
  }, -1);
  return calcIndex === -1 ? 0 : calcIndex;
};

/** A virtual scroll strategy that supports fixed-size items. */
@Directive({
  selector: 'cdk-virtual-scroll-viewport[itemDynamicSizes]',
  standalone: true,
  providers: [
    {
      provide: VIRTUAL_SCROLL_STRATEGY,
      useFactory: _dynamicSizeVirtualScrollStrategyFactory,
      deps: [forwardRef(() => CdkDynamicSizeVirtualScroll)],
    },
  ],
})
export class CdkDynamicSizeVirtualScroll implements OnChanges {
  /** The size of the items in the list (in pixels). */
  @Input()
  get itemDynamicSizes(): itemDynamicSize[] {
    return this._itemDynamicSizes;
  }
  set itemDynamicSizes(value: itemDynamicSize[]) {
    // coerceNumberProperty
    this._itemDynamicSizes = value;
  }
  _itemDynamicSizes: itemDynamicSize[] = [];

  /**
   * The minimum amount of buffer rendered beyond the viewport (in pixels).
   * If the amount of buffer dips below this number, more items will be rendered. Defaults to 100px.
   */
  @Input()
  get minBufferPx(): number {
    return this._minBufferPx;
  }
  set minBufferPx(value: NumberInput) {
    this._minBufferPx = coerceNumberProperty(value);
  }
  _minBufferPx = 100;

  /**
   * The number of pixels worth of buffer to render for when rendering new items. Defaults to 200px.
   */
  @Input()
  get maxBufferPx(): number {
    return this._maxBufferPx;
  }
  set maxBufferPx(value: NumberInput) {
    this._maxBufferPx = coerceNumberProperty(value);
  }
  _maxBufferPx = 200;

  @Input()
  get isReverse(): boolean {
    return this._isReverse;
  }
  set isReverse(value: boolean) {
    this._isReverse = value;
  }
  _isReverse = false;

  /** The scroll strategy used by this directive. */
  _scrollStrategy = new DynamicSizeVirtualScrollStrategy(this.itemDynamicSizes, this.minBufferPx, this.maxBufferPx, this.isReverse);

  private el = inject(ElementRef);

  ngOnChanges() {
    if (this.isReverse) {
      this.el.nativeElement.classList.add('reverse-scroll');
    }
    this._scrollStrategy.updateItemAndBufferSize(this.itemDynamicSizes, this.minBufferPx, this.maxBufferPx, this.isReverse);
  }

  /** For isReverse scroll. Because virtualScroll.measureScrollOffset is not work. **/
  get scrollOffset(): number {
    return this._scrollStrategy.measureScrollOffset;
  }
}
