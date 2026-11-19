import { describe, expect, it } from "vitest";
import { musicAccess } from "./access";

describe("music route access", () => {
  it("keeps guests on the share and household members in the app", () => {
    expect(musicAccess("guest")).toBe("guest");
    expect(musicAccess("household")).toBe("render");
  });
  it.each(["loading", "signedOut", "failed"] as const)("never renders %s identity", (access) => {
    expect(musicAccess(access)).toBe("wait");
  });
});
