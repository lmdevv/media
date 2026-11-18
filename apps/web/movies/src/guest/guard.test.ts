import { describe, expect, it } from "vitest";

import { guestGuard } from "./guard";

describe("movies guest route", () => {
  it("waits for identity before showing anything", () => {
    expect(guestGuard("loading", undefined)).toBe("loading");
    expect(guestGuard("signedIn", undefined)).toBe("loading");
  });
  it("sends household members and tiles to movies", () => {
    for (const role of ["owner", "admin", "member"] as const)
      expect(guestGuard("signedIn", role)).toBe("member");
  });
  it("only admits guests and ends signed-out playback", () => {
    expect(guestGuard("signedIn", "guest")).toBe("guest");
    expect(guestGuard("signedOut", "guest")).toBe("unavailable");
  });
});
