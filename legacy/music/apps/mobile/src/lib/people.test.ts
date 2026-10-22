import { InviteId, UserId } from "@music/commands/ids";
import type { Invite, Person } from "@music/commands/models";
import { assignableRoles } from "@music/commands/permissions";
import { describe, expect, it } from "vitest";

import {
  accountLine,
  assignedRole,
  inviteLine,
  inviteRoles,
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

const person = (fields: Partial<Person> = {}): Person => ({
  id: UserId.make("sam"),
  email: "sam@example.com",
  name: "Sam",
  role: "admin",
  suspended: false,
  createdAt: now - DAY,
  lastActiveAt: null,
  joinedViaJam: false,
  ...fields,
});

const invite = (fields: Partial<Invite> = {}): Invite => ({
  id: InviteId.make("invite"),
  code: "abc123",
  email: "morgan@example.com",
  role: "member",
  status: "open",
  createdAt: now - 2 * DAY,
  expiresAt: now + 5 * DAY,
  acceptedAt: null,
  ...fields,
});

describe("personName", () => {
  it("falls back to the email when someone has no name", () => {
    expect(personName(person())).toBe("Sam");
    expect(personName(person({ name: null }))).toBe("sam@example.com");
  });
});

describe("personLine", () => {
  it("says the role, and marks yourself as F09 does", () => {
    const lee = person({ id: UserId.make("lee"), role: "owner" });

    expect(personLine(lee, "lee")).toBe("Owner · You");
    expect(personLine(person(), "lee")).toBe("Admin");
  });

  it("adds a suspension and a Jam sign-up", () => {
    expect(personLine(person({ role: "member", suspended: true }), "lee")).toBe(
      "Member · Suspended",
    );
    expect(personLine(person({ role: "guest", joinedViaJam: true }), "lee")).toBe(
      "Guest · Joined from a Jam",
    );
  });
});

describe("invites", () => {
  it("keeps only invites that still work", () => {
    const open = invite();
    const lapsed = invite({ id: InviteId.make("lapsed"), expiresAt: now - 1 });
    const expired = invite({ id: InviteId.make("expired"), status: "expired" });

    expect(openInvites([open, lapsed, expired], now)).toEqual([open]);
  });

  it("words an invite's row as F09 does", () => {
    expect(inviteTitle(invite())).toBe("morgan@example.com");
    expect(inviteTitle(invite({ email: null }))).toBe("Anyone with the link");
    expect(inviteLine(invite(), now)).toBe("Member · Expires in 5 days");
    expect(inviteLine(invite({ expiresAt: now - 1 }), now)).toBe("Member · Expired");
  });

  it("names the role with its article", () => {
    expect(invitedAs("member")).toBe("Invited as a Member");
    expect(invitedAs("admin")).toBe("Invited as an Admin");
  });

  it("offers the roles the actor may give, Member first", () => {
    expect(inviteRoles(assignableRoles("owner"))).toEqual(["member", "admin", "guest"]);
    expect(inviteRoles(assignableRoles("member"))).toEqual([]);
  });
});

describe("peopleSummary", () => {
  it("counts people and pending invites as the hub does", () => {
    expect(peopleSummary(4, 1)).toBe("4 people · 1 pending invite");
    expect(peopleSummary(1, 0)).toBe("1 person · 0 pending invites");
  });
});

describe("assignedRole", () => {
  it("is null for the owner, whose role only moves by transfer", () => {
    expect(assignedRole("owner")).toBeNull();
    expect(assignedRole("guest")).toBe("guest");
  });
});

describe("manageNote", () => {
  const owner = { id: "lee", role: "owner" } as const;
  const admin = { id: "ana", role: "admin" } as const;

  it("explains each reason a person can't be managed", () => {
    expect(manageNote(admin, { ...admin, name: "Ana" }).title).toBe("This is you");
    expect(manageNote(admin, { ...owner, name: "Lee" }).title).toBe("The server owner");
    expect(manageNote(admin, { id: "sam", role: "admin", name: "Sam" })).toEqual({
      title: "Only the owner manages admins",
      body: "Ask the owner to change Sam’s role or account.",
    });
  });
});

describe("joinNames", () => {
  it("joins names as a sentence", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Sam"])).toBe("Sam");
    expect(joinNames(["Sam", "Alex"])).toBe("Sam and Alex");
    expect(joinNames(["Sam", "Alex", "Riley"])).toBe("Sam, Alex, and Riley");
    expect(joinNames(["Sam", "Alex", "Riley", "Casey", "Jo"])).toBe("Sam, Alex, and 3 others");
  });
});

describe("accountLine", () => {
  it("names the owner as Paper's Settings row does, and other roles by label", () => {
    expect(accountLine({ role: "owner", email: "lee@example.com" })).toBe(
      "Server owner · lee@example.com",
    );
    expect(accountLine({ role: "member", email: "alex@example.com" })).toBe(
      "Member · alex@example.com",
    );
  });
});
