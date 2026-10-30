import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { dropIndex, edgeScroll, moved, shiftOf } from "./reorder";

const ROW = 64;

describe("dropIndex", () => {
  it("lands a row where the finger left it, by whole rows", () => {
    expect(dropIndex(1, 0, ROW, 4)).toBe(1);
    expect(dropIndex(1, ROW * 0.4, ROW, 4)).toBe(1);
    expect(dropIndex(1, ROW * 0.6, ROW, 4)).toBe(2);
    expect(dropIndex(2, -ROW * 2, ROW, 4)).toBe(0);
  });

  it("never lands outside the list", () => {
    expect(dropIndex(0, -ROW * 10, ROW, 4)).toBe(0);
    expect(dropIndex(3, ROW * 10, ROW, 4)).toBe(3);
  });
});

describe("shiftOf", () => {
  it("moves the rows between up when a row drags down, and down when it drags up", () => {
    expect([0, 1, 2, 3, 4].map((index) => shiftOf(index, 1, 3))).toEqual([0, 0, -1, -1, 0]);
    expect([0, 1, 2, 3, 4].map((index) => shiftOf(index, 3, 1))).toEqual([0, 1, 1, 0, 0]);
  });

  it("moves nothing while no row is lifted", () => {
    expect(shiftOf(2, -1, 0)).toBe(0);
  });

  it("makes the shown order match the order after the drop", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.nat(), fc.nat(), (count, a, b) => {
        const from = a % count;
        const to = b % count;
        const items = Array.from({ length: count }, (_, index) => index);

        const slots = items.map((index) =>
          index === from ? to : index + shiftOf(index, from, to),
        );

        const shown = items.toSorted((x, y) => (slots[x] ?? 0) - (slots[y] ?? 0));

        expect(shown).toEqual(moved(items, from, to));
      }),
    );
  });
});

describe("edgeScroll", () => {
  it("scrolls up near the top, down near the bottom, and not in between", () => {
    expect(edgeScroll(10, 600)).toBeLessThan(0);
    expect(edgeScroll(590, 600)).toBeGreaterThan(0);
    expect(edgeScroll(300, 600)).toBe(0);
  });

  it("scrolls faster closer to the edge", () => {
    expect(Math.abs(edgeScroll(5, 600))).toBeGreaterThan(Math.abs(edgeScroll(50, 600)));
  });

  it("keeps a 72pt edge in a phone's list", () => {
    expect(edgeScroll(71, 285)).toBeLessThan(0);
    expect(edgeScroll(73, 285)).toBe(0);
    expect(edgeScroll(214, 285)).toBeGreaterThan(0);
    expect(edgeScroll(212, 285)).toBe(0);
  });

  it("leaves the rows of the iPad sheet's list still under a resting finger", () => {
    expect(edgeScroll(58, 152)).toBe(0);
    expect(edgeScroll(118, 152)).toBe(0);
  });

  it("still scrolls a short list at full speed at its edges", () => {
    expect(edgeScroll(0, 152)).toBeCloseTo(edgeScroll(0, 285));
    expect(edgeScroll(152, 152)).toBeCloseTo(edgeScroll(285, 285));
  });
});

describe("moved", () => {
  it("moves one item and keeps the rest in order", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moved(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});
