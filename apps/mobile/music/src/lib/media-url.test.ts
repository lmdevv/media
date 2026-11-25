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

  it("asks for the smallest width that covers a 48-point row on a 3x phone", () => {
    expect(artSource(origin, cover, 48 * 3)).toEqual({
      uri: `${origin}/music/art/a1?ticket=t1.week-one&w=185`,
      cacheKey: `${origin}/music/art/a1?w=185`,
    });
  });

  it("keeps each width under its own key, and the original under the cover's path", () => {
    expect(artSource(origin, cover, 240 * 3)?.cacheKey).toBe(`${origin}/music/art/a1?w=780`);
    expect(artSource(origin, cover, 2000)).toEqual({
      uri: `${origin}${cover}`,
      cacheKey: `${origin}/music/art/a1`,
    });
    expect(artSource(origin, cover, "original")).toEqual(artSource(origin, cover, 2000));
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
