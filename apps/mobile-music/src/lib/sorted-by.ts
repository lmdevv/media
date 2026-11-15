/**
 * `items` in `compare` order, ties in their original order, without changing `items`. Hermes has
 * no `toSorted`, and lint forbids `sort` even on a copy. It inserts in order, which suits the short
 * lists the app sorts (a queue's tail, the people to share with).
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
