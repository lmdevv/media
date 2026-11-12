/**
 * The users and invites screens every [media] iOS app has, as data: who is in the household, what
 * each role reads as, who may change whose role, what a person reaches in each library, and the
 * invite link an admin shares. Each app draws these in its own look; `use-accounts.ts` follows the
 * core's accounts commands for them.
 */
import type { PlatformSdk } from "@media/sdk/promise";

import { fieldEdit } from "./edits";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

type RowOf<Method> =
  Result<Method> extends { readonly page: ReadonlyArray<infer Row> } ? Row : never;

type Accounts = PlatformSdk["core"]["accounts"];

type Grants = PlatformSdk["core"]["permissions"]["grants"];

/** A person in the household, as `core.accounts.users.list` lists them. */
export type HouseholdUser = RowOf<Accounts["users"]["list"]>;

/** A person's id on the core. */
export type UserId = HouseholdUser["userId"];

/** A person's role. */
export type Role = HouseholdUser["role"];

/** A role an admin may give: admin or member. */
export type AssignableRole = Parameters<Accounts["users"]["setRole"]>[0]["role"];

/** An invite that still works, as `core.accounts.invites.list` lists it. */
export type PendingInvite = RowOf<Accounts["invites"]["list"]>;

/** One grant on a library, as `core.permissions.grants.list` lists it. */
export type LibraryGrant = RowOf<Grants["list"]>;

/** How each role reads. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** The roles an admin chooses between, for an invite or someone's role. */
export const ROLE_CHOICES: ReadonlyArray<AssignableRole> = ["member", "admin"];

/** Whether `role` is one an admin may give, so the person's role can change. */
const isAssignable = (role: Role): role is AssignableRole =>
  ROLE_CHOICES.some((choice) => choice === role);

/**
 * Whether the admin signed in as `selfId` may change `user`'s role: never their own, and never
 * the owner's, which only a handover moves.
 */
export const canChangeRole = (user: HouseholdUser, selfId: UserId): boolean =>
  user.userId !== selfId && isAssignable(user.role);

/** How many days a new invite works. */
export const INVITE_DAYS = 7;

/** `Expires in 7 days`, the line under Create Invite. */
export const expiryLine = (days: number): string =>
  days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;

/**
 * The account client's address, the server's base, from the movies client's: the server serves
 * the movies client at `<base>/movies` and the account client at `<base>` (ADR 0020).
 */
export const accountUrlOf = (moviesUrl: string): string =>
  moviesUrl.replace(/\/+$/u, "").replace(/\/movies$/u, "");

/**
 * The link an invite code opens: the account client's `/invite` with the code after `#`, so no
 * request carries it (ADR 0020). The code reaches only this link and the person it is shared with.
 */
export const inviteLink = (accountUrl: string, code: string): string =>
  `${accountUrl.replace(/\/+$/u, "")}/invite#${code}`;

/** A grant's level on a library: view, edit, or manage. */
export type Level = LibraryGrant["level"];

/** A group's id on the core, as a grant names it. */
export type GroupId = Extract<LibraryGrant["principal"], { readonly kind: "group" }>["groupId"];

/**
 * A person's own grant on a library at its level, which their page gives or takes away. A core
 * library is private to whoever made it until it is shared, admins included (ADR 0024), so this
 * follows grants, not roles. A grant to manage is the maker's, and stays. The level is kept, not
 * folded into "allowed", so a page notices when another admin raises a grant to edit meanwhile.
 */
export type DirectGrant = "manages" | "edit" | "view" | "none";

/** Access that reaches a person through a group they are in, or the whole household. */
export interface Inherited {
  readonly level: Level;
  /** The group's name, or `Everyone` for the household. */
  readonly through: string;
}

/** What a person reaches in one library: their own grant, and the strongest one they inherit. */
export interface LibraryAccess {
  readonly direct: DirectGrant;
  readonly inherited: Inherited | null;
}

const LEVEL_ORDER: ReadonlyArray<Level> = ["view", "edit", "manage"];

const LEVEL_LABELS: Readonly<Record<Level, string>> = {
  view: "View",
  edit: "Edit",
  manage: "Manage",
};

/**
 * What `userId`, a member of `groups`, reaches in a library shared as `grants`, the way the
 * core's `levelOn` reads them: their own grant, and through the household and their groups.
 */
