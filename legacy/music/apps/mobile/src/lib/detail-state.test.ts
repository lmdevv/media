import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { detailStateOf } from "./detail-state";

const refused = (code: string) => new ConvexError({ code, message: `refused: ${code}` });

describe("detail state", () => {
  it("is loading until the read settles", () => {
    expect(detailStateOf(undefined, "Couldn’t load")).toEqual({ kind: "loading" });
  });

  it("is ready with the record", () => {
    expect(detailStateOf({ title: "Blue Lines" }, "Couldn’t load")).toEqual({
      kind: "ready",
      detail: { title: "Blue Lines" },
    });
  });

  it("is unavailable when the record is gone or access was removed", () => {
    expect(detailStateOf(refused("not_found"), "Couldn’t load")).toEqual({ kind: "unavailable" });
    expect(detailStateOf(refused("forbidden"), "Couldn’t load")).toEqual({ kind: "unavailable" });
  });

  it("keeps the server's reason for any other failure, or the fallback without one", () => {
    expect(detailStateOf(refused("invalid"), "Couldn’t load")).toEqual({
      kind: "failed",
      message: "refused: invalid",
    });
    expect(detailStateOf(new Error("socket closed"), "Couldn’t load")).toEqual({
      kind: "failed",
      message: "Couldn’t load",
    });
  });
});
