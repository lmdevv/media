/**
 * The arithmetic of dragging a queue row (B03, B04): where the lifted row would land, how the
 * rows between make room, and how fast the list scrolls while the finger rests near an edge.
 * These run as worklets on the UI thread during the drag, and as plain functions in tests.
 */

/** How close to an edge, in points, the finger starts the list scrolling. */
const EDGE = 72;

/** The fastest the list scrolls under the finger, in points per frame. */
const MAX_SPEED = 14;

/**
 * The index a row lifted at `from` would drop at after moving `offset` points down the list
 * (negative is up), among `count` rows of `rowHeight` points.
 */
export const dropIndex = (
  from: number,
  offset: number,
  rowHeight: number,
  count: number,
): number => {
  "worklet";

  if (count <= 0 || rowHeight <= 0) return from;

  return Math.min(count - 1, Math.max(0, from + Math.round(offset / rowHeight)));
};

/**
 * How many rows the row at `index` moves to make room while the row at `from` hovers over `to`:
 * up one (-1), down one (1), or not at all.
 */
export const shiftOf = (index: number, from: number, to: number): -1 | 0 | 1 => {
  "worklet";

  if (from < 0 || index === from) return 0;

  if (from < to && index > from && index <= to) return -1;

  if (to < from && index >= to && index < from) return 1;

  return 0;
};

/**
 * Points per frame to scroll while dragging with the finger `y` points from the top of a list
 * `height` points tall: negative near the top, positive near the bottom, faster closer to the edge.
 */
export const edgeScroll = (y: number, height: number): number => {
  "worklet";

  if (y < EDGE) return -MAX_SPEED * Math.min(1, (EDGE - y) / EDGE);

  if (y > height - EDGE) return MAX_SPEED * Math.min(1, (y - (height - EDGE)) / EDGE);

  return 0;
};

/** `items` with the item at `from` moved to `to`. */
export const moved = <Item>(
  items: ReadonlyArray<Item>,
  from: number,
  to: number,
): ReadonlyArray<Item> => {
  const item = items[from];

  if (item === undefined || from === to) return items;
  const rest = items.filter((_, index) => index !== from);

  return [...rest.slice(0, to), item, ...rest.slice(to)];
};
