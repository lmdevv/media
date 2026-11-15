import { describe, expect, it } from "vitest";

import { deviceKind } from "./player-actions";

describe("deviceKind", () => {
  it("tells a browser by the name the account client gave it", () => {
    expect(deviceKind("Firefox on Linux")).toBe("web");
    expect(deviceKind("Safari on iPhone")).toBe("web");
    expect(deviceKind("Chrome")).toBe("web");
    expect(deviceKind("Browser on Windows")).toBe("web");
  });

  it("takes any other name for the phone app", () => {
    expect(deviceKind("Aiko's iPhone")).toBe("phone");
    expect(deviceKind("Chrome cast in the kitchen")).toBe("phone");
  });
});
