import { beforeAll, describe, expect, it, vi } from "vitest";

import type { artworkUrl as ArtworkUrl } from "./artwork";

let artworkUrl: typeof ArtworkUrl;

beforeAll(async () => {
  vi.stubEnv("VITE_PLATFORM_URL", "https://media.example/convex");
  vi.stubEnv("VITE_MEDIA_BASE_URL", "https://media.example/");
  ({ artworkUrl } = await import("./artwork"));
});

describe("artworkUrl", () => {
  it("adds the width to a path that carries its ticket", () => {
    expect(artworkUrl("/artwork/a1.poster?ticket=t1", "poster")).toBe(
      "https://media.example/artwork/a1.poster?ticket=t1&w=500",
    );
  });

  it("starts the query for a path without one", () => {
    expect(artworkUrl("/artwork/a1.still", "thumb")).toBe(
      "https://media.example/artwork/a1.still?w=185",
    );
  });

  it("draws no image for missing artwork", () => {
    expect(artworkUrl(null, "backdrop")).toBeUndefined();
    expect(artworkUrl("", "card")).toBeUndefined();
  });
});
