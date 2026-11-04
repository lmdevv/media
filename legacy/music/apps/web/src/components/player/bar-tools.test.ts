import { describe, expect, it } from "vitest";

import { barTools } from "./bar-tools";

describe("barTools", () => {
  it("shows the tools, including Play on, while a song is ready or playing", () => {
    expect(barTools({ status: "playing", mediaOnline: true, remote: false })).toBe("tools");
    expect(barTools({ status: "paused", mediaOnline: true, remote: false })).toBe("tools");
  });

  it("hides them while loading, buffering, failed, or offline", () => {
    expect(barTools({ status: "loading", mediaOnline: true, remote: false })).toBe("buffering");
    expect(barTools({ status: "buffering", mediaOnline: true, remote: false })).toBe("buffering");
    expect(barTools({ status: "error", mediaOnline: true, remote: false })).toBe("error");
    expect(barTools({ status: "playing", mediaOnline: false, remote: false })).toBe("offline");
    expect(barTools({ status: "error", mediaOnline: false, remote: false })).toBe("offline");
  });

  it("ignores this browser's media connection while another device plays", () => {
    expect(barTools({ status: "playing", mediaOnline: false, remote: true })).toBe("tools");
  });
});
