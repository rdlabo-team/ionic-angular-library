import { ListRange } from '@angular/cdk/collections';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { DynamicSizeVirtualScrollStrategy } from './dynamic-size-virtual-scroll-strategy';
import { itemDynamicSize } from './dynamic-size-virtual-scroll.util';

interface ViewportHarness {
  viewport: CdkVirtualScrollViewport;
  range: ListRange;
  contentOffset: number;
  totalContentSize: number;
  dataLength: number;
}

const createViewport = (
  sizes: number[],
  { viewportSize = 100, scrollOffset = 0, reverse = false }: { viewportSize?: number; scrollOffset?: number; reverse?: boolean } = {},
): ViewportHarness => {
  const harness: ViewportHarness = {
    viewport: undefined as unknown as CdkVirtualScrollViewport,
    range: { start: 0, end: 0 },
    contentOffset: 0,
    totalContentSize: 0,
    dataLength: sizes.length,
  };
  harness.viewport = {
    getDataLength: () => harness.dataLength,
    getViewportSize: () => viewportSize,
    getRenderedRange: () => harness.range,
    measureScrollOffset: () => scrollOffset,
    getElementRef: () => ({ nativeElement: { scrollTop: reverse ? -scrollOffset : scrollOffset } }),
    setRenderedRange: (range: ListRange) => (harness.range = { ...range }),
    setRenderedContentOffset: (offset: number) => (harness.contentOffset = offset),
    setTotalContentSize: (size: number) => (harness.totalContentSize = size),
    scrollToOffset: vi.fn(),
    checkViewportSize: vi.fn(),
  } as unknown as CdkVirtualScrollViewport;
  return harness;
};

const items = (...sizes: number[]): itemDynamicSize[] => sizes.map((itemSize) => ({ itemSize }));

