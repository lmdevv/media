import type { HouseholdUser, PendingInvite } from "@media/mobile-core/accounts";
import { describe, expect, it } from "vitest";

import { InviteId, UserId } from "./ids";
import {
  accountLine,
  assignedRole,
  inviteLine,
  inviteTitle,
  invitedAs,
  joinNames,
  manageNote,
  openInvites,
  peopleSummary,
  personLine,
  personName,
} from "./people";

const now = new Date(2026, 9, 22, 15, 0).getTime();

const DAY = 24 * 60 * 60_000;

const person = (fields: Partial<HouseholdUser> = {}): HouseholdUser => ({
  userId: UserId.make("sam"),
  username: "sam",
  displayName: "Sam",
  role: "admin",
  ...fields,
});

const invite = (fields: Partial<PendingInvite> = {}): PendingInvite => ({
  inviteId: InviteId.make("invite"),
  role: "member",
  invitedBy: "lucia",
  expiresAt: now + 5 * DAY,
  ...fields,
});

describe("names and lines", () => {
  it("names a person by the name they go by, else their username", () => {
    expect(personName(person())).toBe("Sam");
    expect(personName(person({ displayName: null }))).toBe("sam");
  });

  it("reads the signed-in account's role and username", () => {
    expect(accountLine({ role: "owner", username: "lucia" })).toBe("Server owner · lucia");
    expect(accountLine({ role: "member", username: "aiko" })).toBe("Member · aiko");
  });

  it("marks the signed-in person among the household", () => {
    expect(personLine(person(), "sam")).toBe("Admin · You");
    expect(personLine(person({ role: "member" }), "lucia")).toBe("Member");
  });
});

describe("invites", () => {
  it("keeps only the ones that still work", () => {
    expect(openInvites([invite(), invite({ expiresAt: now - 1 })], now)).toHaveLength(1);
  });

  it("names who made one and what it gives", () => {
    expect(inviteTitle(invite())).toBe("From lucia");
    expect(inviteLine(invite(), now)).toBe("Member · Expires in 5 days");
    expect(inviteLine(invite({ expiresAt: now - 1 }), now)).toBe("Member · Expired");
    expect(invitedAs("admin")).toBe("Invited as an Admin");
    expect(invitedAs("member")).toBe("Invited as a Member");
  });

  it("sums the household and its pending invites for the hub", () => {
    expect(peopleSummary(4, 1)).toBe("4 people · 1 pending invite");
    expect(peopleSummary(1, 0)).toBe("1 person · 0 pending invites");
  });
});

describe("managing someone", () => {
  it("gives a role change only for a member or an admin", () => {
    expect(assignedRole("member")).toBe("member");
    expect(assignedRole("admin")).toBe("admin");
    expect(assignedRole("owner")).toBeNull();
    expect(assignedRole("guest")).toBeNull();
  });

  it("explains why yourself and the owner are out of reach, and nothing otherwise", () => {
    expect(manageNote("sam", person())?.title).toBe("This is you");
    expect(manageNote("lucia", person({ userId: UserId.make("o"), role: "owner" }))?.title).toBe(
      "The server owner",
    );
    expect(manageNote("lucia", person())).toBeNull();
  });

  it("joins names as a sentence", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Sam"])).toBe("Sam");
    expect(joinNames(["Sam", "Alex"])).toBe("Sam and Alex");
    expect(joinNames(["Sam", "Alex", "Riley"])).toBe("Sam, Alex, and Riley");
    expect(joinNames(["Sam", "Alex", "Riley", "Kai", "Noa"])).toBe("Sam, Alex, and 3 others");
  });
});
