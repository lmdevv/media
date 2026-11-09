import { describe, expect, it } from "vitest";

import type { CredentialScope } from "../../../commands/scopes";
import { settingTable } from "../../../commands/settings";
import type { SettingName } from "../../../commands/settings";
import type { Id } from "../../../convex/_generated/dataModel";
import { can } from "../../../convex/core/permissions/policy";
import type { Principal } from "../../../convex/core/permissions/policy";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string; the
// policy only compares ids for equality and never sends one to a backend.
const isUserId = (value: string): value is Id<"users"> => value.startsWith("users:");

const userId = (name: string): Id<"users"> => {
  const value = `users:${name}`;

  if (!isUserId(value)) throw new Error(`${value} is not a users id`);

  return value;
};

const AIKO = userId("aiko");

const aiko = (scopes: ReadonlyArray<CredentialScope>, role: "member" | "guest" = "member") =>
  ({
    kind: "person",
    userId: AIKO,
    role,
    scopes,
    restrictions: null,
    sessionKind: "password",
  }) satisfies Principal;

const decide = (principal: Principal, name: SettingName, owner = AIKO) =>
  can(principal, "change", { on: "setting", owner, domains: settingTable[name].domains });

const see = (principal: Principal, owner = AIKO) =>
  can(principal, "see", { on: "setting", owner, domains: ["movies", "music"] });

describe("the settings rule in can", () => {
  it("hides another person's settings, from admins too", () => {
    const admin: Principal = {
      kind: "person",
      userId: userId("admin"),
      role: "admin",
      scopes: ["account", "admin", "movies:play", "music:play"],
      restrictions: null,
      sessionKind: "password",
    };

    expect(decide(admin, "subtitleLanguage")).toEqual({
      allowed: false,
      refusal: "hidden",
      because: "not-yours",
    });
    expect(decide(admin, "volume")).toMatchObject({ because: "not-yours" });
  });

  it("hides every setting from a service", () => {
    const server: Principal = { kind: "service", userId: AIKO, scopes: [] };

    expect(decide(server, "volume")).toMatchObject({ because: "service" });
  });

  it("changes a setting with account or a play scope of a domain that reads it", () => {
    expect(decide(aiko(["account"]), "crossfade")).toEqual({ allowed: true });
    expect(decide(aiko(["music:play"]), "crossfade")).toEqual({ allowed: true });
    expect(decide(aiko(["movies:play"]), "autoplay")).toEqual({ allowed: true });
    expect(decide(aiko(["music:play"]), "subtitleStyle")).toEqual({
      allowed: false,
      refusal: "forbidden",
      because: "scope",
    });
    expect(decide(aiko(["movies:read", "movies:edit"]), "audioLanguage")).toMatchObject({
      because: "scope",
    });
  });

  it("shows a person their own settings whatever their scopes", () => {
    expect(see(aiko(["movies:read"]))).toEqual({ allowed: true });
    expect(see(aiko(["music:play"]))).toEqual({ allowed: true });
    expect(see(aiko(["account"]), userId("someone"))).toMatchObject({ because: "not-yours" });
  });

  it("refuses a guest from a share link every setting, to see or to change", () => {
    const guest = aiko(["movies:play", "music:play"], "guest");
    const refused = { allowed: false, refusal: "forbidden", because: "guest" };

    expect(see(guest)).toEqual(refused);
    expect(decide(guest, "volume")).toEqual(refused);
    expect(decide(guest, "subtitleLanguage")).toEqual(refused);
  });
});
