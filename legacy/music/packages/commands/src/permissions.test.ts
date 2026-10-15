import { describe, expect, it } from "vitest";

import type { JamEditScope, JamSettings, Role } from "./models";
import {
  assignableRoles,
  can,
  canControlJam,
  canEditJamEntry,
  jamAddsLeft,
  canManagePerson,
  canManageLibrary,
  canTransferOwnership,
  capabilityLabel,
} from "./permissions";
import { commands, isCommandName } from "./registry";

const ROLES: ReadonlyArray<Role> = ["owner", "admin", "member", "guest"];

describe("permissions", () => {
  it("gives each role its capabilities and every role those below it", () => {
    const table = ROLES.map((role) => [
      role,
      can(role, "user"),
      can(role, "keys"),
      can(role, "share"),
      can(role, "admin"),
      can(role, "owner"),
    ]);

    expect(table).toEqual([
      ["owner", true, true, true, true, true],
      ["admin", true, true, true, true, false],
      ["member", true, true, true, false, false],
      ["guest", true, false, false, false, false],
    ]);
  });

  it("lets admins give roles up to their own, never ownership", () => {
    expect(assignableRoles("owner")).toEqual(["admin", "member", "guest"]);
    expect(assignableRoles("admin")).toEqual(["admin", "member", "guest"]);
    expect(assignableRoles("member")).toEqual([]);
    expect(assignableRoles("guest")).toEqual([]);
  });

  it("keeps the owner and your own account out of people management", () => {
    const owner = { id: "o", role: "owner" } as const;
    const admin = { id: "a", role: "admin" } as const;
    const member = { id: "m", role: "member" } as const;

    expect(canManagePerson(owner, admin)).toBe(true);
    expect(canManagePerson(admin, member)).toBe(true);
    expect(canManagePerson(admin, { id: "b", role: "admin" })).toBe(false);
    expect(canManagePerson(owner, { id: "b", role: "admin" })).toBe(true);
    expect(canManagePerson(admin, owner)).toBe(false);
    expect(canManagePerson(admin, admin)).toBe(false);
    expect(canManagePerson(owner, owner)).toBe(false);
    expect(canManagePerson(member, { id: "g", role: "guest" })).toBe(false);
  });

  it("lets admins manage only libraries they hear, and the owner every one", () => {
    expect(canManageLibrary("owner", false)).toBe(true);
    expect(canManageLibrary("admin", true)).toBe(true);
    expect(canManageLibrary("admin", false)).toBe(false);
    expect(canManageLibrary("member", true)).toBe(false);
  });

  it("transfers ownership only from the owner to an active admin", () => {
    const owner = { id: "o", role: "owner" } as const;
    const admin = { id: "a", role: "admin", suspended: false } as const;

    expect(canTransferOwnership(owner, admin)).toBe(true);
    expect(canTransferOwnership(owner, { ...admin, suspended: true })).toBe(false);
    expect(canTransferOwnership(owner, { ...admin, role: "member" })).toBe(false);
    expect(canTransferOwnership({ id: "b", role: "admin" }, admin)).toBe(false);
  });

  it("labels the capability of every registry command", () => {
    const labels = new Set(
      Object.keys(commands)
        .filter(isCommandName)
        .map((name) => capabilityLabel(commands[name].access)),
    );

    expect([...labels].toSorted()).toEqual([
      "admins only",
      "any user",
      "members and admins; not guests",
      "the owner only",
    ]);
  });
});

/** The default settings, with the given ones changed. */
const jam = ({
  membersCanAdd = true,
  addLimit = 5,
  membersCanControl = false,
  membersCanEdit = "own",
}: {
  readonly membersCanAdd?: boolean;
  readonly addLimit?: number | null;
  readonly membersCanControl?: boolean;
  readonly membersCanEdit?: JamEditScope;
} = {}): JamSettings => ({
  join: "open",
  membersCanAdd,
  addLimit,
  membersCanControl,
  membersCanEdit,
  listenAlong: true,
});

describe("Jam rules", () => {
  it("leaves control to the host unless they share it", () => {
    expect([canControlJam(jam(), true), canControlJam(jam(), false)]).toEqual([true, false]);
    expect(canControlJam(jam({ membersCanControl: true }), false)).toBe(true);
  });

  it("lets people edit nothing, their own entries, or any, and the host everything", () => {
    const table = (["none", "own", "any"] as const).map((scope) => [
      scope,
      canEditJamEntry(jam({ membersCanEdit: scope }), false, true),
      canEditJamEntry(jam({ membersCanEdit: scope }), false, false),
      canEditJamEntry(jam({ membersCanEdit: scope }), true, false),
    ]);

    expect(table).toEqual([
      ["none", false, false, true],
      ["own", true, false, true],
      ["any", true, true, true],
    ]);
  });

  it("counts down each person's upcoming songs to the limit", () => {
    expect(jamAddsLeft(jam(), false, 3)).toBe(2);
    expect(jamAddsLeft(jam(), false, 7)).toBe(0);
    expect(jamAddsLeft(jam({ addLimit: null }), false, 100)).toBeNull();
    expect(jamAddsLeft(jam({ membersCanAdd: false }), false, 0)).toBe(0);
    expect(jamAddsLeft(jam(), true, 100)).toBeNull();
  });
});
