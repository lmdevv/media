/**
 * Order keys for rows kept in a person's order, a playlist's entries or a queue's: each row holds
 * a number, and a row placed between two others takes one between theirs, so a move or an insert
 * writes one row, never the whole list (old music's `positionBetween`). A tie field unique to each
 * row orders rows whose keys match.
 */

/** The gap between keys of rows appended one after another, and after renumbering. */
export const ORDER_STEP = 1;

/** Below this gap two neighbours are too close to split, and their list is renumbered first. */
const MIN_GAP = 1e-6;

/**
 * The key for a row placed between `before` and `after`, either missing at an end, or null when
 * the two are too close to split and the rows need renumbering first.
 */
export const orderBetween = (before: number | null, after: number | null): number | null => {
  if (before === null) return after === null ? ORDER_STEP : after - ORDER_STEP;

  if (after === null) return before + ORDER_STEP;

  return after - before < MIN_GAP ? null : (before + after) / 2;
};

/** Keys for `count` rows placed one after another between `before` and `after`, or null. */
export const ordersBetween = (
  before: number | null,
  after: number | null,
  count: number,
): ReadonlyArray<number> | null => {
  if (after === null) {
    const start = before ?? 0;

    return Array.from({ length: count }, (_, index) => start + (index + 1) * ORDER_STEP);
  }

  if (before === null) {
    return Array.from({ length: count }, (_, index) => after - (count - index) * ORDER_STEP);
  }

  const gap = (after - before) / (count + 1);

  return gap < MIN_GAP
    ? null
    : Array.from({ length: count }, (_, index) => before + (index + 1) * gap);
};

/** The key of the row at `index` once its list is renumbered from the top. */
export const renumbered = (index: number): number => (index + 1) * ORDER_STEP;
