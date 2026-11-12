/**
 * The users and invites screens every [media] iOS app has, as data: who is in the household, what
 * each role reads as, who may change whose role, what a person reaches in each library, and the
 * invite link an admin shares. Each app draws these in its own look; `use-accounts.ts` follows the
 * core's accounts commands for them.
 */
import type { PlatformSdk } from "@media/sdk/promise";

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

/** What a person reaches in one library, on their page. */
export type LibraryAccess =
  /** Admins and the owner, whose role reaches every library they are shared. */
  | "byRole"
  /** The library is shared with the whole household. */
  | "everyone"
  /** The library is shared with this person. */
  | "allowed"
  /** The library is not shared with this person, or reaches them only through a group. */
  | "notAllowed";

/**
 * What a person with `role` reaches in a library shared as `grants`. A member's own grant can be
 * given or taken away here; a household grant reaches them whatever it says.
 */
export const libraryAccess = (
  userId: UserId,
  role: Role,
  grants: ReadonlyArray<LibraryGrant>,
): LibraryAccess => {
  if (role !== "member") return "byRole";

  if (grants.some((grant) => grant.principal.kind === "household")) return "everyone";

  return grants.some(
    (grant) => grant.principal.kind === "user" && grant.principal.userId === userId,
  )
    ? "allowed"
    : "notAllowed";
};

/** How a library's access reads on a person's page. */
export const ACCESS_LABELS: Readonly<Record<LibraryAccess, string>> = {
  byRole: "Allowed",
  everyone: "Everyone",
  allowed: "Allowed",
  notAllowed: "Not Allowed",
};

/** Whether a library's access can be given or taken away on a person's page. */
export const accessChangeable = (access: LibraryAccess): boolean =>
  access === "allowed" || access === "notAllowed";
