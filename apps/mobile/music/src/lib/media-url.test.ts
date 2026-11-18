import { describe, expect, it } from "vitest";

import { resolveMediaUrl } from "./media-url";
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
