import { ROLE_LABELS } from "@media/mobile-core/accounts";
import type {
  AssignableRole,
  HouseholdUser,
  PendingInvite,
  Role,
} from "@media/mobile-core/accounts";

import type { Callout } from "./callout";
import { countOf } from "./format";
import { until } from "./when";

export const personName = (person: {
  readonly displayName: string | null;
  readonly username: string;
}): string => person.displayName ?? person.username;

/** The signed-in account's line in Settings (F01): `Server owner · aiko`. */
export const accountLine = (me: { readonly role: Role; readonly username: string }): string =>
  `${me.role === "owner" ? "Server owner" : ROLE_LABELS[me.role]} · ${me.username}`;

/** A person row's subtitle (F09): `Owner · You`, `Admin`, `Member`. */
export const personLine = (person: HouseholdUser, meId: string): string =>
  [ROLE_LABELS[person.role], ...(person.userId === meId ? ["You"] : [])].join(" · ");

export const openInvites = (
  invites: ReadonlyArray<PendingInvite>,
  now: number,
): ReadonlyArray<PendingInvite> => invites.filter((invite) => invite.expiresAt > now);

export const inviteTitle = (invite: Pick<PendingInvite, "invitedBy">): string =>
  `From ${invite.invitedBy}`;

/** An invite row's subtitle (F09): `Member · Expires in 5 days`, or `Member · Expired`. */
export const inviteLine = (
  invite: Pick<PendingInvite, "role" | "expiresAt">,
  now: number,
): string => {
  const left = until(invite.expiresAt, now);

  return `${ROLE_LABELS[invite.role]} · ${left === null ? "Expired" : `Expires ${left}`}`;
};

/** The role an invite gives, as a phrase: `Invited as a Member`, `Invited as an Admin`. */
export const invitedAs = (role: AssignableRole): string =>
  `Invited as ${role === "admin" ? "an" : "a"} ${ROLE_LABELS[role]}`;

/** The hub's People row (F08): `4 people · 1 pending invite`. */
export const peopleSummary = (people: number, pendingInvites: number): string =>
  `${countOf(people, "person", "people")} · ${countOf(pendingInvites, "pending invite")}`;

/** What each role may do, for the callout under the role chips (F10). */
export const ROLE_ACCESS: Readonly<Record<AssignableRole, Callout>> = {
  member: {
    title: "Member access",
    body: "Listen to shared libraries and manage personal playlists and likes.",
  },
  admin: {
    title: "Admin access",
    body: "Everything a member can do, plus people, invites, libraries, and scans.",
  },
};

/** The roles to offer on an invite or a role change, in Paper's order. */
export const ROLE_OPTIONS: ReadonlyArray<AssignableRole> = ["member", "admin"];

export const assignedRole = (role: Role): AssignableRole | null =>
  role === "member" || role === "admin" ? role : null;

/**
 * Why the signed-in admin can't change `target` (F12), for the note that replaces the management
 * rows; null when they can. Nobody changes their own account here, and only a handover moves the
 * owner (ADR 0005).
 */
export const manageNote = (meId: string, target: HouseholdUser): Callout | null => {
  if (target.userId === meId) {
    return { title: "This is you", body: "Change your name in Account." };
  }

  if (target.role === "owner") {
    return {
      title: "The server owner",
      body: "Nobody else can change the owner’s role or account.",
    };
  }

  return null;
};

/** Names in a sentence: `Sam`, `Sam and Alex`, `Sam, Alex, and Riley`, `Sam, Alex, and 3 others`. */
export const joinNames = (names: ReadonlyArray<string>): string => {
  const [first, second, third] = names;

  if (first === undefined) return "";

  if (second === undefined) return first;

  if (third === undefined) return `${first} and ${second}`;

  if (names.length === 3) return `${first}, ${second}, and ${third}`;

  return `${first}, ${second}, and ${countOf(names.length - 2, "other")}`;
};
