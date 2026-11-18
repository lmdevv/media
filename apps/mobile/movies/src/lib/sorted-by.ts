/**
 * Sorting without `toSorted`, which Hermes does not have; the repository's lint forbids `sort`
 * even on a copy.
 */

/**
 * `items` in `compare` order, ties in their original order, without changing `items`. It inserts
 * in order, which suits the short lists the app sorts (members, sessions, downloads).
 */
export const sortedBy = <A>(
  items: ReadonlyArray<A>,
  compare: (left: A, right: A) => number,
): ReadonlyArray<A> => {
  const sorted: Array<A> = [];

  for (const item of items) {
    const at = sorted.findIndex((other) => compare(item, other) < 0);

    if (at === -1) sorted.push(item);
    else sorted.splice(at, 0, item);
  }

  return sorted;
};