export const libraryAccess = (
  userId: UserId,
  grants: ReadonlyArray<LibraryGrant>,
  groups: ReadonlySet<GroupId>,
): LibraryAccess => {
  let direct: DirectGrant = "none";
  let inherited: Inherited | null = null;

  for (const { principal, level } of grants) {
    if (principal.kind === "user") {
      if (principal.userId === userId) direct = level === "manage" ? "manages" : level;

      continue;
    }

    const through = principal.kind === "household" ? "Everyone" : principal.name;
    const reaches = principal.kind === "household" || groups.has(principal.groupId);

    if (
      reaches &&
      (inherited === null || LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(inherited.level))
    ) {
      inherited = { level, through };
    }
  }

  return { direct, inherited };
};

/**
 * How a library's access reads on a person's page with their own grant `direct`: `Manages`,
 * `Allowed`, what they inherit such as `View, through Family`, or `Not Allowed`. Taking their own
 * grant away never reads as Not Allowed while a group or the household still reaches them.
 */
export const accessLabel = (direct: DirectGrant, inherited: Inherited | null): string => {
  if (direct === "manages") return "Manages";

  if (direct !== "none") return "Allowed";

  return inherited === null
    ? "Not Allowed"
    : `${LEVEL_LABELS[inherited.level]}, through ${inherited.through}`;
};

/** A person's own grant that their page can give or take away: not the maker's grant to manage. */
export type ChangeableGrant = Exclude<DirectGrant, "manages">;

/** Whether a person's own grant can be given or taken away on their page. */
export const isChangeable = (direct: DirectGrant): direct is ChangeableGrant =>
  direct !== "manages";

/**
 * What tapping a library on a person's page sets their own grant to: none when they hold one,
 * else back to the grant they held when the person began editing it, or `view` when they held
 * none. Putting a grant back as it was is no change, so an edit grant never becomes view.
 */
export const toggledGrant = (shown: ChangeableGrant, from: ChangeableGrant): ChangeableGrant => {
  if (shown !== "none") return "none";

  return from === "none" ? "view" : from;
};

/** A change the person made on someone's page, from what the field held when they made it. */
export interface PageEdit<V> {
  readonly from: V;
  readonly to: V;
}

/** What saving a person's page writes, and the fields it would write over a change meanwhile. */
export interface PersonSave {
  readonly role: AssignableRole | null;
  readonly give: ReadonlyArray<GrantedLibrary>;
  readonly takeAway: ReadonlyArray<GrantedLibrary>;
  readonly overtaken: ReadonlyArray<string>;
}

/** A library's id on the core, as a grant names it. */
export type GrantedLibrary = Parameters<Grants["set"]>[0]["resource"]["id"];

/**
 * The save of a person's page. `role` and each of `libraries` hold the person's change and the
 * value the field had when they made it; `liveRole` and `liveDirect` are the core's values now.
 * Only fields the person changed are written, so saving library access never writes back a role
 * another admin changed meanwhile. A library whose grant can no longer be changed here, or whose
 * access is not loaded, is left alone.
 */
export const personSave = (
  role: PageEdit<Role> | null,
  liveRole: Role,
  libraries: ReadonlyArray<{
    readonly libraryId: GrantedLibrary;
    readonly name: string;
    readonly edit: PageEdit<ChangeableGrant>;
    readonly live: DirectGrant | null;
  }>,
): PersonSave => {
  const roleEdit = role === null ? null : fieldEdit<Role>(role.from, role.to, liveRole);
  const roleTo = roleEdit?.kind === "edited" ? roleEdit.to : null;
  const assignable = roleTo !== null && isAssignable(roleTo) ? roleTo : null;
  const give: Array<GrantedLibrary> = [];
  const takeAway: Array<GrantedLibrary> = [];

  const overtaken: Array<string> =
    roleEdit?.kind === "edited" && roleEdit.overtaken ? ["Role"] : [];

  for (const { libraryId, name, edit, live } of libraries) {
    if (live === null || !isChangeable(live)) continue;

    const grant = fieldEdit<ChangeableGrant>(edit.from, edit.to, live);

    if (grant.kind !== "edited") continue;

    if (grant.overtaken) overtaken.push(name);

    (grant.to === "none" ? takeAway : give).push(libraryId);
  }

  return { role: assignable, give, takeAway, overtaken };
};
