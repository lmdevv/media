/**
 * Who may do what. Every command names the capability it needs (`access` in the registry), and
 * the backend, the web app, the command menu, and the CLI all ask this module, so a rule changed
 * here changes everywhere at once.
 */
import type {
  AccessControl,
  AssignableRole,
  JamSettings,
  LibraryVisibility,
  PlaylistAccess,
  Role,
} from "./models";

/**
 * What a command needs from the caller's role:
 *
 * - `user`: anyone signed in, guests included: listen, and keep your own likes, history, and
 *   playlists.
 * - `keys`: create and revoke API keys for the CLI and agents. Not guests.
 * - `share`: see who else is on the server and share your playlists with them. Not guests, who
 *   only see what is shared with them.
 * - `admin`: run the server: people, invites, password reset links, libraries, and jobs.
 * - `owner`: hand the server to someone else.
 */
export type Capability = "user" | "keys" | "share" | "admin" | "owner";

const CAPABILITIES: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  owner: new Set(["user", "keys", "share", "admin", "owner"]),
  admin: new Set(["user", "keys", "share", "admin"]),
  member: new Set(["user", "keys", "share"]),
  guest: new Set(["user"]),
};

/** Whether `role` has `capability`. */
export const can = (role: Role, capability: Capability): boolean =>
  CAPABILITIES[role].has(capability);

/** Roles from least to most trusted. */
const RANK: Readonly<Record<Role, number>> = { guest: 0, member: 1, admin: 2, owner: 3 };

/** Every role an invite or a role change can give, most trusted first. */
const ASSIGNABLE: ReadonlyArray<AssignableRole> = ["admin", "member", "guest"];

/**
 * The roles `actor` may give through an invite or a role change: never `owner` (that takes a
 * transfer), and never a role above the actor's own. Empty for people who cannot manage others.
 */
export const assignableRoles = (actor: Role): ReadonlyArray<AssignableRole> =>
  can(actor, "admin") ? ASSIGNABLE.filter((role) => RANK[role] <= RANK[actor]) : [];

/** The parts of a person the rules below look at. */
export interface PersonRef {
  readonly id: string;
  readonly role: Role;
}

/**
 * Whether `actor` may change `target`'s role, suspend, reset, or remove them. Nobody changes their
 * own account this way, the owner is out of reach until they transfer ownership, and only the
 * owner manages admins.
 */
export const canManagePerson = (actor: PersonRef, target: PersonRef): boolean =>
  can(actor.role, "admin") &&
  actor.id !== target.id &&
  target.role !== "owner" &&
  // An admin who could reset or demote another admin could take over their private libraries.
  (target.role !== "admin" || can(actor.role, "owner"));

/**
 * Whether someone may rename, rescan, or remove a library: the server's owner may for every
 * library, and an admin only for libraries they can listen to. An admin who could remove a library
 * they can't hear could add its folder again as their own and index the same files.
 */
export const canManageLibrary = (role: Role, readable: boolean): boolean =>
  can(role, "owner") || (can(role, "admin") && readable);

/**
 * Whether `actor` may remove a library: its own owner, or the server's owner. Someone who removes
 * a library can add its folder back as their own, so an admin who only listens to it may not.
 */
export const canRemoveLibrary = (
  actor: PersonRef,
  library: { readonly ownerId: string },
): boolean =>
  can(actor.role, "owner") || (can(actor.role, "admin") && library.ownerId === actor.id);

/**
 * How `actor` may change who listens to a library (its visibility and its access list):
 *
 * - `full`: its own owner, while an admin. Only they let anyone in, so nobody can let themselves
 *   or others into a library that is not theirs.
 * - `narrow`: the server's owner, once the library's owner doesn't run libraries any more
 *   (demoted, suspended, or gone). They may take people out and make it more private, never let
 *   anyone in: the server's owner could otherwise demote an admin, let themselves into that
 *   admin's private library, and promote them again.
 * - `none`: everyone else.
 */
