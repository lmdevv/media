/**
 * The lyrics a song's own files hold (`localLyrics`), as the media service reads them during
 * scans. Sets are decoded with the shared `LocalLyricSet` schema when written and when read,
 * since the table's validator checks their shape but not the schema's refinements.
 */
import { LocalLyricSet } from "@music/commands/lyrics";
import type { Infer } from "convex/values";
import { Result, Schema } from "effect";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { localLyricSet } from "../schema";
import { fail } from "./errors";
import type { ReadCtx } from "./viewer";

/** One lyric set as `localLyrics` stores it. */
export type StoredLyricSet = Infer<typeof localLyricSet>;

/** The lyrics the media service read for one file: its lyric files, and the sets they hold. */
export interface ScannedLyrics {
  readonly path: string;
  /** The lyric files beside the file, as `tracks.lyricsFiles` keeps them. */
  readonly lyricsFiles: string;
  /** The version of the reader that read them (`tracks.lyricsReader`). */
  readonly lyricsReader: number;
  /** The file's own lyric sets, from its lyric files and tags; none when it has none. */
  readonly lyrics: Array<StoredLyricSet>;
}

const decodeWritten = Schema.decodeUnknownResult(Schema.Array(LocalLyricSet));

const decodeStored = Schema.decodeUnknownResult(Schema.NonEmptyArray(LocalLyricSet));

const rowOf = (ctx: ReadCtx, trackId: Id<"tracks">): Promise<Doc<"localLyrics"> | null> =>
  ctx.db
    .query("localLyrics")
    .withIndex("by_track", (q) => q.eq("trackId", trackId))
    .unique();

/** The fields a track keeps about its own lyrics, for the lyrics a scan read for it. */
export const lyricsFieldsOf = (scanned: ScannedLyrics) => ({
  lyricsFiles: scanned.lyricsFiles,
  lyricsReader: scanned.lyricsReader,
  lyricsBytes:
    scanned.lyrics.length === 0
      ? undefined
      : new TextEncoder().encode(JSON.stringify(scanned.lyrics)).length,
});

/**
 * A song's own lyric sets, in the order the media service found them; none when it has none. A
 * stored row that no longer decodes, as when the lyrics schema tightens, is logged and reads as
 * none until a scan reads the song's lyrics again.
 */
export const localLyricsOf = async (
  ctx: ReadCtx,
  trackId: Id<"tracks">,
): Promise<ReadonlyArray<LocalLyricSet>> => {
  const row = await rowOf(ctx, trackId);

  if (row === null) return [];
  const decoded = decodeStored(row.sets);

  if (Result.isFailure(decoded)) {
    console.error(`Stored lyrics are unreadable for ${trackId}: ${decoded.failure.message}`);

    return [];
  }

  return decoded.success;
};

/**
 * Makes `sets` a song's own lyrics, deleting its row when there are none. Writing the same
 * lyrics again changes nothing, so a batch retried after a lost response converges. Fails
 * `invalid_args` when a set breaks the `LocalLyricSet` schema.
 */
export const replaceLocalLyrics = async (
  ctx: MutationCtx,
  trackId: Id<"tracks">,
  sets: ReadonlyArray<StoredLyricSet>,
): Promise<void> => {
  const decoded = decodeWritten(sets);

  if (Result.isFailure(decoded)) {
    return fail("invalid_args", `Lyrics are not lyric sets: ${decoded.failure.message}`);
  }

  const row = await rowOf(ctx, trackId);

  if (sets.length === 0) {
    if (row !== null) await ctx.db.delete(row._id);

    return;
  }

  if (row === null) await ctx.db.insert("localLyrics", { trackId, sets: [...sets] });
  else if (JSON.stringify(row.sets) !== JSON.stringify(sets)) {
    await ctx.db.patch(row._id, { sets: [...sets] });
  }
};

/** Deletes a song's own lyrics with the song. Returns how many rows it deleted. */
export const deleteLocalLyrics = async (
  ctx: MutationCtx,
  trackId: Id<"tracks">,
): Promise<number> => {
  const row = await rowOf(ctx, trackId);

  if (row === null) return 0;
  await ctx.db.delete(row._id);

  return 1;
};
