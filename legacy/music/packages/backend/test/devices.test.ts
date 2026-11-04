import { describe, expect, it } from "vitest";

import { DEVICE_LISTED_MS, DEVICE_RETAINED_MS, listedDevices } from "../convex/lib/devices";

const NOW = 1_800_000_000_000;

const device = (deviceId: string, silentMs: number) => ({ deviceId, lastSeenAt: NOW - silentMs });

const listed = (
  devices: ReadonlyArray<ReturnType<typeof device>>,
  keep: ReadonlyArray<string> = [],
): ReadonlyArray<string> => listedDevices(devices, NOW, new Set(keep)).map((each) => each.deviceId);

describe("listedDevices", () => {
  it("lists devices heard from within a day and leaves out longer-silent ones", () => {
    const devices = [
      device("online", 10_000),
      device("idle", 3 * 60 * 60 * 1000),
      device("just-inside", DEVICE_LISTED_MS - 1),
      device("at-cutoff", DEVICE_LISTED_MS),
      device("closed-last-week", 7 * 24 * 60 * 60 * 1000),
    ];

    expect(listed(devices)).toEqual(["online", "idle", "just-inside"]);
  });

  it("keeps the active device and the device asking however long they were silent", () => {
    const devices = [
      device("paused-speaker", 40 * 24 * 60 * 60 * 1000),
      device("waking-laptop", 2 * 24 * 60 * 60 * 1000),
      device("closed-tab", 2 * 24 * 60 * 60 * 1000),
    ];

    expect(listed(devices, ["paused-speaker", "waking-laptop"])).toEqual([
      "paused-speaker",
      "waking-laptop",
    ]);
  });

  it("deletes rows only well after they stop being listed", () => {
    expect(DEVICE_RETAINED_MS).toBeGreaterThan(DEVICE_LISTED_MS);
  });
});
