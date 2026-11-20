import type { PlatformSdk } from "@media/sdk/promise";
import { preloadFirstPage, useFirstRows } from "@media/ui/lib/pages";
import type { PageOpts, Paged } from "@media/ui/lib/pages";

import type { Track } from "@/lib/models";
import { PAGE_ROWS } from "@/lib/pages";
import { useMusic } from "@/lib/platform";

const LIKED_LIMIT = 5000;

/** The arguments of each page of liked songs, shared by the route loader and the hook. */
const likedPage = (paginationOpts: PageOpts) => ({ paginationOpts });

/** Preloads the first page `useLikedSongs` opens, for a route loader. */
export const preloadLikedSongs = (music: PlatformSdk["music"]): Promise<void> =>
  preloadFirstPage(music.likes.list, likedPage, PAGE_ROWS);

/** A page of the list that failed to load, and how to load it again. */
interface PageFailure {
  readonly message: string;
  readonly retry: () => void;
}

/** Every liked song the viewer can play, newest first, and whether all of them have loaded. */
export interface LikedSongs<Song = Track> {
  readonly tracks: ReadonlyArray<Song>;
  readonly done: boolean;
  /** The next page failed to load, so the list stops short until it is loaded again. */
  readonly failed: PageFailure | null;
}

/**
 * The liked songs a list's pages hold so far: undefined until the first page arrives, and a
 * later page's failure with its retry. A failed first page throws, like `useRead`.
 */
export const likedSongsOf = <Song>(paged: Paged<Song>): LikedSongs<Song> | undefined => {
  if (paged.status === "loading") return undefined;

  if (paged.status === "failed") throw new Error(paged.message);

  const { next } = paged;

  return {
    tracks: paged.rows.slice(0, LIKED_LIMIT),
    done: next.kind === "done" || paged.rows.length >= LIKED_LIMIT,
    failed: next.kind === "failed" ? { message: next.message, retry: next.retry } : null,
  };
};

/**
 * Follows the liked songs page by page, loading each next page as soon as the one before it
 * arrives, until it holds `LIKED_LIMIT` songs. Each page is its own subscription, pinned where the next one
 * starts, so a song liked while the list is open lands in the first page.
 */
export const useLikedSongs = (): LikedSongs | undefined => {
  const music = useMusic();

  return likedSongsOf(useFirstRows(music.likes.list, likedPage, LIKED_LIMIT, PAGE_ROWS));
};
