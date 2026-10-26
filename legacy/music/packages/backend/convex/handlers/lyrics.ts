import { LyricsLookup, resolveLyrics, TrackLyrics } from "@music/commands/lyrics";
import { Schema } from "effect";

import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { inJamQueue } from "../lib/jams";
import { localLyricsOf } from "../lib/lyrics";
import { canRead } from "../lib/viewer";
import type { QueryHandlers } from "./types";

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

    const local = await localLyricsOf(ctx, track._id);

    // No song is looked up on LRCLIB yet, so the song's own lyrics are the only answer.
    return encodeLyrics(resolveLyrics(local, LyricsLookup.None(), { remoteLookups: "off" }));
  },
} satisfies Partial<QueryHandlers>;
