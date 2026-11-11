import { array, assert, integer, property } from "fast-check";
import { describe, expect, it } from "vitest";

import { episodeLayout, heroHeight, rowsOf, topBarFade } from "./title-layout";

describe("title layout", () => {
  it("keeps the iPhone hero at 480 whatever the window's height", () => {
    expect(heroHeight(874, "compact")).toBe(480);
    expect(heroHeight(956, "compact")).toBe(480);
  });

  it("gives an iPad hero about 56% of the window's height, as Paper draws it", () => {
    expect(heroHeight(1032, "wide")).toBe(578);
    expect(heroHeight(1133, "regular")).toBe(634);
  });

  it("keeps an iPad hero between 480 and 700", () => {
    expect(heroHeight(744, "wide")).toBe(480);
    expect(heroHeight(1376, "regular")).toBe(700);
  });

  it("fades the iPhone's top bar in where it always has", () => {
    expect(topBarFade(480, 62, "compact")).toEqual({ from: 150, to: 200 });
  });

  it("fades an iPad's top bar in once the hero's name reaches it, later in a taller hero", () => {
    expect(topBarFade(578, 24, "wide")).toEqual({ from: 210, to: 260 });
    expect(topBarFade(700, 24, "regular")).toEqual({ from: 332, to: 382 });
  });

  it("lists episodes in rows on an iPhone", () => {
    expect(episodeLayout("compact")).toEqual({ kind: "rows" });
  });

  it("lays episodes in two columns in an iPad's portrait window and three in landscape", () => {
    expect(episodeLayout("regular")).toEqual({ kind: "grid", columns: 2 });
    expect(episodeLayout("wide")).toEqual({ kind: "grid", columns: 3 });
  });

  it("splits items into full rows in order, with the rest on the last row", () => {
    assert(
      property(array(integer()), integer({ min: 1, max: 6 }), (items, columns) => {
        const rows = rowsOf(items, columns);

        expect(rows.flat()).toEqual(items);
        expect(rows.slice(0, -1).every((row) => row.length === columns)).toBe(true);
        expect(rows.every((row) => row.length > 0)).toBe(true);
      }),
    );
  });
});
