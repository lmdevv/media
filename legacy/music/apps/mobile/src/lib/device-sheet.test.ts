import { DeviceId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import { deviceSheet } from "./device-sheet";
import type { DeviceSheetInput } from "./device-sheet";

const id = (value: string): DeviceId => DeviceId.make(value);

const now = 1_000_000_000;

const phone = { id: id("phone-1"), name: "iPhone 17" };

const phoneEntry = { ...phone, kind: "phone", online: true, lastSeenAt: now } as const;

const mac = { id: id("mac"), name: "MacBook", kind: "web", online: true, lastSeenAt: now } as const;

const den = {
  id: id("den"),
  name: "Den",
  kind: "cli",
  online: false,
  lastSeenAt: now - 600_000,
} as const;

const input = (overrides: Partial<DeviceSheetInput>): DeviceSheetInput => ({
  thisDevice: phone,
  devices: [],
  transfer: { state: "idle" },
  now,
  ...overrides,
});

describe("deviceSheet", () => {
  it("lists this phone first as current, then the others (B05)", () => {
    const sheet = deviceSheet(
      input({
        devices: [
          { ...den, active: false },
          { ...mac, active: false },
          { ...phoneEntry, active: true },
        ],
      }),
    );

    expect(sheet.kind).toBe("picker");

    if (sheet.kind !== "picker") return;
    expect(sheet.rows.map((row) => [row.name, row.status, row.current])).toEqual([
      ["This iPhone", "Playing now", true],
      ["MacBook", "Online", false],
      ["Den", "Last seen 10 min ago", false],
    ]);
  });

  it("marks the remote device current while it plays (B02)", () => {
    const sheet = deviceSheet(
      input({
        devices: [
          { ...phoneEntry, active: false },
          { ...mac, active: true },
        ],
      }),
    );

    expect(sheet.kind === "picker" && sheet.rows.find((row) => row.current)?.name).toBe("MacBook");
  });

  it("shows only this phone when no other device signed in (B08)", () => {
    expect(deviceSheet(input({ devices: [{ ...phoneEntry, active: true }] })).kind).toBe("only");
    expect(deviceSheet(input({ devices: [] })).kind).toBe("only");
  });

  it("keeps the playing device visible while a move is pending (B06)", () => {
    const sheet = deviceSheet(
      input({
        devices: [
          { ...phoneEntry, active: true },
          { ...mac, active: false },
        ],
        transfer: { state: "pending", to: mac.id },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "connecting",
      from: { name: "This iPhone", current: true },
      to: { name: "MacBook" },
    });
  });

  it("says a failed move left playback where it was (B07)", () => {
    const sheet = deviceSheet(
      input({
        devices: [
          { ...phoneEntry, active: true },
          { ...mac, active: false },
        ],
        transfer: { state: "failed", to: mac.id, message: "That device didn't respond." },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "failed",
      from: { thisPhone: true },
      to: { name: "MacBook" },
      message: "That device didn't respond.",
    });
  });

  it("shows the list again once a move lands on the device it named", () => {
    const sheet = deviceSheet(
      input({
        devices: [
          { ...phoneEntry, active: false },
          { ...mac, active: true },
        ],
        transfer: { state: "pending", to: mac.id },
      }),
    );

    expect(sheet.kind).toBe("picker");
  });
});