describe('DynamicSizeVirtualScrollStrategy', () => {
  it('uses cumulative pixel boundaries for the initial rendered range', () => {
    const sizes = [30, 70, 20, 80, 40];
    const harness = createViewport(sizes, { viewportSize: 90 });
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 20, 50, false);

    strategy.attach(harness.viewport);

    // viewport + max buffer = 140px; P[4] = 200 is the first boundary at or after it.
    expect(harness.range).toEqual({ start: 0, end: 4 });
    expect(harness.totalContentSize).toBe(240);
    expect(harness.contentOffset).toBe(0);
  });

  it('selects the item beginning at an exact boundary as the first visible item', () => {
    const sizes = [30, 70, 20, 80, 40, 60];
    const harness = createViewport(sizes, { viewportSize: 80, scrollOffset: 100 });
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 10, 30, false);
    const indexes: number[] = [];
    strategy.scrolledIndexChange.subscribe((index) => indexes.push(index));

    strategy.attach(harness.viewport);

    expect(indexes.at(-1)).toBe(2);
    expect(harness.range).toEqual({ start: 1, end: 5 });
    expect(harness.contentOffset).toBe(30);
  });

  it('keeps the existing range until a buffer falls below minBufferPx', () => {
    const sizes = [50, 50, 50, 50, 50, 50, 50, 50];
    let scrollOffset = 100;
    const harness = createViewport(sizes, { viewportSize: 100, scrollOffset });
    harness.viewport.measureScrollOffset = () => scrollOffset;
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 50, 100, false);

    strategy.attach(harness.viewport);
    expect(harness.range).toEqual({ start: 0, end: 6 });

    scrollOffset = 149;
    strategy.onContentScrolled();
    expect(harness.range).toEqual({ start: 0, end: 6 });

    scrollOffset = 151;
    strategy.onContentScrolled();
    expect(harness.range).toEqual({ start: 2, end: 8 });
  });

  it('uses the same cumulative coordinate system for reverse scrolling', () => {
    const sizes = [30, 70, 20, 80, 40, 60];
    const harness = createViewport(sizes, { viewportSize: 80, scrollOffset: 100, reverse: true });
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 10, 30, true);

    strategy.attach(harness.viewport);

    expect(strategy.measureScrollOffset).toBe(100);
    expect(harness.range).toEqual({ start: 1, end: 5 });
    expect(harness.contentOffset).toBe(-30);
  });

  it('writes the inverse scrollTop coordinate when scrolling to an index in the column-reverse layout', () => {
    const sizes = [30, 70, 20, 80];
    const harness = createViewport(sizes, { reverse: true });
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 10, 30, true);
    strategy.attach(harness.viewport);

    strategy.scrollToIndex(2, 'smooth');

    expect(harness.viewport.scrollToOffset).toHaveBeenCalledWith(-100, 'smooth');
  });

  it('covers the viewport at every integer offset for irregular item sizes', () => {
    const sizes = [17, 61, 5, 103, 29, 47];
    const prefixSums = sizes.reduce<number[]>((sums, size) => [...sums, sums[sums.length - 1] + size], [0]);
    const viewportSize = 47;
    let scrollOffset = 0;
    let firstVisibleIndex = 0;
    const harness = createViewport(sizes, { viewportSize });
    harness.viewport.measureScrollOffset = () => scrollOffset;
    const strategy = new DynamicSizeVirtualScrollStrategy(items(...sizes), 13, 31, false);
    strategy.scrolledIndexChange.subscribe((index) => (firstVisibleIndex = index));
    strategy.attach(harness.viewport);

    for (scrollOffset = 0; scrollOffset <= prefixSums.at(-1)! - viewportSize; scrollOffset += 1) {
      strategy.onContentScrolled();
      const expectedFirstVisible = sizes.findIndex((_, index) => prefixSums[index + 1] > scrollOffset);

      expect(firstVisibleIndex).toBe(expectedFirstVisible);
      expect(harness.range.start).toBeLessThanOrEqual(expectedFirstVisible);
      expect(harness.range.end).toBeGreaterThan(expectedFirstVisible);
      expect(prefixSums[harness.range.end]).toBeGreaterThanOrEqual(scrollOffset + viewportSize);
      expect(harness.contentOffset).toBe(prefixSums[harness.range.start]);
    }
  });

  it('clamps a stale offset after the data shrinks', () => {
    const originalSizes = items(100, 100, 100, 100, 100);
    const harness = createViewport([100, 100, 100, 100, 100], { viewportSize: 100, scrollOffset: 400 });
    harness.range = { start: 3, end: 5 };
    const strategy = new DynamicSizeVirtualScrollStrategy(originalSizes, 20, 50, false);

    strategy.attach(harness.viewport);
    harness.dataLength = 2;
    strategy.onDataLengthChanged();

    // The incomplete model does not replace the last exact geometry.
    expect(harness.totalContentSize).toBe(500);
    expect(harness.range).toEqual({ start: 3, end: 5 });

    strategy.updateItemAndBufferSize(items(100, 100), 20, 50, false);

    expect(strategy.measureScrollOffset).toBe(100);
    expect(harness.range).toEqual({ start: 0, end: 2 });
  });

  it('renders one bootstrap item while the size model is temporarily empty', () => {
    const harness = createViewport([100, 100]);
    const strategy = new DynamicSizeVirtualScrollStrategy([], 20, 50, false);

    strategy.attach(harness.viewport);

    expect(harness.range).toEqual({ start: 0, end: 1 });
    expect(harness.totalContentSize).toBe(0);
  });

  it('retains the last complete geometry while data and size signals have different lengths', () => {
    const harness = createViewport([50, 50, 50], { viewportSize: 50 });
    const strategy = new DynamicSizeVirtualScrollStrategy(items(50, 50, 50), 10, 20, false);
    strategy.attach(harness.viewport);
    const completeRange = { ...harness.range };

    harness.dataLength = 4;
    strategy.onDataLengthChanged();

    expect(harness.totalContentSize).toBe(150);
    expect(harness.range).toEqual(completeRange);
    expect(harness.viewport.scrollToOffset).not.toHaveBeenCalled();

    strategy.updateItemAndBufferSize(items(50, 50, 50, 80), 10, 20, false);
    expect(harness.totalContentSize).toBe(230);
  });

  it('rejects sizes that cannot form a strictly increasing prefix sum', () => {
    expect(() => new DynamicSizeVirtualScrollStrategy(items(50, 0), 20, 50, false)).toThrow(/index 1/);
    expect(() => new DynamicSizeVirtualScrollStrategy(items(50), -1, 50, false)).toThrow(/buffers/);
  });
});
