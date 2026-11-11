import { describe, expect, it } from "vitest";

import { artworkUrl } from "./artwork";

describe("artworkUrl", () => {
  it("resizes a ticketed artwork path for where it is drawn", () => {
    expect(artworkUrl("http://cinema.home", "/artwork/poster-1?ticket=t1", "poster")).toBe(
      "http://cinema.home/artwork/poster-1?ticket=t1&w=342",
    );
    expect(artworkUrl("http://cinema.home", "/artwork/poster-1", "thumb")).toBe(
      "http://cinema.home/artwork/poster-1?w=185",
    );
  });

  it("takes the original for a billboard, and nothing without a path", () => {
    expect(artworkUrl("http://cinema.home", "/artwork/b?ticket=t", "billboard")).toBe(
      "http://cinema.home/artwork/b?ticket=t",
    );
    expect(artworkUrl("http://cinema.home", null, "poster")).toBeUndefined();
    expect(artworkUrl("http://cinema.home", "", "poster")).toBeUndefined();
  });
});
