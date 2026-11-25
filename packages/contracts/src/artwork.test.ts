import * as fc from "fast-check";
import { Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  ARTWORK_WIDTHS,
  artworkCacheKey,
  artworkUrl,
  artworkWidthFor,
  requestedArtworkWidth,
  sizedArtworkUrl,
} from "./artwork";

const COVER = "http://lar.local/music/art/ab12?ticket=t1.week-one";

describe("artworkWidthFor", () => {
  it("asks for the smallest width that covers the drawn pixels", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1280, noNaN: true }), (pixels) => {
        const width = artworkWidthFor(pixels);

        expect(width).toBeDefined();
        expect(width).toBeGreaterThanOrEqual(pixels);
        expect(ARTWORK_WIDTHS.filter((each) => each >= pixels && each < (width ?? 0))).toEqual([]);
      }),
    );
  });

  it("asks for the original past the largest width", () => {
    fc.assert(
      fc.property(fc.double({ min: 1280, max: 1e6, noNaN: true, minExcluded: true }), (pixels) => {
        expect(artworkWidthFor(pixels)).toBeUndefined();
      }),
    );
  });

  it("sizes a 48-point row and a 240-point header on a 3x phone", () => {
    expect(artworkWidthFor(48 * 3)).toBe(185);
    expect(artworkWidthFor(240 * 3)).toBe(780);
    expect(artworkWidthFor(Number.NaN)).toBeUndefined();
  });
});

describe("sizedArtworkUrl", () => {
  it("adds the width after a query, or starts one", () => {
    expect(sizedArtworkUrl(COVER, 185)).toBe(`${COVER}&w=185`);
    expect(sizedArtworkUrl("http://lar.local/artwork/a1.key", 342)).toBe(
      "http://lar.local/artwork/a1.key?w=342",
    );
    expect(sizedArtworkUrl(COVER, undefined)).toBe(COVER);
    expect(artworkUrl("http://lar.local/", "a1.key", 500)).toBe(
      "http://lar.local/artwork/a1.key?w=500",
    );
  });
});

describe("artworkCacheKey", () => {
  it("is the same for an image whatever ticket names it, and differs by width", () => {
    const nextWeek = COVER.replace("week-one", "week-two");

    expect(artworkCacheKey(COVER)).toBe("http://lar.local/music/art/ab12");
    expect(artworkCacheKey(nextWeek)).toBe(artworkCacheKey(COVER));
    expect(artworkCacheKey(sizedArtworkUrl(nextWeek, 185))).toBe(
      artworkCacheKey(sizedArtworkUrl(COVER, 185)),
    );
    expect(artworkCacheKey(sizedArtworkUrl(COVER, 185))).toBe(
      "http://lar.local/music/art/ab12?w=185",
    );
    expect(artworkCacheKey(sizedArtworkUrl(COVER, 342))).not.toBe(
      artworkCacheKey(sizedArtworkUrl(COVER, 185)),
    );
  });

  it("keeps a URL without a ticket as it is", () => {
    expect(artworkCacheKey("file:///covers/ab12")).toBe("file:///covers/ab12");
    expect(artworkCacheKey("http://lar.local/artwork/a1.key?w=185")).toBe(
      "http://lar.local/artwork/a1.key?w=185",
    );
    expect(artworkCacheKey("http://lar.local/artwork/a1.key?w=185&ticket=t1.x")).toBe(
      "http://lar.local/artwork/a1.key?w=185",
    );
  });
});

const read = (query: string) => requestedArtworkWidth(new URLSearchParams(query));

describe("requestedArtworkWidth", () => {
  it("reads an allowed width, or the original without one", () => {
    expect(read("ticket=t1.x&w=185")).toEqual(Result.succeed(Option.some(185)));
    expect(read("ticket=t1.x")).toEqual(Result.succeed(Option.none()));
  });

  it("refuses any other width", () => {
    for (const raw of ["100", "186", "abc", "", "185.5", "-185", "1e9"]) {
      expect(read(`w=${raw}`)).toEqual(Result.fail(raw));
    }
  });
});
