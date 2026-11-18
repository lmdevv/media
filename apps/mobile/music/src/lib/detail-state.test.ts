import { Forbidden, InvalidArgs, NotFound } from "@media/contracts/errors";
import { describe, expect, it } from "vitest";

import { detailStateOf } from "./detail-state";

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
    const gone = new NotFound({ message: "refused: not_found" });
    const closed = new Forbidden({ message: "refused: forbidden" });

    expect(detailStateOf(gone, "Couldn’t load")).toEqual({ kind: "unavailable" });
    expect(detailStateOf(closed, "Couldn’t load")).toEqual({ kind: "unavailable" });
  });

  it("keeps the server's reason for any other failure, or the fallback without one", () => {
    expect(
      detailStateOf(new InvalidArgs({ message: "refused: invalid" }), "Couldn’t load"),
    ).toEqual({
      kind: "failed",
      message: "refused: invalid",
    });
    expect(detailStateOf(new Error("socket closed"), "Couldn’t load")).toEqual({
      kind: "failed",
      message: "Couldn’t load",
    });
  });
});
