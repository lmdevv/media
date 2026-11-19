import { describe, expect, it } from "vitest";

import { countOf, homeStats, librarySummary } from "./format";

describe("countOf", () => {
  it("groups thousands and pluralizes", () => {
    expect(countOf(1, "song")).toBe("1 song");
    expect(countOf(1248, "song")).toBe("1,248 songs");
    expect(countOf(0, "album")).toBe("0 albums");
  });
});

describe("librarySummary", () => {
  it("counts songs, albums, and artists", () => {
    expect(librarySummary({ tracks: 1248, albums: 126, artists: 84 })).toBe(
      "1,248 songs · 126 albums · 84 artists",
    );
  });
});

describe("homeStats", () => {
  it("counts albums and songs in caps", () => {
    expect(homeStats({ tracks: 14_920, albums: 1284 })).toBe("1,284 ALBUMS · 14,920 SONGS");
    expect(homeStats({ tracks: 1, albums: 1 })).toBe("1 ALBUM · 1 SONG");
  });
});
