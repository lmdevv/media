import { describe, expect, it } from "vitest";

import {
  asDeviceId,
  asSessionId,
  deviceDetail,
  listedDevices,
  listedSessions,
  passwordProblem,
  sessionDetail,
  sessionName,
} from "./account";
import type { Device, Session } from "./account";

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

const NOW = Date.UTC(2026, 10, 12, 12);

const session = (id: string, fields: Partial<Session> = {}): Session => ({
  sessionId: asSessionId(id),
  kind: "password",
  name: id,
  device: null,
  scopes: ["account"],
  signedInAt: NOW - 3_600_000,
  expiresAt: NOW + 86_400_000,
  current: false,
  ...fields,
});

describe("sessions", () => {
  it("lists this iPhone first and leaves API keys' sign-ins to API Keys", () => {
    const listed = listedSessions([
      session("laptop"),
      session("script", { kind: "apiKey" }),
      session("phone", { kind: "grant", current: true }),
      session("tv", { kind: "deviceCode" }),
    ]);

    expect(listed.map((each) => each.name)).toEqual(["phone", "laptop", "tv"]);
    expect(listed.map((each) => sessionDetail(each, NOW))).toEqual([
      "This Device",
      "Today",
      "Today",
    ]);
  });

  it("names a session on no device by whether it is this one", () => {
    expect(sessionName(session("x", { name: null, current: true }))).toBe("iPhone");
    expect(sessionName(session("x", { name: null }))).toBe("Password Sign-In");
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
