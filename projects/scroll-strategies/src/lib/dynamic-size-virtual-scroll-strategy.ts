/**
 *
 * https://github.com/angular/components/blob/main/src/cdk/scrolling/fixed-size-virtual-scroll.ts
 */

import { BooleanInput, coerceArray, coerceBooleanProperty, coerceNumberProperty, NumberInput } from '@angular/cdk/coercion';
import { Directive, effect, ElementRef, forwardRef, inject, input } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';
import { CdkVirtualScrollViewport, VIRTUAL_SCROLL_STRATEGY, VirtualScrollStrategy } from '@angular/cdk/scrolling';
import {
  createPrefixSums,
  endIndexForOffset,
  indexAtOffset,
  itemDynamicSize,
  setRangeForBuffer,
  startIndexForOffset,
  validateConfiguration,
} from './dynamic-size-virtual-scroll.util';

/** Virtual scrolling strategy for lists whose item sizes are known in advance. */
export class DynamicSizeVirtualScrollStrategy implements VirtualScrollStrategy {
  private readonly _scrolledIndexChange = new Subject<number>();

  /** @docs-private Implemented as part of VirtualScrollStrategy. */
  scrolledIndexChange: Observable<number> = this._scrolledIndexChange.pipe(distinctUntilChanged());

  /** The attached viewport. */
  private _viewport: CdkVirtualScrollViewport | null = null;

  /** The size of the items in the virtually scrolling list. */
  private _itemDynamicSize: itemDynamicSize[];

  /** Cumulative item boundaries. Rebuilt only when the size model or data length changes. */
  private _prefixSums: number[] = [0];
  private _prefixDataLength = -1;

  /** The minimum amount of buffer rendered beyond the viewport (in pixels). */
  private _minBufferPx: number;

  /** The number of buffer items to render beyond the edge of the viewport (in pixels). */
  private _maxBufferPx: number;

  /** This is added for reverse virtual scroll **/
  private _isReverse: boolean;

  /** Last normalized scroll offset, exposed because CDK cannot measure the reverse layout. */
  measureScrollOffset = 0;

