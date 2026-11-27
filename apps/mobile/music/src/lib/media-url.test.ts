import { describe, expect, it } from "vitest";

import { artSource, resolveMediaUrl } from "./media-url";
import { displayHost, sameServer } from "./server";

const origin = "http://100.94.55.81:8090";

describe("resolveMediaUrl", () => {
  it("resolves a path against the media server", () => {
    expect(resolveMediaUrl(origin, "/music/art/a1?ticket=x")).toBe(
      "http://100.94.55.81:8090/music/art/a1?ticket=x",
    );
  });

  it("keeps absolute URLs", () => {
    expect(resolveMediaUrl(origin, "https://cdn.example/a.jpg")).toBe("https://cdn.example/a.jpg");
  });

  it("keeps a downloaded cover's file on this phone", () => {
    expect(resolveMediaUrl(origin, "file:///vault/art/a1.jpg")).toBe("file:///vault/art/a1.jpg");
  });

  it("has no URL without artwork", () => {
    expect(resolveMediaUrl(origin, null)).toBeNull();
    expect(resolveMediaUrl(origin, "")).toBeNull();
  });

  it("resolves a relative path under the server", () => {
    expect(resolveMediaUrl(origin, "media/x")).toBe("http://100.94.55.81:8090/media/x");
  });
});

describe("artSource", () => {
  const cover = "/music/art/a1?ticket=t1.week-one";

  it("asks for a copy of exactly the size a 48-point row draws on a 3x phone", () => {
    expect(artSource(origin, cover, 48 * 3)).toEqual({
      uri: `${origin}/music/art/a1?ticket=t1.week-one&w=144`,
      cacheKey: `${origin}/music/art/a1?w=144`,
    });
  });

  it("keeps each size under its own key, and the original under the cover's path", () => {
    expect(artSource(origin, cover, 192 * 3)?.cacheKey).toBe(`${origin}/music/art/a1?w=576`);
    expect(artSource(origin, cover, 2000)).toEqual({
      uri: `${origin}${cover}`,
      cacheKey: `${origin}/music/art/a1`,
    });
    expect(artSource(origin, cover, "original")).toEqual(artSource(origin, cover, 2000));
  });

  it("asks for a copy at least twice a cell with no copy of its size, or else the original", () => {
    // A 44-point row and a 175-point grid card at 3x.
    expect(artSource(origin, cover, 44 * 3)?.uri).toBe(`${origin}${cover}&w=336`);
    expect(artSource(origin, cover, 175 * 3)?.uri).toBe(`${origin}${cover}&w=1280`);
    expect(artSource(origin, cover, 1280)?.uri).toBe(`${origin}${cover}&w=1280`);
    expect(artSource(origin, cover, 1279)?.uri).toBe(`${origin}${cover}`);
    // Now Playing on a 13-inch iPad: about 900 points at 2x.
    expect(artSource(origin, cover, 900 * 2)?.uri).toBe(`${origin}${cover}`);
  });

  it("keeps a cover's key when its ticket changes", () => {
    const nextWeek = cover.replace("week-one", "week-two");

    expect(artSource(origin, nextWeek, 144)?.cacheKey).toBe(
      artSource(origin, cover, 144)?.cacheKey,
    );
    expect(artSource(origin, nextWeek, 144)?.uri).not.toBe(artSource(origin, cover, 144)?.uri);
  });

  it("loads a cover saved on this phone as it is, and nothing without artwork", () => {
    expect(artSource(origin, "file:///vault/art/a1.jpg", 144)).toEqual({
      uri: "file:///vault/art/a1.jpg",
      cacheKey: "file:///vault/art/a1.jpg",
    });
    expect(artSource(origin, null, 144)).toBeNull();
  });
});

describe("the server's address", () => {
  it("reads without its scheme", () => {
    expect(displayHost("https://cinema.home")).toBe("cinema.home");
  });

  it("matches a link's server with or without a scheme", () => {
    expect(sameServer("cinema.home", "https://cinema.home")).toBe(true);
    expect(sameServer("100.94.55.81:8090", origin)).toBe(true);
    expect(sameServer("https://100.94.55.81:8090", origin)).toBe(false);
    expect(sameServer("other.home", "https://cinema.home")).toBe(false);
  });
});
