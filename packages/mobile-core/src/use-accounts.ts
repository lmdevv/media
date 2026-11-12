/**
 * The users and invites screens' state on the core's accounts commands, for every [media] iOS app:
 * the household, the invites that still work, making and revoking an invite, a person's role, and
 * what they reach in each library. Each app draws them in its own look over `accounts.ts`.
 */
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { INVITE_DAYS, inviteLink } from "./accounts";
import type {
  AssignableRole,
  HouseholdUser,
  LibraryGrant,
  PendingInvite,
  UserId,
} from "./accounts";
import { pagedStore, useAllPages, usePages } from "./pages";
import type { Paged } from "./pages";

type Grants = PlatformSdk["core"]["permissions"]["grants"];

/** A library's id on the core, as a grant names it. */
export type GrantedLibraryId = Parameters<Grants["list"]>[0]["resource"]["id"];

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
  readonly give: ReadonlyArray<GrantedLibraryId>;
  readonly takeAway: ReadonlyArray<GrantedLibraryId>;
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

interface GrantsStore {
  readonly subscribe: (onChange: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<Paged<LibraryGrant>>;
}

/** One store over several libraries' grant lists; its snapshot changes only when one of theirs does. */
const grantsStore = (grants: Grants, libraryIds: ReadonlyArray<GrantedLibraryId>): GrantsStore => {
  const stores = libraryIds.map((id) =>
    pagedStore<LibraryGrant>((span) =>
      grants.list.watch({
        resource: { type: "library", id },
        paginationOpts: { numItems: 50, ...span },
      }),
    ),
  );

  let snapshot: ReadonlyArray<Paged<LibraryGrant>> = [];

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
 * Who each of `libraryIds` is shared with, every page, in the same order. A household shares a
 * few libraries with a few people, so following each list costs little. Listing a library's
 * grants needs `manage` on it, so pass the libraries the admin manages.
 */
export const useLibraryGrants = (
  libraryIds: ReadonlyArray<GrantedLibraryId>,
): ReadonlyArray<Paged<LibraryGrant>> => {
  const platform = usePlatform();
  const grants = platform.core.permissions.grants;
  const key = libraryIds.join(",");

  // State rather than a memo: React may drop a memo, which would restart every subscription.
  const [held, setHeld] = useState(() => ({ grants, key, store: grantsStore(grants, libraryIds) }));
  let current = held;

  if (held.grants !== grants || held.key !== key) {
    current = { grants, key, store: grantsStore(grants, libraryIds) };
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
