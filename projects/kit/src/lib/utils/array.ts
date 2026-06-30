/**
 * Merge a newly fetched page of items into an existing list by id, keeping the result sorted.
 *
 * Items are merged by the numeric `key` field. On a duplicate `key` the item from `arrayNew` wins
 * and replaces the one in `arrayOld`. Old items whose `key` falls *inside* the window spanned by
 * `arrayNew` (between its first and last `key`) are dropped, since the freshly fetched page is the
 * authoritative copy of that window; old items *outside* the window are kept. The merged items are
 * finally sorted by `key`, ascending or descending according to `order`.
 *
 * The algorithm is:
 * 1. If both inputs are empty, return an empty array.
 * 2. Read the first (`lead`) and last (`last`) `key` values of `arrayNew` as the bounds of the
 *    page's window. Keep the old items whose `key` lies *outside* that window (at or beyond the
 *    extremes) and drop those strictly inside it, handling both a high-to-low page (`lead > last`)
 *    and a low-to-high page (`lead < last`). A single-value page (`lead === last`) keeps all old items.
 * 3. Remove old items whose `key` already exists in `arrayNew` (new wins on duplicates).
 * 4. Concatenate `arrayNew` with the surviving old items and sort by `key` in the requested
 *    direction.
 *
 * @remarks
 * Designed for infinite-scroll / paginated list merging, where each fetched page may overlap the
 * previously held items and the server returns a contiguous, ordered window of records. The `key`
 * field is treated as a number for range comparison and sorting.
 *
 * @typeParam T - Element type of both arrays. Its `key` property must be a numeric value.
 * @param arrayOld - The previously accumulated list. May be empty or nullish-safe (empty when falsy).
 * @param arrayNew - The newly fetched page of items; its `key` range defines the window that its own
 *   items replace, and its items take precedence on duplicates.
 * @param key - The property of `T` used as the unique, numeric id for matching, range filtering, and sorting.
 * @param order - Sort direction by `key`: `'ASC'` for ascending or `'DESC'` for descending. Defaults to `'DESC'`.
 * @returns A new array containing `arrayNew` merged with the out-of-window, non-duplicate old items, sorted by `key`.
 * @example
 * ```ts
 * interface Post {
 *   id: number;
 *   title: string;
 * }
 *
 * const loaded: Post[] = [
 *   { id: 30, title: 'c' },
 *   { id: 20, title: 'b' },
 *   { id: 10, title: 'a' },
 * ];
 * const nextPage: Post[] = [
 *   { id: 20, title: 'b (updated)' },
 *   { id: 15, title: 'a.5' },
 * ];
 *
 * // Descending merge: id 30 lies above the new page's [15, 20] window so it is kept; id 20 is
 * // inside the window and is replaced by the new value; id 10 lies below the window and is kept.
 * const merged = arrayConcatById(loaded, nextPage, 'id', 'DESC');
 * // => [{ id: 30, title: 'c' }, { id: 20, title: 'b (updated)' }, { id: 15, title: 'a.5' }, { id: 10, title: 'a' }]
 * ```
 */
export const arrayConcatById = <T>(arrayOld: T[], arrayNew: T[], key: keyof T, order: 'ASC' | 'DESC' = 'DESC'): T[] => {
  if (!arrayNew.length && !arrayOld.length) {
    return [];
  }
  const lead = arrayNew[0][key] as number;
  const last = arrayNew[arrayNew.length - 1][key] as number;

  const filteredOld = (arrayOld || []).filter((vol) => {
    const value = vol[key] as number;
    return (lead > last && (value >= lead || value <= last)) || (lead < last && (value <= lead || value >= last)) || lead === last;
  });

  const oldData = filteredOld.filter((vol) => !arrayNew.some((element) => element[key] === vol[key]));
  const data = arrayNew.concat(oldData);

  const direction = order === 'ASC' ? 1 : -1;
  return data.sort((a, b) => {
    const x = a[key] as number;
    const y = b[key] as number;
    if (x > y) {
      return direction;
    }
    if (x < y) {
      return direction * -1;
    }
    return 0;
  });
};
