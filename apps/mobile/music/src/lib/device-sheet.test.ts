import { describe, expect, it } from "vitest";

import { deviceSheet } from "./device-sheet";
import type { DeviceSheetInput } from "./device-sheet";
import { HERE, idleTransfer, nextTransfer } from "./transfer";
import type { Move, MoveEnd, TransferEvent } from "./transfer";

const LOCAL = { kind: "local" } as const;

const mac = { id: "mac", name: "Chrome on macOS", output: LOCAL } as const;

const iphone = { id: "iphone", name: "Safari on iPhone", output: LOCAL } as const;

const den = { id: "den", name: "Den speaker", output: LOCAL } as const;

const PHONE: MoveEnd = { target: HERE, name: "" };

const endOf = (device: { readonly id: string; readonly name: string }): MoveEnd => ({
  target: device.id,
  name: device.name,
});

const move = (from: MoveEnd, to: MoveEnd): Move => ({ id: 1, from, to });

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

  it("says where the sound of a device that casts or AirPlays goes, in place of its status", () => {
    const casting = { ...mac, output: { kind: "cast", receiver: "Living Room TV" } } as const;
    const airplaying = { ...iphone, output: { kind: "airplay", receiver: null } } as const;
    const sheet = deviceSheet(input({ devices: [casting, airplaying], active: mac.id }));

    expect(
      sheet.kind === "picker" && sheet.rows.map((row) => [row.name, row.status, row.current]),
    ).toStrictEqual([
      ["This iPhone", "Online", false],
      ["Chrome on macOS", "Casting to Living Room TV", true],
      ["Safari on iPhone", "AirPlay to a speaker", false],
    ]);
  });

  it("counts this phone as current while nothing plays anywhere", () => {
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
      input({
        devices: [mac],
        active: HERE,
        transfer: { state: "pending", move: move(PHONE, endOf(mac)), landed: false },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "connecting",
      from: { name: "This iPhone", current: true },
      to: { name: "Chrome on macOS" },
    });
  });

  it("moves here from the device that plays", () => {
    const sheet = deviceSheet(
      input({
        devices: [mac],
        active: mac.id,
        transfer: { state: "pending", move: move(endOf(mac), PHONE), landed: true },
      }),
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
        transfer: {
          state: "failed",
          move: move(PHONE, endOf(mac)),
          message: "That device didn’t respond.",
          landed: true,
        },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "failed",
      from: { thisPhone: true },
      to: { name: "Chrome on macOS" },
      message: "That device didn’t respond.",
    });
  });

  it("keeps showing the move while Connect follows the device it went to, until it answers", () => {
    const sheet = deviceSheet(
      input({
        devices: [mac],
        active: mac.id,
        transfer: { state: "pending", move: move(PHONE, endOf(mac)), landed: true },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "connecting",
      from: { thisPhone: true },
      to: { name: "Chrome on macOS" },
    });
  });

  it("shows the list again once the move is done", () => {
    expect(
      deviceSheet(input({ devices: [mac], active: mac.id, transfer: idleTransfer })).kind,
    ).toBe("picker");
  });

  it("keeps a refused move's failure once the device it went to leaves the list", () => {
    const events: ReadonlyArray<TransferEvent> = [
      { type: "start", move: move(PHONE, endOf(mac)) },
      { type: "refused", id: 1, message: "Couldn’t move playback there. Try again." },
    ];

    const transfer = events.reduce(nextTransfer, idleTransfer);
    const listed = deviceSheet(input({ devices: [mac, iphone], active: HERE, transfer }));
    const expired = deviceSheet(input({ devices: [iphone], active: HERE, transfer }));
    const alone = deviceSheet(input({ devices: [], active: HERE, transfer }));

    for (const sheet of [listed, expired, alone]) {
      expect(sheet).toMatchObject({
        kind: "failed",
        from: { name: "This iPhone", thisPhone: true },
        to: { target: mac.id, name: "Chrome on macOS", kind: "web" },
        message: "Couldn’t move playback there. Try again.",
      });
    }
  });

  it("keeps a pending move's devices once the one it went to leaves the list", () => {
    const sheet = deviceSheet(
      input({
        devices: [iphone],
        active: HERE,
        transfer: { state: "pending", move: move(PHONE, endOf(mac)), landed: true },
      }),
    );

    expect(sheet).toMatchObject({ kind: "connecting", to: { name: "Chrome on macOS" } });
  });

  it("names the device a move between two others started from, even once it leaves the list", () => {
    const sheet = deviceSheet(
      input({
        devices: [den],
        active: den.id,
        transfer: {
          state: "failed",
          move: move(endOf(mac), endOf(den)),
          message: "That device didn’t respond.",
          landed: true,
        },
      }),
    );

    expect(sheet).toMatchObject({
      kind: "failed",
      from: { name: "Chrome on macOS", thisPhone: false },
      to: { name: "Den speaker" },
    });
  });
});
