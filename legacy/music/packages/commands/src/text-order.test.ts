import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { compareText } from "./text-order";

/** The sign of comparing two strings code point by code point, the obvious way. */
const byCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let position = 0; position < length; position += 1) {
    const difference = (leftPoints[position] ?? 0) - (rightPoints[position] ?? 0);

    if (difference !== 0) return Math.sign(difference);
  }

  return Math.sign(leftPoints.length - rightPoints.length);
};

describe("compareText", () => {
  it("orders by code point, as Convex orders index keys", () => {
    // UTF-16 puts the emoji (a surrogate pair from U+D83D) before U+FF01; code points don't.
    expect(["！", "😀"].toSorted()).toEqual(["😀", "！"]);
    expect(compareText("😀", "！")).toBeGreaterThan(0);
    expect(compareText("abc", "abd")).toBeLessThan(0);
    expect(compareText("ab", "abc")).toBeLessThan(0);
    expect(compareText("same", "same")).toBe(0);
  });

  it("agrees with comparing code points one by one", () => {
    const text = fc.string({
      unit: fc.constantFrom(
        "a",
        "ｚ",
        "！",
        "😀",
        "𝄞",
        String.fromCodePoint(0xe000),
        String.fromCodePoint(0xffff),
      ),
    });

    fc.assert(
      fc.property(text, text, (left, right) => {
        expect(Math.sign(compareText(left, right))).toBe(byCodePoints(left, right));
      }),
    );
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme" }),
        fc.string({ unit: "grapheme" }),
        (left, right) => {
          expect(Math.sign(compareText(left, right))).toBe(byCodePoints(left, right));
        },
      ),
    );
  });
});
