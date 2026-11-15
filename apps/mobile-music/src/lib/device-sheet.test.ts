import { describe, expect, it } from "vitest";

import { deviceSheet } from "./device-sheet";
import type { DeviceSheetInput } from "./device-sheet";
import { HERE } from "./transfer";

const mac = { id: "mac", name: "Chrome on macOS" } as const;

const iphone = { id: "iphone", name: "Safari on iPhone" } as const;

const den = { id: "den", name: "Den speaker" } as const;

const input = (overrides: Partial<DeviceSheetInput>): DeviceSheetInput => ({
  family: "iPhone",
  devices: [],
  active: null,
  transfer: { state: "idle" },
  ...overrides,
});

describe("deviceSheet", () => {
  it("lists this phone first as current while it plays, then the others by name (B05)", () => {
    const sheet = deviceSheet(input({ devices: [mac, iphone, den], active: HERE }));

    expect(sheet.kind).toBe("picker");

    if (sheet.kind !== "picker") return;
    expect(sheet.rows.map((row) => [row.name, row.status, row.current, row.kind])).toStrictEqual([
      ["This iPhone", "Playing now", true, "phone"],
      ["Chrome on macOS", "Online", false, "web"],
      ["Safari on iPhone", "Online", false, "phone"],
      ["Den speaker", "Online", false, "phone"],
    ]);
  });

  it("names this device by what it is, such as an iPad", () => {
    const sheet = deviceSheet(input({ family: "iPad", devices: [mac] }));

    expect(sheet.kind === "picker" && sheet.rows[0]?.name).toBe("This iPad");
  });

  it("marks the device that plays current and lists it right after this phone", () => {
    const sheet = deviceSheet(input({ devices: [mac, iphone], active: iphone.id }));

    expect(
      sheet.kind === "picker" && sheet.rows.map((row) => [row.name, row.current]),
    ).toStrictEqual([
      ["This iPhone", false],
      ["Safari on iPhone", true],
      ["Chrome on macOS", false],
    ]);
  });

  it("counts this phone as current while nothing plays anywhere, as old music did", () => {
    const sheet = deviceSheet(input({ devices: [mac] }));

    expect(sheet.kind === "picker" && sheet.rows[0]).toMatchObject({
      current: true,
      status: "Online",
    });
  });

  it("shows only this phone when no other device is online (B08)", () => {
    expect(deviceSheet(input({ active: HERE })).kind).toBe("only");
    expect(deviceSheet(input({})).kind).toBe("only");
  });

  it("keeps the playing device visible while a move is pending (B06)", () => {
    const sheet = deviceSheet(
      input({ devices: [mac], active: HERE, transfer: { state: "pending", to: mac.id } }),
    );

    expect(sheet).toMatchObject({
      kind: "connecting",
      from: { name: "This iPhone", current: true },
      to: { name: "Chrome on macOS" },
    });
  });

  it("moves here from the device that plays, as old music's Play here did", () => {
    const sheet = deviceSheet(
      input({ devices: [mac], active: mac.id, transfer: { state: "pending", to: HERE } }),
    );

    expect(sheet).toMatchObject({
      kind: "connecting",
      from: { name: "Chrome on macOS" },
      to: { name: "This iPhone", thisPhone: true },
    });
  });

  it("says a failed move left playback where it was (B07)", () => {
    const sheet = deviceSheet(
      input({
        devices: [mac],
        active: HERE,
        transfer: { state: "failed", to: mac.id, message: "That device didn’t respond." },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "failed",
      from: { thisPhone: true },
      to: { name: "Chrome on macOS" },
      message: "That device didn’t respond.",
    });
  });

  it("shows the list again once a move lands on the device it named", () => {
    const sheet = deviceSheet(
      input({ devices: [mac], active: mac.id, transfer: { state: "pending", to: mac.id } }),
    );

    expect(sheet.kind).toBe("picker");
  });

  it("shows the list when the device a move went to went offline meanwhile", () => {
    const sheet = deviceSheet(
      input({ devices: [iphone], active: HERE, transfer: { state: "pending", to: mac.id } }),
    );

    expect(sheet.kind).toBe("picker");
  });
});
