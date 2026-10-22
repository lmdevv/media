import { describe, expect, it } from "vitest";

import { countOf, librarySummary } from "./format";

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
