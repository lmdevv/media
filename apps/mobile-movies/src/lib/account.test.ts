import { describe, expect, it } from "vitest";

import { asDeviceId, deviceDetail, listedDevices, passwordProblem } from "./account";
import type { Device } from "./account";

const device = (id: string, mode: Device["mode"] = "personal"): Device => ({
  deviceId: asDeviceId(id),
  name: id,
  mode,
});

describe("devices", () => {
  it("lists this phone first and the rest in the core's order", () => {
    const own = asDeviceId("phone");

    const listed = listedDevices(
      [device("tv", "shared"), device("laptop"), device("phone"), device("tablet")],
      own,
    );

    expect(listed.map((each) => each.name)).toEqual(["phone", "tv", "laptop", "tablet"]);
    expect(listed.map((each) => deviceDetail(each, own))).toEqual([
      "This Device",
      "Shared",
      "Personal",
      "Personal",
    ]);
  });

  it("keeps the core's order on a session on no device", () => {
    const listed = listedDevices([device("tv"), device("laptop")], null);

    expect(listed.map((each) => each.name)).toEqual(["tv", "laptop"]);
    expect(deviceDetail(device("tv"), null)).toBe("Personal");
  });
});

describe("passwords", () => {
  it("takes 8 to 256 characters, counted as the core counts them", () => {
    expect(passwordProblem("seven77")).toBe("Use 8 to 256 characters");
    expect(passwordProblem("eight888")).toBeNull();
    expect(passwordProblem("🎬".repeat(8))).toBeNull();
    expect(passwordProblem("a".repeat(256))).toBeNull();
    expect(passwordProblem("a".repeat(257))).toBe("Use 8 to 256 characters");
  });
});
