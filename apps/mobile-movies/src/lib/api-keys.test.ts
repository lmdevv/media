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
  const aiko = { server: "http://cinema.home", userId: "u_aiko" };
  const mateo = { server: "http://cinema.home", userId: "u_mateo" };
  const aikoElsewhere = { server: "http://other.home", userId: "u_aiko" };

  it("lists the keys made here newest first, drops one revoked by its ID, and empties on End All", () => {
    const keys = madeKeys();
    const changes: Array<number> = [];

    keys.subscribe(() => changes.push(keys.list(aiko).length));
    keys.add(aiko, { keyId: asKeyId("k1"), name: "Home Assistant", detail: "Playback" });
    keys.add(aiko, { keyId: asKeyId("k2"), name: "Script", detail: "Read Library" });

    expect(keys.list(aiko).map((key) => key.name)).toEqual(["Script", "Home Assistant"]);

    keys.revoked(aiko, asKeyId("k1"));

    expect(keys.list(aiko).map((key) => key.keyId)).toEqual(["k2"]);

    keys.endedAll(aiko);

    expect(keys.list(aiko)).toEqual([]);
    expect(changes).toEqual([1, 2, 1, 0]);
  });

  it("keeps each person's keys on each server apart, so switching shows no one else's", () => {
    const keys = madeKeys();

    keys.add(aiko, { keyId: asKeyId("k1"), name: "Aiko's script", detail: "Playback" });

    expect(keys.list(mateo)).toEqual([]);
    expect(keys.list(aikoElsewhere)).toEqual([]);

    keys.endedAll(mateo);

    expect(keys.list(aiko).map((key) => key.name)).toEqual(["Aiko's script"]);
  });

  it("answers the same empty list each time, so a React store reading it settles", () => {
    const keys = madeKeys();

    expect(keys.list(mateo)).toBe(keys.list(mateo));
  });
});
