/**
 * Recently searched (A16), kept in the keychain per account, so another person signing in on
 * this phone, or the same person on another server, starts with their own list.
 */
import { useRead } from "@music/sdk/react";
import { useSyncExternalStore } from "react";

import { decodeRecents, encodeRecents, rememberRecent } from "@/lib/recent-searches";
import type { RecentItem } from "@/lib/recent-searches";
import { readValue, writeValue } from "@/lib/secure-storage";

const NONE: ReadonlyArray<RecentItem> = [];

const lists = new Map<string, ReadonlyArray<RecentItem>>();

const listeners = new Set<() => void>();

const keyOf = (userId: string): string => `music.recent-searches.${userId}`;

const listOf = (userId: string): ReadonlyArray<RecentItem> => {
  const cached = lists.get(userId);

  if (cached !== undefined) return cached;

  const stored = decodeRecents(readValue(keyOf(userId)));
  lists.set(userId, stored);

  return stored;
};

const save = (userId: string, list: ReadonlyArray<RecentItem>): void => {
  lists.set(userId, list);
  writeValue(keyOf(userId), list.length === 0 ? null : encodeRecents(list));

  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => listeners.delete(listener);
};

/** This account's recent searches, and how to add to or clear them. */
interface RecentSearches {
  readonly recents: ReadonlyArray<RecentItem>;
  readonly remember: (item: RecentItem) => void;
  readonly clear: () => void;
}

/** This account's recent searches, and how to add to or clear them. */
export const useRecentSearches = (): RecentSearches => {
  const me = useRead("account.me", {});
  const userId = me?.id ?? null;
  const recents = useSyncExternalStore(subscribe, () => (userId === null ? NONE : listOf(userId)));

  return {
    recents,
    remember: (item) => {
      if (userId !== null) save(userId, rememberRecent(listOf(userId), item));
    },
    clear: () => {
      if (userId !== null) save(userId, NONE);
    },
  };
};
