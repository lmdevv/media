import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import {
  ACCESS_LABELS,
  accessChangeable,
  accountUrlOf,
  canChangeRole,
  expiryLine,
  inviteLink,
  libraryAccess,
} from "./accounts";
import type { HouseholdUser, LibraryGrant, UserId } from "./accounts";

const userId = Brand.nominal<UserId>();

const groupId = Brand.nominal<Extract<LibraryGrant["principal"], { kind: "group" }>["groupId"]>();

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
  it("lets admins and the owner reach every library by their role", () => {
    expect(libraryAccess(mateo.userId, "admin", [])).toBe("byRole");
    expect(libraryAccess(lucia.userId, "owner", [toUser(aiko)])).toBe("byRole");
  });

  it("shows a household grant as everyone, which a member's page cannot change", () => {
    const access = libraryAccess(aiko.userId, "member", [
      { principal: { kind: "household" }, level: "view" },
    ]);

    expect(access).toBe("everyone");
    expect(accessChangeable(access)).toBe(false);
    expect(ACCESS_LABELS[access]).toBe("Everyone");
  });

  it("tells a member's own grant from none, a group's grant counting as none here", () => {
    expect(libraryAccess(aiko.userId, "member", [toUser(aiko)])).toBe("allowed");
    expect(libraryAccess(aiko.userId, "member", [toUser(mateo)])).toBe("notAllowed");
    expect(
      libraryAccess(aiko.userId, "member", [
        { principal: { kind: "group", groupId: groupId("g1"), name: "Kids" }, level: "view" },
      ]),
    ).toBe("notAllowed");
    expect(accessChangeable("allowed")).toBe(true);
    expect(ACCESS_LABELS.notAllowed).toBe("Not Allowed");
  });
});
