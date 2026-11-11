import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { broadestLabel, grantablePermissions, madeKeys } from "./api-keys";
import type { ApiKeyId } from "./api-keys";

const asKeyId = Brand.nominal<ApiKeyId>();

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

describe("madeKeys", () => {
  it("lists the keys made here newest first, drops one revoked by its ID, and empties on End All", () => {
    const keys = madeKeys();
    const changes: Array<number> = [];

    keys.subscribe(() => changes.push(keys.list().length));
    keys.add({ keyId: asKeyId("k1"), name: "Home Assistant", detail: "Playback" });
    keys.add({ keyId: asKeyId("k2"), name: "Script", detail: "Read Library" });

    expect(keys.list().map((key) => key.name)).toEqual(["Script", "Home Assistant"]);

    keys.revoked(asKeyId("k1"));

    expect(keys.list().map((key) => key.keyId)).toEqual(["k2"]);

    keys.endedAll();

    expect(keys.list()).toEqual([]);
    expect(changes).toEqual([1, 2, 1, 0]);
  });
});
