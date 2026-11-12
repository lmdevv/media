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
  it("follows grants whatever the role, since a library is private until shared", () => {
    expect(libraryAccess(mateo.userId, [])).toBe("notAllowed");
    expect(libraryAccess(mateo.userId, [toUser(mateo)])).toBe("allowed");
  });

  it("keeps a manager's grant and a household grant out of a person's page", () => {
    const manages = libraryAccess(lucia.userId, [
      { principal: { kind: "user", userId: lucia.userId, username: "lucia" }, level: "manage" },
      { principal: { kind: "household" }, level: "view" },
    ]);

    expect(manages).toBe("manages");
    expect(accessChangeable(manages)).toBe(false);

    const everyone = libraryAccess(aiko.userId, [
      { principal: { kind: "household" }, level: "view" },
    ]);

    expect(everyone).toBe("everyone");
    expect(accessChangeable(everyone)).toBe(false);
    expect(ACCESS_LABELS[everyone]).toBe("Everyone");
  });

  it("tells a person's own grant from none, a group's grant counting as none here", () => {
    expect(libraryAccess(aiko.userId, [toUser(aiko)])).toBe("allowed");
    expect(libraryAccess(aiko.userId, [toUser(mateo)])).toBe("notAllowed");
    expect(
      libraryAccess(aiko.userId, [
        { principal: { kind: "group", groupId: groupId("g1"), name: "Kids" }, level: "view" },
      ]),
    ).toBe("notAllowed");
    expect(accessChangeable("allowed")).toBe(true);
    expect(ACCESS_LABELS.notAllowed).toBe("Not Allowed");
  });
});
