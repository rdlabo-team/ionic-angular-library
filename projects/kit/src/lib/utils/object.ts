/**
 * Order-independent deep equality check.
 *
 * @remarks
 * Returns `true` when `a` and `b` serialize to the same value after their (nested) object entries are
 * sorted by key, so property order does not affect the result. Intended for cheap "did this state
 * object change?" comparisons.
 *
 * Caveats of the JSON-serialization approach: values that JSON drops or coerces (`undefined`,
 * functions, `NaN`, `Date`, `Map`/`Set`) are compared by their serialized form, and array element
 * order is treated as significant (arrays are not reordered in a meaningful way). Use a structural
 * deep-equal library when those cases matter.
 *
 * @param a - First object.
 * @param b - Second object.
 * @returns `true` when the two objects are deeply equal ignoring key order.
 * @example
 * ```ts
 * objectEqual({ a: 1, b: 2 }, { b: 2, a: 1 }); // => true
 * objectEqual({ a: 1 }, { a: 2 });             // => false
 * ```
 */
export const objectEqual = (a: object, b: object): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  const sortDeep = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || !obj) {
      return undefined;
    }
    return Object.entries(obj)
      .sort()
      .map(([entryKey, value]) => [entryKey, typeof value === 'object' ? sortDeep(value) : value]);
  };
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
};
