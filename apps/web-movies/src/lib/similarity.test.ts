import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { longestWord, similarity } from "./similarity";

describe("similarity", () => {
  it("scores typos of a title above unrelated titles", () => {
    expect(similarity("dnue prohpecy", "Dune: Prophecy")).toBeGreaterThan(
      similarity("dnue prohpecy", "Past Lives"),
    );
    expect(similarity("Shōgun", "shogun")).toBe(1);
  });

  it("is symmetric and bounded", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const score = similarity(a, b);

        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
        expect(similarity(b, a)).toBeCloseTo(score);
      }),
    );
  });

  it("picks the longest word", () => {
    expect(longestWord("dnue prohpecy")).toBe("prohpecy");
    expect(longestWord("")).toBe("");
  });
});
