/** Describes the exact pixel size of an item and any consumer-defined tracking metadata. */
export type itemDynamicSize = { itemSize: number } & Record<string, string | number>;

/** Returns the cumulative size of all items before `endIndex`. */
export const sumItemSize = (dynamicSize: itemDynamicSize[], endIndex: number): number => {
  return dynamicSize.slice(0, endIndex).reduce((acc, item) => acc + item.itemSize, 0);
};

/**
 * Retains the package's legacy pixel-to-index calculation for compatibility.
 * @deprecated Use `calculateItemCountForPixelDistance` for mathematically continuous results.
 */
export const calcIndex = (dynamicSize: itemDynamicSize[], itemSizeRange: number, startIndex = 0, isReverse = false): number => {
  let sum = 0;
  let diffIndex = 0;
  const item = isReverse ? [...dynamicSize].reverse() : dynamicSize;
  if (isReverse) {
    startIndex = dynamicSize.length - startIndex;
  }
  const calculatedIndex = item.reduce((acc, currentValue, index) => {
    if (index < startIndex || acc !== -1) {
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
    }
    if (index === item.length - 1) {
      return index - startIndex + 1;
    }
    return acc;
  }, -1);
  return calculatedIndex === -1 ? 0 : calculatedIndex;
};

/**
 * Converts a pixel distance into an exact fractional item count.
 *
 * Forward measurement starts at `startIndex`. Reverse measurement starts immediately before
 * `startIndex`, matching the items that precede a rendered range. The result is bounded by the
 * number of available items in that direction.
 */
export const calculateItemCountForPixelDistance = (
  dynamicSize: itemDynamicSize[],
  itemSizeRange: number,
  startIndex = 0,
  isReverse = false,
): number => {
  let remaining = Math.max(0, itemSizeRange);
  let count = 0;
  let index = isReverse ? Math.min(dynamicSize.length, Math.max(0, Math.trunc(startIndex))) - 1 : Math.max(0, Math.trunc(startIndex));
  const step = isReverse ? -1 : 1;

  while (index >= 0 && index < dynamicSize.length && remaining > 0) {
    const size = dynamicSize[index].itemSize;
    if (remaining < size) {
      return count + remaining / size;
    }
    remaining -= size;
    count += 1;
    index += step;
  }

  return count;
};

/** Builds cumulative item boundaries from zero through `length`. */
export const createPrefixSums = (dynamicSize: itemDynamicSize[], length: number): number[] => {
  const prefixSums = new Array<number>(length + 1);
  prefixSums[0] = 0;
  for (let index = 0; index < length; index += 1) {
    prefixSums[index + 1] = prefixSums[index] + dynamicSize[index].itemSize;
  }
  return prefixSums;
};

const lowerBound = (values: number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const upperBound = (values: number[], target: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

/** Returns the item containing `offset`, choosing the next item at an exact boundary. */
export const indexAtOffset = (prefixSums: number[], offset: number): number => {
  const itemCount = prefixSums.length - 1;
  return Math.min(itemCount - 1, Math.max(0, upperBound(prefixSums, offset) - 1));
};

/** Returns the earliest rendered index whose boundary supplies the requested start buffer. */
export const startIndexForOffset = (prefixSums: number[], offset: number): number => {
  const itemCount = prefixSums.length - 1;
  return Math.min(itemCount - 1, Math.max(0, upperBound(prefixSums, offset) - 1));
};

/** Returns the exclusive rendered end index whose boundary covers `offset`. */
export const endIndexForOffset = (prefixSums: number[], offset: number): number => {
  return Math.min(prefixSums.length - 1, Math.max(1, lowerBound(prefixSums, offset)));
};

/** Mutates a rendered range so it covers the viewport plus equal start and end buffers. */
export const setRangeForBuffer = (
  range: { start: number; end: number },
  prefixSums: number[],
  scrollOffset: number,
  viewportSize: number,
  bufferPx: number,
): void => {
  range.start = startIndexForOffset(prefixSums, scrollOffset - bufferPx);
  range.end = endIndexForOffset(prefixSums, scrollOffset + viewportSize + bufferPx);
};

/** Validates item sizes and virtual scroll buffer configuration. */
export const validateConfiguration = (dynamicSize: itemDynamicSize[], minBufferPx: number, maxBufferPx: number): void => {
  if (!Number.isFinite(minBufferPx) || minBufferPx < 0 || !Number.isFinite(maxBufferPx) || maxBufferPx < minBufferPx) {
    throw Error('CDK virtual scroll: buffers must be finite, non-negative, and maxBufferPx must be greater than or equal to minBufferPx');
  }
  dynamicSize.forEach(({ itemSize }, index) => {
    if (!Number.isFinite(itemSize) || itemSize <= 0) {
      throw Error(`CDK virtual scroll: item size at index ${index} must be a finite number greater than zero`);
    }
  });
};
