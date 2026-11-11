import { describe, expect, it } from "vitest";

import { billboardHeight, pageAt, widthClassOf } from "./layout";

const breakpoints = { regular: 700, wide: 1100 };

describe("layout", () => {
  it("gives every iPhone and a narrow iPad window the compact layout", () => {
    expect(widthClassOf(375, breakpoints)).toBe("compact");
    expect(widthClassOf(440, breakpoints)).toBe("compact");
    expect(widthClassOf(694, breakpoints)).toBe("compact");
  });

  it("gives an iPad in portrait the regular layout and in landscape the wide one", () => {
    expect(widthClassOf(744, breakpoints)).toBe("regular");
    expect(widthClassOf(1032, breakpoints)).toBe("regular");
    expect(widthClassOf(1133, breakpoints)).toBe("wide");
    expect(widthClassOf(1376, breakpoints)).toBe("wide");
  });

  it("sizes an iPad's billboard from the window's height, as Paper draws it", () => {
    expect(billboardHeight("regular", 1133)).toBe(702);
    expect(billboardHeight("wide", 1032)).toBe(722);
  });

  it("keeps an iPad's billboard between 480 and 760 points", () => {
    expect(billboardHeight("regular", 1376)).toBe(760);
    expect(billboardHeight("wide", 600)).toBe(480);
  });

  it("finds the page a pager rests on", () => {
    expect(pageAt(0, 1376, 5)).toBe(0);
    expect(pageAt(2752, 1376, 5)).toBe(2);
    expect(pageAt(2700, 1376, 5)).toBe(2);
  });

  it("never names a page past either end", () => {
    expect(pageAt(-40, 744, 5)).toBe(0);
    expect(pageAt(9000, 744, 5)).toBe(4);
    expect(pageAt(0, 0, 5)).toBe(0);
    expect(pageAt(100, 744, 0)).toBe(0);
  });
});
