import { describe, expect, it } from "vitest";

import { summarizeChain } from "./paged";

const page = (items: number, done = false) => ({ items, done });

describe("summarizeChain", () => {
  it("is empty only when every loaded page is empty and the last is done", () => {
    expect(summarizeChain([page(0, true)]).empty).toBe(true);
    // Rows in libraries the viewer can't read leave pages empty while more follow.
    expect(summarizeChain([page(0), page(0)]).empty).toBe(false);
    expect(summarizeChain([page(0), page(0), page(0, true)]).empty).toBe(true);
    expect(summarizeChain([page(0), page(3, true)]).empty).toBe(false);
    expect(summarizeChain([page(0), undefined]).empty).toBe(false);
  });

  it("puts the header on the first page with items", () => {
    expect(summarizeChain([page(0), page(0), page(5), page(2, true)]).firstFilled).toBe(2);
    expect(summarizeChain([page(4), page(0, true)]).firstFilled).toBe(0);
    expect(summarizeChain([page(0, true)]).firstFilled).toBe(-1);
  });
});
