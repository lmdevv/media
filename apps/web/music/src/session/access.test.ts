import { describe, expect, it } from "vitest";
import { musicAccess } from "./access";

describe("music route access", () => {
  it("keeps guests on the share and household members in the app", () => {
    expect(musicAccess("guest", false)).toBe("guest");
    expect(musicAccess("guest", true)).toBe("render");
    expect(musicAccess("household", true)).toBe("home");
    expect(musicAccess("household", false)).toBe("render");
  });
  it.each(["loading", "signedOut", "failed"] as const)("never renders %s identity", (access) => {
    expect(musicAccess(access, true)).toBe("wait");
    expect(musicAccess(access, false)).toBe("wait");
  });
});
