import { describe, expect, it } from "vitest";

import { barTools } from "./bar-tools";

describe("barTools", () => {
  it("shows the tools while a song is ready or playing", () => {
    expect(barTools({ status: "playing", mediaOnline: true })).toBe("tools");
    expect(barTools({ status: "paused", mediaOnline: true })).toBe("tools");
  });

  it("hides them while loading, buffering, failed, or offline", () => {
    expect(barTools({ status: "loading", mediaOnline: true })).toBe("buffering");
    expect(barTools({ status: "buffering", mediaOnline: true })).toBe("buffering");
    expect(barTools({ status: "error", mediaOnline: true })).toBe("error");
    expect(barTools({ status: "playing", mediaOnline: false })).toBe("offline");
    expect(barTools({ status: "error", mediaOnline: false })).toBe("offline");
  });
});