  /**
   * @param itemSize The size of the items in the virtually scrolling list.
   * @param minBufferPx The minimum amount of buffer (in pixels) before needing to render more
   * @param maxBufferPx The amount of buffer (in pixels) to render when rendering more.
   * @param isReverse Added from rdlabo for reverse
   */
  constructor(itemSize: itemDynamicSize[], minBufferPx: number, maxBufferPx: number, isReverse: boolean) {
    validateConfiguration(itemSize, minBufferPx, maxBufferPx);
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
    validateConfiguration(itemDynamicSize, minBufferPx, maxBufferPx);
    this._itemDynamicSize = itemDynamicSize;
    this._prefixDataLength = -1;
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
      if (!this._hasCompleteSizeModel(this._viewport.getDataLength())) {
        return;
      }
      const prefixSums = this._getPrefixSums(this._viewport.getDataLength());
      const boundedIndex = Math.min(prefixSums.length - 1, Math.max(0, Math.trunc(index)));
      const offset = prefixSums[boundedIndex];
      this._viewport.scrollToOffset(this._isReverse ? -offset : offset, behavior);
    }
  }

  /** Update the viewport's total content size. */
  private _updateTotalContentSize() {
    if (!this._viewport) {
      return;
    }

    const dataLength = this._viewport.getDataLength();
    if (dataLength === 0) {
      this._viewport.setTotalContentSize(0);
      return;
    }
    if (!this._hasCompleteSizeModel(dataLength)) {
      return;
    }

    const prefixSums = this._getPrefixSums(dataLength);
    this._viewport.setTotalContentSize(prefixSums[prefixSums.length - 1]);
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

    if (dataLength === 0) {
      this._viewport.setRenderedRange({ start: 0, end: 0 });
      this._viewport.setRenderedContentOffset(0);
      this.measureScrollOffset = 0;
      this._scrolledIndexChange.next(0);
      return;
    }

    // Angular can update cdkVirtualForOf and itemDynamicSizes in separate turns. A partial size
    // model cannot define an exact total height or offset, so retain the last complete geometry
    // until both lengths agree. On first attachment, render one item so a measuring consumer can
    // obtain its initial size.
    if (!this._hasCompleteSizeModel(dataLength)) {
      if (newRange.start === 0 && newRange.end === 0) {
        this._viewport.setRenderedRange({ start: 0, end: 1 });
        this._viewport.setRenderedContentOffset(0);
      }
      return;
    }

    const prefixSums = this._getPrefixSums(dataLength);
    const totalContentSize = prefixSums[dataLength];

    // Reverse offset if _isReverse
    const measuredScrollOffset = !this._isReverse
      ? this._viewport.measureScrollOffset()
      : Math.max(0, this._viewport.getElementRef().nativeElement.scrollTop * -1);
    // The browser clamps the actual offset to this interval. Applying the same clamp immediately
    // also makes a data-length shrink deterministic before the next native scroll event.
    const scrollOffset = Math.min(Math.max(0, measuredScrollOffset), Math.max(0, totalContentSize - viewportSize));
    const firstVisibleIndex = indexAtOffset(prefixSums, scrollOffset);

    const rangeIsInvalid = newRange.start < 0 || newRange.start >= newRange.end || newRange.end > dataLength;
    if (rangeIsInvalid) {
      setRangeForBuffer(newRange, prefixSums, scrollOffset, viewportSize, this._maxBufferPx);
    } else {
      const startBuffer = scrollOffset - prefixSums[newRange.start];
      const endBuffer = prefixSums[newRange.end] - (scrollOffset + viewportSize);

      if (startBuffer < this._minBufferPx && newRange.start > 0) {
        newRange.start = startIndexForOffset(prefixSums, scrollOffset - this._maxBufferPx);
        newRange.end = endIndexForOffset(prefixSums, scrollOffset + viewportSize + this._minBufferPx);
      } else if (endBuffer < this._minBufferPx && newRange.end < dataLength) {
        newRange.end = endIndexForOffset(prefixSums, scrollOffset + viewportSize + this._maxBufferPx);
        newRange.start = startIndexForOffset(prefixSums, scrollOffset - this._minBufferPx);
      }
    }

    this._viewport.setRenderedRange(newRange);
    if (!this._isReverse) {
      this._viewport.setRenderedContentOffset(prefixSums[newRange.start]);
    } else {
      let offset = Math.min(0, prefixSums[newRange.start] * -1);
      if (offset === 0) {
        offset = 0;
      }
      this._viewport.setRenderedContentOffset(offset);
    }
    this.measureScrollOffset = scrollOffset;
    this._scrolledIndexChange.next(firstVisibleIndex);
  }

  private _getPrefixSums(dataLength: number): number[] {
    const modeledLength = dataLength;
    if (modeledLength !== this._prefixDataLength) {
      this._prefixSums = createPrefixSums(this._itemDynamicSize, modeledLength);
      this._prefixDataLength = modeledLength;
    }
    return this._prefixSums;
  }

  private _hasCompleteSizeModel(dataLength: number): boolean {
    return this._itemDynamicSize.length === dataLength;
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

/** Directive that installs dynamic-size virtual scrolling on a CDK viewport. */
@Directive({
  selector: 'cdk-virtual-scroll-viewport[itemDynamicSizes]',
  providers: [
    {
      provide: VIRTUAL_SCROLL_STRATEGY,
      useFactory: _dynamicSizeVirtualScrollStrategyFactory,
      deps: [forwardRef(() => CdkDynamicSizeVirtualScroll)],
    },
  ],
})
export class CdkDynamicSizeVirtualScroll {
  private readonly el = inject(ElementRef);

  readonly itemDynamicSizes = input<itemDynamicSize[], itemDynamicSize[]>([], {
    transform: coerceArray,
  });

  /**
   * The minimum amount of buffer rendered beyond the viewport (in pixels).
   * If the amount of buffer dips below this number, more items will be rendered. Defaults to 100px.
   */
  readonly minBufferPx = input<number, NumberInput>(100, {
    transform: coerceNumberProperty,
  });

  /**
   * The number of pixels worth of buffer to render for when rendering new items. Defaults to 200px.
   */
  readonly maxBufferPx = input<number, NumberInput>(200, {
    transform: coerceNumberProperty,
  });

  readonly isReverse = input<boolean, BooleanInput>(false, {
    transform: coerceBooleanProperty,
  });

  /** The scroll strategy used by this directive. */
  readonly _scrollStrategy = new DynamicSizeVirtualScrollStrategy(
    this.itemDynamicSizes(),
    this.minBufferPx(),
    this.maxBufferPx(),
    this.isReverse(),
  );

  constructor() {
    effect(() => {
      if (this.isReverse()) {
        this.el.nativeElement.classList.add('reverse-scroll');
      } else {
        this.el.nativeElement.classList.remove('reverse-scroll');
      }
    });
    effect(() =>
      this._scrollStrategy.updateItemAndBufferSize(this.itemDynamicSizes(), this.minBufferPx(), this.maxBufferPx(), this.isReverse()),
    );
  }

  /** For isReverse scroll. Because virtualScroll.measureScrollOffset is not work. **/
  get scrollOffset(): number {
    return this._scrollStrategy.measureScrollOffset;
  }
}
