/**
 * Moves in an ordered list, said the way the server takes them: "put this entry just after that
 * one". Naming the neighbour by ID rather than an index means a move made while someone else
 * changed the list still lands next to the entry the person saw, or fails when it is gone.
 */
import { cn } from "@music/ui/lib/utils";

/**
 * The entry that the one at `from` should follow so that it ends up at `to` in `ids` (both
 * indexes into `ids`). At the top it follows `anchor`: the entry before the list (the song playing,
 * above "Next up"), or null when the list starts the whole collection.
 */
export const afterIdFor = <Id>(
  ids: ReadonlyArray<Id>,
  from: number,
  to: number,
  anchor: Id | null,
): Id | null => {
  const rest = ids.filter((_, position) => position !== from);

  return to <= 0 ? anchor : (rest[Math.min(to, rest.length) - 1] ?? anchor);
};

/** `ids` with the entry at `from` moved to `to`. */
export const moveItem = <Id>(ids: ReadonlyArray<Id>, from: number, to: number): Array<Id> => {
  const moving = ids[from];

  if (moving === undefined) return [...ids];
  const rest = ids.filter((_, position) => position !== from);

  return [...rest.slice(0, to), moving, ...rest.slice(to)];
};

/** Whether two lists hold the same entries in the same order. */
export const sameOrder = <Id>(left: ReadonlyArray<Id>, right: ReadonlyArray<Id>): boolean =>
  left.length === right.length && left.every((id, position) => right[position] === id);

/**
 * The order the next move starts from while earlier moves are still on their way to the server.
 * `expected` holds the orders the list should pass through: the server's order when the moves
 * began, then the order after each move. While the server shows one of them, the newest is where
 * it is heading; when it shows something else, someone else changed the list, and its order wins.
 * Pressing an arrow key several times before the list refreshes then moves the entry each time.
 */
export const orderToMoveFrom = <Id>(
  server: ReadonlyArray<Id>,
  expected: ReadonlyArray<ReadonlyArray<Id>>,
): ReadonlyArray<Id> =>
  expected.some((order) => sameOrder(order, server)) ? (expected.at(-1) ?? server) : server;

/** Which half of a row the pointer is over, for showing where a dragged entry would land. */
export type DropSide = "before" | "after";

/** The line drawn where a dragged entry would land. */
export const dropLine = (side: DropSide | null): string =>
  cn(side === "before" && "shadow-drop-before", side === "after" && "shadow-drop-after");

/**
 * Where an entry dragged from `from` lands when dropped on the `side` of the row at `over`, as an
 * index in the list after the move.
 */
export const dropIndex = (from: number, over: number, side: DropSide): number => {
  const target = side === "before" ? over : over + 1;

  return from < target ? target - 1 : target;
};

/**
 * A drag, held by entry rather than by index, so the list can change under it (a move from another
 * device, or the person's own previous move landing) without the drag losing track.
 */
export interface DragState<Id> {
  readonly id: Id | null;
  readonly over: { readonly id: Id; readonly side: DropSide } | null;
}

/** Where a drag stands in the list as it is now. */
export interface DragPositions {
  /** The dragged row's index. */
  readonly from: number;
  /** The row under the pointer and which half of it, or null when there is none (or it left). */
  readonly over: { readonly index: number; readonly side: DropSide } | null;
}

/** The drag's rows as indexes into `ids`; null when nothing is dragged or the dragged entry left. */
export const dragPositions = <Id>(
  ids: ReadonlyArray<Id>,
  drag: DragState<Id>,
): DragPositions | null => {
  if (drag.id === null) return null;

  const from = ids.indexOf(drag.id);

  if (from === -1) return null;

  const overIndex = drag.over === null ? -1 : ids.indexOf(drag.over.id);

  return {
    from,
    over:
      drag.over === null || overIndex === -1 ? null : { index: overIndex, side: drag.over.side },
  };
};
