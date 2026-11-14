import { useAllPages } from "@media/mobile-core/pages";

import { usePlatform } from "@media/sdk/react";

import type { DirectoryPerson, Playlist, UserId } from "@/lib/models";
import { useMusic } from "@/lib/platform";

/** Playlists asked for per page; a person's playlists stay few. */
const PAGE_ROWS = 200;

/**
 * Every row of one of your playlist lists once all its pages arrived, else undefined. A failed
 * page throws to the route's error screen, as old music's `playlists.list` read did.
 */
const useWhole = (which: "list" | "shared"): ReadonlyArray<Playlist> | undefined => {
  const music = useMusic();
  const query = which === "list" ? music.playlists.list : music.playlists.shared;
  const paged = useAllPages(query, (paginationOpts) => ({ paginationOpts }), PAGE_ROWS);

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.next.kind === "failed") throw new Error(paged.next.message);

  return paged.next.kind === "done" ? paged.rows : undefined;
};

/** Your playlists, most recently changed first; undefined while they load. */
export const useMyPlaylists = (): ReadonlyArray<Playlist> | undefined => useWhole("list");

/** Playlists other people shared with you by name; undefined while they load. */
export const useSharedPlaylists = (): ReadonlyArray<Playlist> | undefined => useWhole("shared");

/** Someone on this server you may share a playlist with. */
export interface DirectoryEntry {
  readonly id: UserId;
  readonly name: string;
  readonly role: DirectoryPerson["role"];
}

/**
 * The other people on this server you may share with, by name, from
 * `core.accounts.directory.list`, as old music's `people.directory` listed them; undefined while
 * they load. A household stays small, so the list is read whole.
 */
export const usePeopleDirectory = (): ReadonlyArray<DirectoryEntry> | undefined => {
  const core = usePlatform().core;

  const paged = useAllPages(
    core.accounts.directory.list,
    (paginationOpts) => ({ paginationOpts }),
    PAGE_ROWS,
  );

  if (paged.status === "failed") throw new Error(paged.message);

  if (paged.status !== "ready") return undefined;

  if (paged.next.kind === "failed") throw new Error(paged.next.message);

  if (paged.next.kind !== "done") return undefined;

  return paged.rows
    .map((row) => ({ id: row.userId, name: row.name, role: row.role }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
};
