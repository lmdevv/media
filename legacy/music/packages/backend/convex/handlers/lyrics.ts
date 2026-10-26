import { resolveLyrics, TrackLyrics } from "@music/commands/lyrics";
import { Schema } from "effect";

import { internal } from "../_generated/api";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { inJamQueue } from "../lib/jams";
import { lookupOf } from "../lib/lyricLookups";
import { localLyricsOf } from "../lib/lyrics";
import { readServerSettings } from "../lib/serverSettings";
import { canRead } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";

const encodeLyrics = Schema.encodeSync(TrackLyrics);

/** `lyrics.get`: the lyrics a client shows for a song. */
export const lyricsQueries = {
  "lyrics.get": async (ctx, viewer, args) => {
    const track = await ctx.db.get(tableId(ctx, "tracks", args.trackId));

    // People in a Jam read the lyrics of the songs they hear in it, as they stream them.
    if (
      track === null ||
      (!canRead(viewer, track.libraryId) && !(await inJamQueue(ctx, viewer, track)))
    ) {
      return fail("not_found", "Track not found");
    }

    const [local, lookup, settings] = await Promise.all([
      localLyricsOf(ctx, track._id),
      lookupOf(ctx, track),
      readServerSettings(ctx),
    ]);

    return encodeLyrics(
      resolveLyrics(local, lookup, { remoteLookups: settings.remoteLyrics ? "on" : "off" }),
    );
  },
} satisfies Partial<QueryHandlers>;

/** `lyrics.backfill`: look up lyrics for every song an admin can read. */
export const lyricsMutations = {
  "lyrics.backfill": async (ctx, viewer) => {
    if (!(await readServerSettings(ctx)).remoteLyrics) {
      return fail(
        "conflict",
        "Lyrics lookups on LRCLIB are off. Turn them on with music server update --remote-lyrics",
      );
    }

    const libraryIds = viewer.libraries.map((library) => library._id);

    if (libraryIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.lyricLookups.backfill, { libraryIds, cursor: null });
    }

    return { libraries: libraryIds.length };
  },
} satisfies Partial<MutationHandlers>;
