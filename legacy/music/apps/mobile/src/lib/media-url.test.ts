import { describe, expect, it } from "vitest";

import { resolveMediaUrl } from "./media-url";
import { connectionFor, originCandidates } from "./server";

const [origin] = originCandidates("http://100.94.55.81:8090") ?? [];

if (origin === undefined) throw new Error("the test origin must parse");

describe("resolveMediaUrl", () => {
  it("resolves a path against the server", () => {
    expect(resolveMediaUrl(origin, "/media/art/a1?sig=x")).toBe(
      "http://100.94.55.81:8090/media/art/a1?sig=x",
    );
  });

  it("keeps absolute URLs", () => {
    expect(resolveMediaUrl(origin, "https://cdn.example/a.jpg")).toBe("https://cdn.example/a.jpg");
  });

  it("has no URL without artwork", () => {
    expect(resolveMediaUrl(origin, null)).toBeNull();
    expect(resolveMediaUrl(origin, "")).toBeNull();
  });

  it("never resolves against the Convex path", () => {
    expect(resolveMediaUrl(connectionFor(origin).origin, "media/x")).toBe(
      "http://100.94.55.81:8090/media/x",
    );
  });
});
