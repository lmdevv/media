import * as fc from "fast-check";
import { Option, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  artworkCacheKey,
  artworkUrl,
  COVER_SIZES,
  coverSizeFor,
  requestedArtworkWidth,
  requestedCoverSize,
  sizedArtworkUrl,
} from "./artwork";

const COVER = "http://lar.local/music/art/ab12?ticket=t1.week-one";

describe("coverSizeFor", () => {
  it("asks for the copy of exactly the size a cell is drawn at", () => {
    for (const size of COVER_SIZES) expect(coverSizeFor(size)).toBe(size);
    // A 48-point row at 3x and 2x, a 168-point card and a 192-point album header at 3x.
    expect([48 * 3, 48 * 2, 168 * 3, 192 * 3].map(coverSizeFor)).toEqual([144, 96, 504, 576]);
    expect(coverSizeFor(143.6)).toBe(144);
  });

  it("asks for a copy at least twice a cell with no copy of its size, so the second scaling is harmless", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 640, noNaN: true }), (pixels) => {
        fc.pre(COVER_SIZES.every((size) => size !== Math.round(pixels)));
        const size = coverSizeFor(pixels);

        expect(size).toBeGreaterThanOrEqual(2 * Math.round(pixels));
        // The smallest such copy.
        expect(
          COVER_SIZES.filter((each) => each >= 2 * Math.round(pixels) && each < (size ?? 0)),
        ).toEqual([]);
      }),
    );
    // A 44-point row and a fluid grid card on a 402-point phone at 3x.
    expect([44 * 3, 175 * 3].map(coverSizeFor)).toEqual([336, 1280]);
  });

  it("asks for the original when no copy is the cell's size or twice it", () => {
    fc.assert(
      fc.property(fc.double({ min: 641, max: 1e6, noNaN: true }), (pixels) => {
        fc.pre(COVER_SIZES.every((size) => size !== Math.round(pixels)));
        expect(coverSizeFor(pixels)).toBeUndefined();
      }),
    );
    expect(coverSizeFor(Number.NaN)).toBeUndefined();
  });
});

describe("sizedArtworkUrl", () => {
  it("adds the width after a query, or starts one", () => {
    expect(sizedArtworkUrl(COVER, 144)).toBe(`${COVER}&w=144`);
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

const readCover = (query: string) => requestedCoverSize(new URLSearchParams(query));

describe("requestedArtworkWidth and requestedCoverSize", () => {
  it("read an allowed size, or the original without one", () => {
    expect(read("ticket=t1.x&w=185")).toEqual(Result.succeed(Option.some(185)));
    expect(read("ticket=t1.x")).toEqual(Result.succeed(Option.none()));
    expect(readCover("ticket=t1.x&w=144")).toEqual(Result.succeed(Option.some(144)));
    expect(readCover("ticket=t1.x")).toEqual(Result.succeed(Option.none()));
  });

  it("refuse any other size, each its own list", () => {
    for (const raw of ["100", "186", "144", "abc", "", "185.5", "-185", "1e9"]) {
      expect(read(`w=${raw}`)).toEqual(Result.fail(raw));
    }

    for (const raw of ["100", "185", "145", "abc", "", "144.5", "-144", "1e9"]) {
      expect(readCover(`w=${raw}`)).toEqual(Result.fail(raw));
    }
  });
});
