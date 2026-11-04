import { ApiKey, SessionInfo } from "@media/contracts/models/account";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { deviceDetail, deviceName, keyDetail, listedDevices, listedKeys } from "./account";

const DAY = 86_400_000;

const now = new Date(2026, 9, 17, 12).getTime();

const session = (
  id: string,
  overrides: Partial<Schema.Codec.Encoded<typeof SessionInfo>> = {},
): SessionInfo =>
  Schema.decodeSync(SessionInfo)({
    id,
    kind: "password",
    label: null,
    scopes: ["read", "play", "account"],
    createdAt: now - DAY,
    expiresAt: now + 30 * DAY,
    current: false,
    ...overrides,
  });

const key = (id: string, overrides: Partial<Schema.Codec.Encoded<typeof ApiKey>> = {}): ApiKey =>
  Schema.decodeSync(ApiKey)({
    id,
    userId: "user",
    name: id,
    prefix: "mvs_ab",
    scopes: ["read"],
    createdAt: now - DAY,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });

describe("devices", () => {
  it("lists this iPhone first and leaves API key sessions out", () => {
    const listed = listedDevices([
      session("old", { createdAt: now - 9 * DAY }),
      session("tv", { kind: "device", label: "Living Room Apple TV", createdAt: now - 60_000 }),
      session("key", { kind: "apikey", label: "Home Assistant" }),
      session("me", { current: true, createdAt: now - 3 * DAY }),
    ]);

    expect(listed.map((each) => each.id)).toEqual(["me", "tv", "old"]);
    expect(listed.map(deviceName)).toEqual(["iPhone", "Living Room Apple TV", "Password Sign-In"]);
    expect(listed.map((each) => deviceDetail(each, now))).toEqual([
      "This Device",
      "Today",
      "Oct 8",
    ]);
  });
});

describe("API keys", () => {
  it("leaves revoked keys out, newest first", () => {
    expect(
      listedKeys([
        key("older", { createdAt: now - 5 * DAY }),
        key("revoked", { revokedAt: now }),
        key("newer"),
      ]).map((each) => each.id),
    ).toEqual(["newer", "older"]);
  });

  it("describes a key by its broadest permission, or as expired", () => {
    expect(keyDetail(key("a", { scopes: ["read"] }), now)).toBe("Read Library");
    expect(keyDetail(key("b", { scopes: ["play", "read"] }), now)).toBe("Playback");
    expect(keyDetail(key("c", { scopes: ["admin", "read"] }), now)).toBe("Manage Users");
    expect(keyDetail(key("d", { expiresAt: now - 1 }), now)).toBe("Expired");
  });
});
