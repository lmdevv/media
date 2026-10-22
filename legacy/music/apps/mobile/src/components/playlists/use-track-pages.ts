/**
 * Song lists the server pages through (liked songs, every song), kept live page by page: the
 * web's Liked songs reads them the same way.
 */
import { encodeArgs, resultDecoder } from "@music/commands/codec";
import type { Track } from "@music/commands/models";
import { InvalidResultError } from "@music/sdk/client";
import { readCommand } from "@music/sdk/functions";
import { useQueries } from "convex/react";
import { Result } from "effect";
import { useEffect, useState } from "react";

import { splitChain } from "@/lib/page-chain";

/** Songs per page. */
const PAGE_SIZE = 200;

/** Most songs kept live at once. */
const SONG_LIMIT = 5000;

/** The queries that page through songs. */
type TrackPageName = "likes.page" | "tracks.list";

const DECODERS = {
  "likes.page": resultDecoder("likes.page"),
  "tracks.list": resultDecoder("tracks.list"),
} as const;

/** The songs loaded so far, whether that is all of them, and how to ask for more. */
export interface TrackPages {
  readonly tracks: ReadonlyArray<Track>;
  /** Whether the last page has loaded; false past `SONG_LIMIT` too, where loading stops. */
  readonly done: boolean;
  /** Loads the next page, once the last one has arrived; nothing when done. */
  readonly more: () => void;
}

/**
 * Subscribes to `name` page by page. `eager` asks for each next page as soon as the one before it
 * arrives (Liked songs, which plays and counts them all); otherwise `more` asks for it (a list
 * scrolled toward its end). Every page but the last ends where the next starts, so a song added
 * or removed while the list is open never falls between pages or shows twice. Undefined until the
 * first page arrives; throws a page's error, like `useRead`.
 */
export const useTrackPages = (
  name: TrackPageName,
  { eager }: { readonly eager: boolean },
): TrackPages | undefined => {
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);

  const results = useQueries(
    Object.fromEntries(
      cursors.map((cursor, index) => [
        String(index),
        {
          query: readCommand,
          args: {
            name,
            args: encodeArgs(name, { cursor, end: cursors[index + 1] ?? null, limit: PAGE_SIZE }),
          },
        },
      ]),
    ),
  );

  const pages = cursors.map((_, index) => {
    const wire: unknown = results[String(index)];

    if (wire === undefined) return undefined;

    if (wire instanceof Error) throw wire;
    const decoded = DECODERS[name](wire);

    if (Result.isFailure(decoded)) {
      throw new InvalidResultError(
        `${name} returned an unexpected result: ${decoded.failure.message}`,
      );
    }

    return decoded.success;
  });

  // A page that outgrew its size ends early; the page that starts there goes in between.
  const chain = pages.reduce<ReadonlyArray<string | null>>(
    (list, page, index) =>
      page === undefined ? list : splitChain(list, cursors[index] ?? null, page.cursor),
    cursors,
  );

  const split = chain === cursors ? null : chain;

  useEffect(() => {
    if (split !== null) setCursors(split);
  }, [split]);

  const last = pages.at(-1);
  const tracks = pages.flatMap((page) => page?.items ?? []);
  const next = last === undefined || last.done || tracks.length >= SONG_LIMIT ? null : last.cursor;

  const more = () => {
    if (next !== null) setCursors((list) => (list.includes(next) ? list : [...list, next]));
  };

  // The next cursor exists only once the page before it arrives, so it is requested after render.
  useEffect(() => {
    if (eager && next !== null)
      setCursors((list) => (list.includes(next) ? list : [...list, next]));
  }, [eager, next]);

  if (pages[0] === undefined) return undefined;

  return { tracks, done: last?.done === true, more };
};
