import { describe, expect, it } from "vitest";

import { asApiKeyId, broadestLabel, grantablePermissions, keyDetail } from "./api-keys";
import type { ApiKey } from "./api-keys";

const NOW = Date.UTC(2026, 10, 6);

const key = (fields: Partial<ApiKey> = {}): ApiKey => ({
  keyId: asApiKeyId("k1"),
  name: "Home Assistant",
  scopes: ["movies:read", "movies:play"],
  createdAt: NOW - 86_400_000,
  expiresAt: null,
  lastUsedAt: null,
  ...fields,
});

describe("grantablePermissions", () => {
  it("offers only the scopes the person's own session holds", () => {
    expect(
      grantablePermissions(["account", "movies:read", "movies:play"]).map((p) => p.label),
    ).toEqual(["Read Library", "Playback"]);
    expect(
      grantablePermissions(["movies:read", "movies:play", "movies:edit", "admin"]),
    ).toHaveLength(4);
  });
});

describe("broadestLabel", () => {
  it("names a key by the broadest permission it holds", () => {
    expect(broadestLabel(["movies:read", "movies:play"])).toBe("Playback");
    expect(broadestLabel(["admin", "movies:read"])).toBe("Manage Users");
    expect(broadestLabel([])).toBe("");
  });
});

describe("keyDetail", () => {
  it("shows a working key's broadest permission and Expired once it ran out", () => {
    expect(keyDetail(key(), NOW)).toBe("Playback");
    expect(keyDetail(key({ expiresAt: NOW + 1 }), NOW)).toBe("Playback");
    expect(keyDetail(key({ expiresAt: NOW }), NOW)).toBe("Expired");
  });
});
