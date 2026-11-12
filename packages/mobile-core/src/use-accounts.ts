/**
 * The users and invites screens' state on the core's accounts commands, for every [media] iOS app:
 * the household, the invites that still work, making and revoking an invite, a person's role, and
 * what they reach in each library. Each app draws them in its own look over `accounts.ts`.
 */
import { usePlatform } from "@media/sdk/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { INVITE_DAYS, inviteLink } from "./accounts";
import type {
  AssignableRole,
  GrantedLibrary,
  GroupId,
  HouseholdUser,
  LibraryGrant,
  PendingInvite,
  UserId,
} from "./accounts";
import { pagedStore, useAllPages, usePages } from "./pages";
import type { Paged, PageOpts, PagedQuery } from "./pages";

/** Everyone in the household by username, every page of them. */
export const useHousehold = (): Paged<HouseholdUser> => {
  const platform = usePlatform();

  return useAllPages(platform.core.accounts.users.list, (paginationOpts) => ({ paginationOpts }));
};

/** The invites that still work, latest to expire first, a page at a time. */
export const usePendingInvites = (): Paged<PendingInvite> => {
  const platform = usePlatform();

  return usePages(platform.core.accounts.invites.list, (paginationOpts) => ({ paginationOpts }));
};

/** An invite just made: the link to share, which carries its code, and when it stops working. */
export interface MadeInvite {
  readonly link: string;
  readonly expiresAt: number;
}

/**
 * Makes an invite for someone new with `role`, working for {@link INVITE_DAYS} days. The server
 * makes the code and answers it once; the link puts it after `#` on the account client at
 * `accountUrl`.
 */
export const useMakeInvite = (
  accountUrl: string,
): ((role: AssignableRole) => Promise<MadeInvite>) => {
  const platform = usePlatform();
  const create = platform.core.accounts.invites.create;

  return useCallback(
    async (role) => {
      const made = await create({ role, expiresInDays: INVITE_DAYS });

      return { link: inviteLink(accountUrl, made.code), expiresAt: made.expiresAt };
    },
    [create, accountUrl],
  );
};

/** Revokes an invite by its id, so its code stops working. */
export const useRevokeInvite = (): ((invite: PendingInvite) => Promise<void>) => {
  const platform = usePlatform();
  const revoke = platform.core.accounts.invites.revoke;

  return useCallback(
    async (invite) => {
      await revoke({ inviteId: invite.inviteId });
    },
    [revoke],
  );
};

/**
 * Saves a person's page: their new role first, then the libraries given to them and taken away.
 * A library is given at `view`, as old movies' library access let a member browse and play it.
 */
export const useSavePerson = (): ((change: {
  readonly userId: UserId;
  readonly role: AssignableRole | null;
  readonly give: ReadonlyArray<GrantedLibrary>;
  readonly takeAway: ReadonlyArray<GrantedLibrary>;
}) => Promise<void>) => {
  const platform = usePlatform();
  const { setRole } = platform.core.accounts.users;
  const { set, remove } = platform.core.permissions.grants;

  return useCallback(
    async ({ userId, role, give, takeAway }) => {
      if (role !== null) await setRole({ userId, role });

      const principal = { kind: "user", userId } as const;

      await Promise.all([
        ...give.map((id) => set({ resource: { type: "library", id }, principal, level: "view" })),
        ...takeAway.map((id) => remove({ resource: { type: "library", id }, principal })),
      ]);
    },
    [setRole, set, remove],
  );
};

interface ListsStore<Row> {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<Paged<Row>>;
}

/** One store over several paged lists; its snapshot changes only when one of theirs does. */
const listsStore = <Args, Row>(
  query: PagedQuery<Args, Row>,
  argsOf: ReadonlyArray<(paginationOpts: PageOpts) => Args>,
): ListsStore<Row> => {
  const stores = argsOf.map((argsAt) =>
    pagedStore<Row>((span) => query.watch(argsAt({ numItems: 50, ...span }))),
  );

  let snapshot: ReadonlyArray<Paged<Row>> = [];

  return {
    subscribe: (onChange) => {
      const stops = stores.map((store) => store.subscribe(onChange));

      return () => {
        for (const stop of stops) stop();
      };
    },
    getSnapshot: () => {
      const next = stores.map((store) => store.getSnapshot());

      if (next.length !== snapshot.length || next.some((paged, at) => paged !== snapshot[at])) {
        snapshot = next;
      }

      return snapshot;
    },
  };
};

/**
 * Follows every page of several lists of one paged query, one per key in `keys`, in the same
 * order. For the few lists a household has, such as each library's grants.
 */
const useEveryList = <Key extends string, Args, Row>(
  query: PagedQuery<Args, Row>,
  keys: ReadonlyArray<Key>,
  argsFor: (key: Key, paginationOpts: PageOpts) => Args,
): ReadonlyArray<Paged<Row>> => {
  const joined = keys.join(",");

  const open = () =>
    listsStore(
      query,
      keys.map((key) => (opts: PageOpts) => argsFor(key, opts)),
    );

  // State rather than a memo: React may drop a memo, which would restart every subscription.
  const [held, setHeld] = useState(() => ({ query, joined, store: open() }));
  let current = held;

  if (held.query !== query || held.joined !== joined) {
    current = { query, joined, store: open() };
    setHeld(current);
  }

  const { store } = current;
  const lists = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    for (const list of lists) {
      if (list.status === "ready" && list.next.kind === "more") list.next.load();
    }
  }, [lists]);

  return lists;
};

/**
 * Who each of `libraryIds` is shared with, every page, in the same order. A household shares a
 * few libraries with a few people, so following each list costs little. Listing a library's
 * grants needs `manage` on it, so pass the libraries the admin manages.
 */
export const useLibraryGrants = (
  libraryIds: ReadonlyArray<GrantedLibrary>,
): ReadonlyArray<Paged<LibraryGrant>> => {
  const platform = usePlatform();

  return useEveryList(platform.core.permissions.grants.list, libraryIds, (id, paginationOpts) => ({
    resource: { type: "library" as const, id },
    paginationOpts,
  }));
};

/** The groups a person is in, once every group's members are known. */
export type Memberships =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly retry: () => void }
  | { readonly status: "ready"; readonly groups: ReadonlySet<GroupId> };

const LOADING: Memberships = { status: "loading" };

const failure = <Row>(list: Paged<Row>): (() => void) | null => {
  if (list.status === "failed") return list.retry;

  return list.status === "ready" && list.next.kind === "failed" ? list.next.retry : null;
};

const loaded = <Row>(list: Paged<Row>): list is Extract<Paged<Row>, { status: "ready" }> =>
  list.status === "ready" && list.next.kind === "done";

/**
 * The groups `userId` is in, which a library shared with a group reaches them through. It reads
 * only this person's memberships (`core.permissions.groups.memberOf`), at most 16, never every
 * group's members.
 */
export const useMemberships = (userId: UserId): Memberships => {
  const platform = usePlatform();

  const joined = useAllPages(platform.core.permissions.groups.memberOf, (paginationOpts) => ({
    userId,
    paginationOpts,
  }));

  return useMemo((): Memberships => {
    const retry = failure(joined);

    if (retry !== null) return { status: "failed", retry };

    return loaded(joined)
      ? { status: "ready", groups: new Set(joined.rows.map((group) => group.groupId)) }
      : LOADING;
  }, [joined]);
};
