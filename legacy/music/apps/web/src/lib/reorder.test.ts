import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { afterIdFor, dropIndex, moveItem, orderToMoveFrom } from "./reorder";

/** Applies a move the way the server does: take the entry out, put it after `after`. */
const applyMove = (
  ids: ReadonlyArray<string>,
  from: number,
  after: string | null,
  anchor: string | null,
): ReadonlyArray<string> => {
  const moving = ids[from];

  if (moving === undefined) return ids;
  const rest = ids.filter((_, position) => position !== from);
  const at = after === null || after === anchor ? 0 : rest.indexOf(after) + 1;

  return [...rest.slice(0, at), moving, ...rest.slice(at)];
};

describe("afterIdFor", () => {
  it("names the neighbour above the new place, or the anchor at the top", () => {
    const ids = ["a", "b", "c", "d"];

    expect(afterIdFor(ids, 3, 0, "now")).toBe("now");
    expect(afterIdFor(ids, 0, 2, null)).toBe("c");
    expect(afterIdFor(ids, 2, 1, null)).toBe("a");
    expect(afterIdFor(ids, 0, 0, null)).toBeNull();
  });

  it("puts the entry exactly where it was asked to go", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 12 }),
        fc.nat(),
        fc.nat(),
        (ids, rawFrom, rawTo) => {
          const from = rawFrom % ids.length;
          const to = rawTo % ids.length;
          const moved = applyMove(ids, from, afterIdFor(ids, from, to, null), null);

          expect(moved[to]).toBe(ids[from]);
          expect(moved.toSorted()).toEqual(ids.toSorted());
        },
      ),
    );
  });
});

describe("orderToMoveFrom", () => {
  it("keeps moving from where earlier moves are heading until the server catches up", () => {
    const start = ["a", "b", "c", "d"];
    const once = moveItem(start, 3, 2);
    const twice = moveItem(once, 2, 1);

    // Two presses before any refresh: the second starts where the first is heading.
    expect(orderToMoveFrom(start, [start, once])).toEqual(once);
    // The server shows the first move: the second is still on its way.
    expect(orderToMoveFrom(once, [start, once, twice])).toEqual(twice);
    expect(orderToMoveFrom(twice, [start, once, twice])).toEqual(twice);
  });

  it("follows the server when someone else changed the list meanwhile", () => {
    const start = ["a", "b", "c"];

    expect(orderToMoveFrom(["c", "a"], [start, moveItem(start, 2, 0)])).toEqual(["c", "a"]);
  });
});

describe("dropIndex", () => {
  it("accounts for the dragged row leaving its place", () => {
    expect(dropIndex(0, 2, "after")).toBe(2);
    expect(dropIndex(0, 2, "before")).toBe(1);
    expect(dropIndex(3, 0, "before")).toBe(0);
    expect(dropIndex(3, 1, "after")).toBe(2);
  });
});
