import { describe, expect, it } from "vitest";

import { sortedBy } from "./sorted-by";

describe("sortedBy", () => {
  it("sorts a copy, keeping ties in their order and the input as it was", () => {
    const items = [
      { name: "b", n: 1 },
      { name: "a", n: 2 },
      { name: "b", n: 3 },
    ];

    expect(sortedBy(items, (left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: "a", n: 2 },
      { name: "b", n: 1 },
      { name: "b", n: 3 },
    ]);
    expect(items.map((item) => item.n)).toEqual([1, 2, 3]);
  });
});
