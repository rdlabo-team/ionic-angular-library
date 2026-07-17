import {
  calcIndex,
  calculateItemCountForPixelDistance,
  createPrefixSums,
  endIndexForOffset,
  indexAtOffset,
  itemDynamicSize,
  setRangeForBuffer,
  startIndexForOffset,
  sumItemSize,
  validateConfiguration,
} from './dynamic-size-virtual-scroll.util';

const items = (...sizes: number[]): itemDynamicSize[] => sizes.map((itemSize) => ({ itemSize }));

describe('dynamic size virtual scroll utilities', () => {
  it('sums complete items before an index', () => {
    expect(sumItemSize(items(30, 70, 20), 2)).toBe(100);
    expect(sumItemSize(items(30, 70, 20), 99)).toBe(120);
  });

  it('preserves the legacy calcIndex results for existing consumers', () => {
    const sizes = items(55, 55, 42);
    expect(calcIndex(sizes, 50)).toBe(0);
    expect(calcIndex(sizes, 60)).toBe(0.09090909090909091);
  });

  it('converts pixels to a mathematically continuous item count', () => {
    const sizes = items(30, 70, 20);
    expect(calculateItemCountForPixelDistance(sizes, 0)).toBe(0);
    expect(calculateItemCountForPixelDistance(sizes, 30)).toBe(1);
    expect(calculateItemCountForPixelDistance(sizes, 65)).toBe(1.5);
    expect(calculateItemCountForPixelDistance(sizes, 100)).toBe(2);
    expect(calculateItemCountForPixelDistance(sizes, 10, 2)).toBe(0.5);
    expect(calculateItemCountForPixelDistance(sizes, 10, 2, true)).toBeCloseTo(1 / 7);
  });

  it('maps cumulative pixel boundaries to rendered indexes', () => {
    const prefixSums = createPrefixSums(items(30, 70, 20, 80), 4);
    expect(prefixSums).toEqual([0, 30, 100, 120, 200]);
    expect(indexAtOffset(prefixSums, 100)).toBe(2);
    expect(startIndexForOffset(prefixSums, 99)).toBe(1);
    expect(endIndexForOffset(prefixSums, 121)).toBe(4);

    const range = { start: 0, end: 0 };
    setRangeForBuffer(range, prefixSums, 100, 20, 30);
    expect(range).toEqual({ start: 1, end: 4 });
  });

  it('rejects invalid sizes and buffers', () => {
    expect(() => validateConfiguration(items(50, 0), 20, 50)).toThrow(/index 1/);
    expect(() => validateConfiguration(items(50), -1, 50)).toThrow(/buffers/);
  });
});
