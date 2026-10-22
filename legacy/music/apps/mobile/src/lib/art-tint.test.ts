import { describe, expect, it } from "vitest";

import { artKey, blurhashAverage, parseHex, playerTint } from "./art-tint";
import type { Rgb } from "./art-tint";

const PLAYER_LIGHT = parseHex("#f3ece3");

const PLAYER_DARK = parseHex("#211b16");

if (PLAYER_LIGHT === null || PLAYER_DARK === null) throw new Error("the Paper tokens must parse");

/** A tan, red-diamond cover like Blue Lines, which Paper's player tokens were drawn from. */
const BLUE_LINES: Rgb = { r: 190, g: 130, b: 100 };

const distance = (a: string, b: Rgb): number => {
  const color = parseHex(a);

  if (color === null) throw new Error(`${a} must be a hex color`);

  return Math.max(Math.abs(color.r - b.r), Math.abs(color.g - b.g), Math.abs(color.b - b.b));
};

const spread = (color: string): number => {
  const parsed = parseHex(color);

  if (parsed === null) throw new Error(`${color} must be a hex color`);

  return Math.max(parsed.r, parsed.g, parsed.b) - Math.min(parsed.r, parsed.g, parsed.b);
};

describe("blurhashAverage", () => {
  it("reads the mean color from a BlurHash", () => {
    // The example hash from the BlurHash README: a mostly grey photo.
    expect(blurhashAverage("LEHV6nWB2yk8pyo0adR*.7kCMdnj")).toEqual({ r: 151, g: 150, b: 149 });
    expect(blurhashAverage("00Rh?C")).not.toBeNull();
  });

  it("has no color for something that is not a BlurHash", () => {
    expect(blurhashAverage("")).toBeNull();
    expect(blurhashAverage("LEH")).toBeNull();
    expect(blurhashAverage("LE  6nWB")).toBeNull();
  });
});

describe("playerTint", () => {
  it("reproduces Paper's player colors for Blue Lines in both themes", () => {
    expect(distance(playerTint(BLUE_LINES, PLAYER_LIGHT), PLAYER_LIGHT)).toBeLessThanOrEqual(4);
    expect(distance(playerTint(BLUE_LINES, PLAYER_DARK), PLAYER_DARK)).toBeLessThanOrEqual(4);
  });

  it("stays neutral for a grey cover", () => {
    expect(spread(playerTint({ r: 128, g: 128, b: 128 }, PLAYER_LIGHT))).toBeLessThanOrEqual(1);
  });

  it("keeps the theme's lightness, so a vivid cover never overpowers the text", () => {
    const vivid = playerTint({ r: 0, g: 40, b: 255 }, PLAYER_LIGHT);
    const parsed = parseHex(vivid);

    expect(parsed).not.toBeNull();
    expect(Math.min(parsed?.r ?? 0, parsed?.g ?? 0, parsed?.b ?? 0)).toBeGreaterThan(200);
    expect(spread(playerTint({ r: 0, g: 40, b: 255 }, PLAYER_DARK))).toBeLessThan(20);
  });
});

describe("artKey", () => {
  it("drops the signature, so a re-signed URL hits the cache", () => {
    expect(artKey("http://h/media/art/abc?exp=1&sig=x")).toBe(
      artKey("http://h/media/art/abc?exp=2&sig=y"),
    );
  });
});

describe("parseHex", () => {
  it("reads six and eight digit colors, ignoring alpha", () => {
    expect(parseHex("#ffffffe8")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("rgb(0 0 0)")).toBeNull();
  });
});
