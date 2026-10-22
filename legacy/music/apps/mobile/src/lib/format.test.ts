import { describe, expect, it } from "vitest";

import { countOf, libraryLine, librarySummary } from "./format";

describe("countOf", () => {
  it("groups thousands and pluralizes", () => {
    expect(countOf(1, "song")).toBe("1 song");
    expect(countOf(1248, "song")).toBe("1,248 songs");
    expect(countOf(0, "album")).toBe("0 albums");
  });
});

describe("librarySummary", () => {
  it("reads like Paper's summary line", () => {
    expect(librarySummary({ tracks: 1248, albums: 126, artists: 84 })).toBe(
      "1,248 songs · 126 albums · 84 artists",
    );
  });
});

describe("libraryLine", () => {
  it("says who hears the library, then its size", () => {
    expect(libraryLine("shared", 1106)).toBe("Shared · 1,106 songs");
    expect(libraryLine("private", 142)).toBe("Only you · 142 songs");
  });
});