export const libraryAccessControl = (
  actor: PersonRef,
  library: {
    readonly ownerId: string;
    /** The library owner's role now; null when their account is gone. */
    readonly ownerRole: Role | null;
    readonly ownerSuspended: boolean;
  },
): AccessControl => {
  if (!can(actor.role, "admin")) return "none";

  if (library.ownerId === actor.id) return "full";

  const ownerRunsLibraries =
    library.ownerRole !== null && can(library.ownerRole, "admin") && !library.ownerSuspended;

  return can(actor.role, "owner") && !ownerRunsLibraries ? "narrow" : "none";
};

/** How many people a visibility lets in, least first. */
const REACH: Readonly<Record<LibraryVisibility, number>> = { private: 0, restricted: 1, shared: 2 };

/**
 * Whether going from `from` to `to` lets more people in: private to restricted or shared, or
 * restricted to shared. Restricted is narrower than shared, which also lets in everyone but
 * guests.
 */
export const widensVisibility = (from: LibraryVisibility, to: LibraryVisibility): boolean =>
  REACH[to] > REACH[from];

/** Whether `actor` may make `target` the owner: only the owner, and only to an admin. */
export const canTransferOwnership = (
  actor: PersonRef,
  target: PersonRef & { readonly suspended: boolean },
): boolean =>
  can(actor.role, "owner") &&
  actor.id !== target.id &&
  target.role === "admin" &&
  !target.suspended;

const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  user: "any user",
  keys: "members and admins; not guests",
  share: "members and admins; not guests",
  admin: "admins only",
  owner: "the owner only",
};

/** Who has a capability, for help text. */
export const capabilityLabel = (capability: Capability): string => CAPABILITY_LABELS[capability];

const FORBIDDEN_MESSAGES: Readonly<Record<Capability, string>> = {
  user: "Sign in first",
  keys: "Guests can't use API keys",
  share: "Guests can't share with other people",
  admin: "Only an admin can do that",
  owner: "Only the owner can do that",
};

/** The message for a caller who lacks `capability`. */
export const forbiddenMessage = (capability: Capability): string => FORBIDDEN_MESSAGES[capability];

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** A role as people read it. */
export const roleLabel = (role: Role): string => ROLE_LABELS[role];

/**
 * What someone may do with a playlist: change it (`owner`), add, remove, and reorder its songs
 * (`collaborator`), or view and play it (`viewer`). Only the owner renames, shares, or deletes it.
 */
const PLAYLIST_RANK: Readonly<Record<PlaylistAccess, number>> = {
  viewer: 0,
  collaborator: 1,
  owner: 2,
};

/** Whether `access` lets someone add, remove, and reorder a playlist's songs. */
export const canEditPlaylistItems = (access: PlaylistAccess): boolean =>
  PLAYLIST_RANK[access] >= PLAYLIST_RANK.collaborator;

/** Whether `access` lets someone rename, describe, share, or delete a playlist. */
export const canManagePlaylist = (access: PlaylistAccess): boolean => access === "owner";

/**
 * Whether someone in a Jam may play, pause, skip, and seek: the host always, others when the host
 * allows it.
 */
export const canControlJam = (settings: JamSettings, isHost: boolean): boolean =>
  isHost || settings.membersCanControl;

/**
 * Whether someone in a Jam may reorder or remove a queue entry: the host always; others any
 * entry, only their own, or none, as the host set.
 */
export const canEditJamEntry = (
  settings: JamSettings,
  isHost: boolean,
  addedByThem: boolean,
): boolean =>
  isHost || settings.membersCanEdit === "any" || (settings.membersCanEdit === "own" && addedByThem);

/**
 * How many more songs someone in a Jam may add, given how many upcoming songs they already have
 * queued: null for no limit (the host, or no limit set), 0 when adding is off.
 */
export const jamAddsLeft = (
  settings: JamSettings,
  isHost: boolean,
  upcoming: number,
): number | null => {
  if (isHost) return null;

  if (!settings.membersCanAdd) return 0;

  return settings.addLimit === null ? null : Math.max(0, settings.addLimit - upcoming);
};
