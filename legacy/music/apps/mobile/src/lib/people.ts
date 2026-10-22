/**
 * People and invites as the settings screens word them (F01, F08–F13, F21–F23): row subtitles,
 * the hub's counts, what each role may do, and why a person can't be managed.
 */
import type { AssignableRole, Invite, Person, Role } from "@music/commands/models";
import { can, roleLabel } from "@music/commands/permissions";
import type { PersonRef } from "@music/commands/permissions";

import type { Callout } from "./callout";
import { countOf } from "./format";
import { until } from "./when";

/** What people read a person as: their name, or their email when they have none. */
export const personName = (person: {
  readonly name: string | null;
  readonly email: string;
}): string => person.name ?? person.email;

/** The signed-in account's line in Settings (F01): `Server owner · lee@example.com`. */
export const accountLine = (me: { readonly role: Role; readonly email: string }): string =>
  `${me.role === "owner" ? "Server owner" : roleLabel(me.role)} · ${me.email}`;

/** A person row's subtitle (F09): `Owner · You`, `Admin`, `Member · Suspended`. */
export const personLine = (person: Person, meId: string): string =>
  [
    roleLabel(person.role),
    ...(person.id === meId ? ["You"] : []),
    ...(person.joinedViaJam ? ["Joined from a Jam"] : []),
    ...(person.suspended ? ["Suspended"] : []),
  ].join(" · ");

/** Invites that can still be used at `now`, newest first as the server lists them. */
export const openInvites = (invites: ReadonlyArray<Invite>, now: number): ReadonlyArray<Invite> =>
  invites.filter((invite) => invite.status === "open" && invite.expiresAt > now);

/** Who an invite is for: its email, or anyone holding the link. */
export const inviteTitle = (invite: Invite): string => invite.email ?? "Anyone with the link";

/** An invite row's subtitle (F09): `Member · Expires in 5 days`, or `Member · Expired`. */
export const inviteLine = (invite: Invite, now: number): string => {
  const left = until(invite.expiresAt, now);

  return `${roleLabel(invite.role)} · ${left === null ? "Expired" : `Expires ${left}`}`;
};

/** The role an invite gives, as a phrase: `Invited as a Member`, `Invited as an Admin`. */
export const invitedAs = (role: AssignableRole): string =>
  `Invited as ${role === "admin" ? "an" : "a"} ${roleLabel(role)}`;

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
  guest: {
    title: "Guest access",
    body: "Listen only to the libraries you add them to. No API keys or sharing.",
  },
};

/** The order Paper shows invite roles in (F10): the usual choice first. */
const INVITE_ORDER: ReadonlyArray<AssignableRole> = ["member", "admin", "guest"];

/** The roles to offer on an invite, from those the actor may give, in Paper's order. */
export const inviteRoles = (
  assignable: ReadonlyArray<AssignableRole>,
): ReadonlyArray<AssignableRole> => INVITE_ORDER.filter((role) => assignable.includes(role));

/** A person's role when it is one a role change can give; null for the owner. */
export const assignedRole = (role: Role): AssignableRole | null => (role === "owner" ? null : role);

/**
 * Why `actor` can't change `target` (F12), for the note that replaces the management rows. Call
 * it only when `canManagePerson` is false.
 */
export const manageNote = (
  actor: PersonRef,
  target: PersonRef & { readonly name: string },
): Callout => {
  if (actor.id === target.id) {
    return { title: "This is you", body: "Change your name and sign-in in Account." };
  }

  if (target.role === "owner") {
    return {
      title: "The server owner",
      body: "Nobody else can change the owner’s role or account.",
    };
  }

  if (target.role === "admin" && !can(actor.role, "owner")) {
    return {
      title: "Only the owner manages admins",
      body: `Ask the owner to change ${target.name}’s role or account.`,
    };
  }

  return { title: "Admins only", body: "Only an admin can manage people." };
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
