import type { HouseholdUser, PendingInvite } from "@media/mobile-core/accounts";
import { useAllPages, useFirstRows } from "@media/mobile-core/pages";
import type { Paged } from "@media/mobile-core/pages";
import { useHousehold } from "@media/mobile-core/use-accounts";
import { usePlatform } from "@media/sdk/react";

import type { InviteId, LibraryId, UserId } from "@/lib/ids";
import type { Row } from "@/lib/models";
import { useCore } from "@/lib/platform";
import { useMusicLibraries } from "@/lib/use-libraries";
import type { LibraryView } from "@/lib/first-scan";
import type { Job } from "@/lib/jobs";

/** A list's rows once every page arrived, else undefined; a failed page throws to the route's error. */
const wholeOf = <A>(paged: Paged<A>): ReadonlyArray<A> | undefined => {
  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.next.kind === "failed") throw new Error(paged.next.message);

  return paged.next.kind === "done" ? paged.rows : undefined;
};

/** Everyone in the household, by username; undefined while they load. */
export const usePeople = (): ReadonlyArray<HouseholdUser> | undefined => wholeOf(useHousehold());

/** Invites asked for per page; a household keeps few. */
const INVITE_ROWS = 100;

/** The invites that still work, latest to expire first; undefined while they load. */
export const useInvites = (): ReadonlyArray<PendingInvite> | undefined => {
  const platform = usePlatform();

  return wholeOf(
    useAllPages(
      platform.core.accounts.invites.list,
      (paginationOpts) => ({ paginationOpts }),
      INVITE_ROWS,
    ),
  );
};

/** Someone in the household; null when they are not, undefined while it loads. */
export const usePerson = (id: UserId | null): HouseholdUser | null | undefined => {
  const people = usePeople();

  return people === undefined ? undefined : (people.find((person) => person.userId === id) ?? null);
};

/** An invite that still works; null when it does not, undefined while it loads. */
export const useInvite = (id: InviteId | null): PendingInvite | null | undefined => {
  const invites = useInvites();

  return invites === undefined
    ? undefined
    : (invites.find((invite) => invite.inviteId === id) ?? null);
};

/** The music libraries shared with you that you manage, with their latest scans. */
export const useManagedLibraries = (): ReadonlyArray<LibraryView> | undefined =>
  useMusicLibraries()?.filter((library) => library.level === "manage");

/** A music library you may see; null when it is gone, undefined while it loads. */
export const useLibrary = (id: LibraryId | null): LibraryView | null | undefined => {
  const libraries = useMusicLibraries();

  return libraries === undefined
    ? undefined
    : (libraries.find((library) => library.libraryId === id) ?? null);
};

export type { Job };

/** Jobs asked for per page: enough to show what runs now and the latest finished. */
const JOB_ROWS = 100;

/**
 * The server's latest jobs of every kind, newest first, at most a page of them, as old music's
 * `jobs.list` showed the latest; undefined while they load.
 */
export const useJobs = (): ReadonlyArray<Job> | undefined => {
  const core = useCore();

  const paged = useFirstRows(
    core.jobs.list,
    (paginationOpts) => ({ paginationOpts }),
    JOB_ROWS,
    JOB_ROWS,
  );

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  return paged.rows.slice(0, JOB_ROWS);
};

/** One grant on a library, as `core.permissions.grants.list` lists it. */
export type LibraryGrant = Row<ReturnType<typeof useCore>["permissions"]["grants"]["list"]>;

/** Grants asked for per page; a household keeps few. */
const GRANT_ROWS = 100;

/** Who a library you manage is shared with; undefined while that loads. */
export const useLibraryGrants = (libraryId: LibraryId): ReadonlyArray<LibraryGrant> | undefined => {
  const core = useCore();

  return wholeOf(
    useAllPages(
      core.permissions.grants.list,
      (paginationOpts) => ({
        resource: { type: "library" as const, id: libraryId },
        paginationOpts,
      }),
      GRANT_ROWS,
    ),
  );
};

/** Whether a library's grants share it with the whole household. */
export const sharedWithEveryone = (grants: ReadonlyArray<LibraryGrant>): boolean =>
  grants.some((grant) => grant.principal.kind === "household");
