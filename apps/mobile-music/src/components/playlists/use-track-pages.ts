import { usePages } from "@media/mobile-core/pages";
import { useEffect } from "react";

import type { Track } from "@/lib/models";
import { useMusic } from "@/lib/platform";

const PAGE_SIZE = 200;

const SONG_LIMIT = 5000;

/** The queries that page through songs: your liked songs, or every song you may play. */
type TrackPageName = "likes" | "tracks";

/** The songs loaded so far, whether that is all of them, and how to ask for more. */
export interface TrackPages {
  readonly tracks: ReadonlyArray<Track>;
  /** Whether the last page has loaded; false past `SONG_LIMIT` too, where loading stops. */
  readonly done: boolean;
  /** Loads the next page, once the last one has arrived; nothing when done. */
  readonly more: () => void;
}

/**
 * Follows `name` page by page. `eager` asks for each next page as soon as the one before it
 * arrives (Liked songs, which plays and counts them all); otherwise `more` asks for it (a list
 * scrolled toward its end). Every page but the last ends where the next starts, so a song added
 * or removed while the list is open never falls between pages or shows twice. Undefined until the
 * first page arrives; throws a page's failure, like `useRead`.
 */
export const useTrackPages = (
  name: TrackPageName,
  { eager }: { readonly eager: boolean },
): TrackPages | undefined => {
  const music = useMusic();
  const query = name === "likes" ? music.likes.list : music.tracks.list;
  const paged = usePages(query, (paginationOpts) => ({ paginationOpts }), PAGE_SIZE);

  if (paged.status === "failed") throw new Error(paged.message);

  const ready = paged.status === "ready" ? paged : null;

  if (ready?.next.kind === "failed") throw new Error(ready.next.message);

  const tracks = ready?.rows ?? [];
  const load = ready?.next.kind === "more" && tracks.length < SONG_LIMIT ? ready.next.load : null;

  useEffect(() => {
    if (eager) load?.();
  }, [eager, load]);

  if (ready === null) return undefined;

  return { tracks, done: ready.next.kind === "done", more: () => load?.() };
};
