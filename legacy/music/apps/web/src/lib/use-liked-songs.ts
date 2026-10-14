import { encodeArgs, resultDecoder } from "@music/commands/codec";
import type { Track } from "@music/commands/models";
import { InvalidResultError } from "@music/sdk/client";
import { readCommand } from "@music/sdk/functions";
import { useQueries } from "convex/react";
import { Result } from "effect";
import { useEffect, useMemo, useState } from "react";

/** Liked songs per page; pages load one after another until the list ends. */
const PAGE_SIZE = 200;

/** Most liked songs the page keeps live at once. */
const LIKED_LIMIT = 5000;

const decodePage = resultDecoder("likes.page");

/** Every liked song the viewer can play, newest first, and whether all of them have loaded. */
export interface LikedSongs {
  readonly tracks: ReadonlyArray<Track>;
  readonly done: boolean;
}

/**
 * Subscribes to the liked songs page by page, loading each next page as soon as the one before it
 * arrives, up to `LIKED_LIMIT` songs. Each page is its own subscription and Convex keeps a live
 * page's range fixed, so a song liked while the list is open lands in the first page. Returns
 * undefined until the first page arrives; throws a page's error, like `useRead`.
 */
export const useLikedSongs = (): LikedSongs | undefined => {
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);

  const queries = useMemo(
    () =>
      Object.fromEntries(
        cursors.map((cursor, index) => [
          String(index),
          {
            query: readCommand,
            args: {
              name: "likes.page" as const,
              args: encodeArgs("likes.page", { cursor, limit: PAGE_SIZE }),
            },
          },
        ]),
      ),
    [cursors],
  );

  const results = useQueries(queries);

  const pages = cursors.map((_, index) => {
    const wire: unknown = results[String(index)];

    if (wire === undefined) return undefined;

    if (wire instanceof Error) throw wire;
    const decoded = decodePage(wire);

    if (Result.isFailure(decoded)) {
      throw new InvalidResultError(
        `likes.page returned an unexpected result: ${decoded.failure.message}`,
      );
    }

    return decoded.success;
  });

  const last = pages.at(-1);
  const tracks = pages.flatMap((page) => page?.items ?? []);
  const next = last === undefined || last.done || tracks.length >= LIKED_LIMIT ? null : last.cursor;

  useEffect(() => {
    if (next !== null) setCursors((list) => (list.includes(next) ? list : [...list, next]));
  }, [next]);

  if (pages[0] === undefined) return undefined;

  return { tracks, done: last?.done === true };
};
