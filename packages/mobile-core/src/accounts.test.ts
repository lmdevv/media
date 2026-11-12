import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import {
  accessLabel,
  accountUrlOf,
  canChangeRole,
  expiryLine,
  inviteLink,
  isChangeable,
  libraryAccess,
  personSave,
} from "./accounts";
import type { GrantedLibrary, GroupId, HouseholdUser, LibraryGrant, UserId } from "./accounts";

const userId = Brand.nominal<UserId>();

const groupId = Brand.nominal<GroupId>();

const libraryId = Brand.nominal<GrantedLibrary>();

const family = groupId("g-family");

const NO_GROUPS: ReadonlySet<GroupId> = new Set();

const lucia: HouseholdUser = { userId: userId("u-lucia"), username: "lucia", role: "owner" };

const aiko: HouseholdUser = { userId: userId("u-aiko"), username: "aiko", role: "member" };

const mateo: HouseholdUser = { userId: userId("u-mateo"), username: "mateo", role: "admin" };

const toUser = (person: HouseholdUser): LibraryGrant => ({
  principal: { kind: "user", userId: person.userId, username: person.username },
  level: "view",
});

describe("canChangeRole", () => {
  it("lets an admin change other admins and members, never themselves or the owner", () => {
    expect(canChangeRole(aiko, mateo.userId)).toBe(true);
    expect(canChangeRole(mateo, lucia.userId)).toBe(true);
    expect(canChangeRole(mateo, mateo.userId)).toBe(false);
    expect(canChangeRole(lucia, mateo.userId)).toBe(false);
  });
});

describe("invite links", () => {
  it("puts the code after # on the account client at the server's base", () => {
    const base = accountUrlOf("https://cinema.home/movies/");

    expect(base).toBe("https://cinema.home");
    expect(inviteLink(base, "mi_1.secret")).toBe("https://cinema.home/invite#mi_1.secret");
    expect(inviteLink("http://127.0.0.1:4300/", "mi_2")).toBe("http://127.0.0.1:4300/invite#mi_2");
  });

  it("says how long an invite works", () => {
    expect(expiryLine(7)).toBe("Expires in 7 days");
    expect(expiryLine(1)).toBe("Expires in 1 day");
  });
});

describe("libraryAccess", () => {
  it("follows grants whatever the role, since a library is private until shared", () => {
    expect(libraryAccess(mateo.userId, [], NO_GROUPS)).toStrictEqual({
      direct: "none",
      inherited: null,
    });
    expect(libraryAccess(mateo.userId, [toUser(mateo)], NO_GROUPS).direct).toBe("allowed");
  });

  it("keeps the maker's grant to manage out of reach of a person's page", () => {
    const access = libraryAccess(
      lucia.userId,
      [
        { principal: { kind: "user", userId: lucia.userId, username: "lucia" }, level: "manage" },
        { principal: { kind: "household" }, level: "view" },
      ],
      NO_GROUPS,
    );

    expect(access.direct).toBe("manages");
    expect(isChangeable(access.direct)).toBe(false);
    expect(accessLabel(access.direct, access.inherited)).toBe("Manages");
  });

  it("shows access through a group the person is in, as the core's levelOn counts it", () => {
    const grants: ReadonlyArray<LibraryGrant> = [
      { principal: { kind: "group", groupId: family, name: "Family" }, level: "view" },
    ];

    const member = libraryAccess(aiko.userId, grants, new Set([family]));

    expect(member).toStrictEqual({
      direct: "none",
      inherited: { level: "view", through: "Family" },
    });
    expect(accessLabel(member.direct, member.inherited)).toBe("View, through Family");

    const outsider = libraryAccess(aiko.userId, grants, NO_GROUPS);

    expect(accessLabel(outsider.direct, outsider.inherited)).toBe("Not Allowed");
  });

  it("keeps a person's own grant editable beside what they inherit, the strongest first", () => {
    const access = libraryAccess(
      aiko.userId,
      [
        toUser(aiko),
        { principal: { kind: "household" }, level: "view" },
        { principal: { kind: "group", groupId: family, name: "Family" }, level: "edit" },
      ],
      new Set([family]),
    );

    expect(access).toStrictEqual({
      direct: "allowed",
      inherited: { level: "edit", through: "Family" },
    });
    expect(isChangeable(access.direct)).toBe(true);
    expect(accessLabel("allowed", access.inherited)).toBe("Allowed");
    // Taking her own grant away leaves what the group gives her, never Not Allowed.
    expect(accessLabel("none", access.inherited)).toBe("Edit, through Family");
    expect(accessLabel("none", { level: "view", through: "Everyone" })).toBe(
      "View, through Everyone",
    );
  });
});

describe("personSave", () => {
  const movies = libraryId("lib-movies");

  const shows = libraryId("lib-shows");

  it("saves only library access when another admin promotes the person meanwhile", () => {
    // Aiko's page opens with her a member; the admin gives her Movies. Meanwhile another admin
    // makes her an admin. The save gives Movies and never sends her role back to member.
    const save = personSave(null, "admin", [
      { libraryId: movies, name: "Movies", edit: { from: "none", to: "allowed" }, live: "none" },
    ]);

    expect(save).toStrictEqual({ role: null, give: [movies], takeAway: [], overtaken: [] });
  });

  it("never grants admin back after a demotion made meanwhile", () => {
    const save = personSave(null, "member", [
      { libraryId: shows, name: "Shows", edit: { from: "allowed", to: "none" }, live: "allowed" },
    ]);

    expect(save.role).toBeNull();
    expect(save.takeAway).toStrictEqual([shows]);
  });

  it("names a role the person changed that another admin changed too, before saving over it", () => {
    const save = personSave({ from: "member", to: "admin" }, "admin", []);

    expect(save.role).toBe("admin");
    expect(save.overtaken).toStrictEqual(["Role"]);
  });

  it("names a library whose grant changed meanwhile, and leaves alone one put back", () => {
    const save = personSave(null, "member", [
      { libraryId: movies, name: "Movies", edit: { from: "none", to: "allowed" }, live: "allowed" },
      { libraryId: shows, name: "Shows", edit: { from: "none", to: "none" }, live: "allowed" },
    ]);

    expect(save.give).toStrictEqual([movies]);
    expect(save.takeAway).toStrictEqual([]);
    expect(save.overtaken).toStrictEqual(["Movies"]);
  });

  it("leaves alone a library that now holds a grant to manage, or is not loaded", () => {
    const save = personSave(null, "member", [
      { libraryId: movies, name: "Movies", edit: { from: "none", to: "allowed" }, live: "manages" },
      { libraryId: shows, name: "Shows", edit: { from: "none", to: "allowed" }, live: null },
    ]);

    expect(save).toStrictEqual({ role: null, give: [], takeAway: [], overtaken: [] });
  });
});
