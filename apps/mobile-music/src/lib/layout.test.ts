import { describe, expect, it } from "vitest";

import { columnsOf, contentClassOf, fitsSideBySide, rowsOf, widthClassOf } from "./layout";

const breakpoints = { tablet: 600, wide: 1024 };

describe("widthClassOf", () => {
  it.each([
    [390, "phone"],
    [507, "phone"],
    [744, "tablet"],
    [1023, "tablet"],
    [1024, "wide"],
    [1376, "wide"],
  ] as const)("gives a %ipt window the %s layout", (width, layout) => {
    expect(widthClassOf(width, breakpoints)).toBe(layout);
  });
});

describe("contentClassOf", () => {
  it("keeps an iPad layout in a 600pt window whose margins leave under 600pt", () => {
    expect(contentClassOf("tablet", 584, breakpoints)).toBe("tablet");
  });

  it("lets the sidebar take a wide window's content down to tablet", () => {
    expect(contentClassOf("wide", 768, breakpoints)).toBe("tablet");
    expect(contentClassOf("wide", 1120, breakpoints)).toBe("wide");
  });

  it("keeps a phone a phone", () => {
    expect(contentClassOf("phone", 390, breakpoints)).toBe("phone");
  });
});

describe("columnsOf", () => {
  it("fits two 168pt cards on a phone, three on an iPad mini, and seven on a 13-inch iPad", () => {
    expect(columnsOf(390 - 40, 168, 12)).toBe(2);
    expect(columnsOf(744 - 64, 168, 16)).toBe(3);
    expect(columnsOf(1376 - 64, 168, 16)).toBe(7);
  });

  it("keeps one column when not even one card fits", () => {
    expect(columnsOf(100, 168, 16)).toBe(1);
  });
});

describe("rowsOf", () => {
  it("lays seven albums in rows of three, leaving the last row short", () => {
    expect(rowsOf(["a", "b", "c", "d", "e", "f", "g"], 3)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g"],
    ]);
  });

  it("fills every row when the albums divide evenly", () => {
    expect(rowsOf(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("gives no rows for no albums", () => {
    expect(rowsOf([], 7)).toEqual([]);
  });
});

describe("fitsSideBySide", () => {
  const header = { art: 240, gap: 32, text: 332 };

  it("needs the art, the gap, and the text between the page's edges", () => {
    expect(fitsSideBySide(668, 32, header)).toBe(true);
    expect(fitsSideBySide(667, 32, header)).toBe(false);
  });
});
