import { describe, expect, it } from "vitest";

import { appStateStep } from "./app-state";

describe("appStateStep", () => {
  it("parks a player that holds a server stream as the app goes to the background", () => {
    expect(appStateStep("background", { parked: false, holds: "server" })).toBe("park");
  });

  it("keeps a kept download or direct play going in the background", () => {
    expect(appStateStep("background", { parked: false, holds: "none" })).toBe("stay");
  });

  it("keeps playing while the app is only inactive", () => {
    expect(appStateStep("inactive", { parked: false, holds: "server" })).toBe("stay");
    expect(appStateStep("active", { parked: false, holds: "server" })).toBe("stay");
  });

  it("returns a parked player on the next active state, and only then", () => {
    expect(appStateStep("inactive", { parked: true, holds: "none" })).toBe("stay");
    expect(appStateStep("background", { parked: true, holds: "none" })).toBe("stay");
    expect(appStateStep("active", { parked: true, holds: "none" })).toBe("return");
  });
});
