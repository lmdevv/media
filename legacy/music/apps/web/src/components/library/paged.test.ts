import { describe, expect, it } from "vitest";

import { summarizeChain } from "./paged";
import { splitChain } from "./split-chain";

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

describe("splitChain", () => {
  it("puts a page where an overgrown page stopped, before the page that followed it", () => {
    expect(splitChain([null, "c2", "c3"], null, "c1")).toEqual([null, "c1", "c2", "c3"]);
  });

  it("leaves the chain alone when a page ends where the next one starts, or is the last", () => {
    expect(splitChain([null, "c2"], null, "c2")).toEqual([null, "c2"]);
    expect(splitChain([null, "c2"], "c2", "c3")).toEqual([null, "c2"]);
    expect(splitChain([null], null, "c1")).toEqual([null]);
  });
});
