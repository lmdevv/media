import { useFirstRows } from "@media/ui/lib/pages";

import type { Track } from "@/lib/models";
import { PAGE_ROWS } from "@/lib/pages";
import { useMusic } from "@/lib/platform";

const LIKED_LIMIT = 5000;

/** Every liked song the viewer can play, newest first, and whether all of them have loaded. */
export interface LikedSongs {
  readonly tracks: ReadonlyArray<Track>;
  readonly done: boolean;
}

/**
 * Follows the liked songs page by page, loading each next page as soon as the one before it
 * arrives, until it holds `LIKED_LIMIT` songs. Each page is its own subscription, pinned where the next one
 * starts, so a song liked while the list is open lands in the first page. Returns undefined until
 * the first page arrives; throws a page's error, like `useRead`.
 */
export const useLikedSongs = (): LikedSongs | undefined => {
  const music = useMusic();

  const paged = useFirstRows(
    music.likes.list,
    (paginationOpts) => ({ paginationOpts }),
    LIKED_LIMIT,
    PAGE_ROWS,
  );

  if (paged.status === "loading") return undefined;

  if (paged.status === "failed") throw new Error(paged.message);

  return {
    tracks: paged.rows.slice(0, LIKED_LIMIT),
    done: paged.next.kind === "done" || paged.rows.length >= LIKED_LIMIT,
  };
};
