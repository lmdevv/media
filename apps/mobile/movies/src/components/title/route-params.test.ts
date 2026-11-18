import { describe, expect, it } from "vitest";

import { episodeIdParam, fileIdParam, seasonParam, titleIdParam } from "./route-params";

describe("route params", () => {
  it("reads IDs and treats a missing or empty one as absent", () => {
    expect(titleIdParam("k57abc")).toBe("k57abc");
    expect(titleIdParam(["k57abc", "other"])).toBe("k57abc");
    expect(titleIdParam("")).toBeNull();
    expect(titleIdParam(undefined)).toBeNull();
    expect(titleIdParam([])).toBeNull();
    expect(episodeIdParam("e1")).toBe("e1");
    expect(fileIdParam(undefined)).toBeNull();
    expect(fileIdParam("f2")).toBe("f2");
  });

  it("reads whole season numbers only", () => {
    expect(seasonParam("2")).toBe(2);
    expect(seasonParam("0")).toBe(0);
    expect(seasonParam("-1")).toBeNull();
    expect(seasonParam("2.5")).toBeNull();
    expect(seasonParam("two")).toBeNull();
    expect(seasonParam(undefined)).toBeNull();
  });
});
