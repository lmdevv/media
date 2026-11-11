import type { LibraryId, UserId } from "@media/contracts/ids";
import type { Invite, User } from "@media/contracts/models/account";
import type { LibraryDetail } from "@media/contracts/models/catalog";

/** How each role reads. */
export const ROLE_LABELS: Readonly<Record<User["role"], string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  service: "Media Service",
};

/** The people Users & Invites lists: everyone but the media service's own account. */
export const householdOf = (users: ReadonlyArray<User>): ReadonlyArray<User> =>
  users.filter((user) => user.role !== "service");

/** Whether `user`'s role and account can be changed by the admin signed in as `selfId`. */
export const canChange = (user: User, selfId: UserId | null): boolean =>
  user.id !== selfId && user.role !== "owner" && user.role !== "service";

/** A user's row detail: their role, or Disabled. */
export const userDetail = (user: User): string =>
  user.disabled ? "Disabled" : ROLE_LABELS[user.role];

/** The restricted libraries granted to `userId`. */
export const grantsOf = (
  userId: UserId,
  libraries: ReadonlyArray<LibraryDetail>,
): ReadonlyArray<LibraryId> =>
  libraries.flatMap((library) =>
    library.access === "restricted" && library.grantedUserIds.includes(userId) ? [library.id] : [],
  );

/** One library on a person's page: whether they see it, and whether that can change here. */
export interface AccessRow {
  readonly libraryId: LibraryId;
  readonly name: string;
  readonly allowed: boolean;
  /** Only members' restricted libraries can be granted or taken away. */
  readonly changeable: boolean;
  readonly detail: string;
}

/**
 * The Library Access rows of a person with `role`, and `granted` as the restricted libraries
 * chosen for them; both may differ from what is saved while editing.
 */
export const accessRows = (
  role: User["role"],
  libraries: ReadonlyArray<LibraryDetail>,
  granted: ReadonlyArray<LibraryId>,
): ReadonlyArray<AccessRow> =>
  libraries.map((library): AccessRow => {
    if (role !== "member") {
      return {
        libraryId: library.id,
        name: library.name,
        allowed: true,
        changeable: false,
        detail: "Allowed",
      };
    }

    if (library.access === "everyone") {
      return {
        libraryId: library.id,
        name: library.name,
        allowed: true,
        changeable: false,
        detail: "Everyone",
      };
    }

    const allowed = granted.includes(library.id);

    return {
      libraryId: library.id,
      name: library.name,
      allowed,
      changeable: true,
      detail: allowed ? "Allowed" : "Not Allowed",
    };
  });

/** Whether two grant lists hold the same libraries, in any order. */
export const sameGrants = (a: ReadonlyArray<LibraryId>, b: ReadonlyArray<LibraryId>): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

/** The invites still waiting to be used, as Pending Invites lists them. */
export const openInvites = (invites: ReadonlyArray<Invite>): ReadonlyArray<Invite> =>
  invites.filter((invite) => invite.state === "open");

/** `Expires in 7 days`, the line under Create Invite. */
export const expiryLine = (days: number): string =>
  days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
