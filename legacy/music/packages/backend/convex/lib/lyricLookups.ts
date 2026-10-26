/**
 * LRCLIB lookups (`lyricLookups`): which songs' lyrics get asked for, and what LRCLIB is known to
 * hold for a song. How a lookup moves from state to state is `@music/commands/lyric-lookups`,
 * which the media service's in-memory backend runs too.
 */
import {
  newestFirst,
  pauseEnd,
  requested,
  type LookupPriority,
} from "@music/commands/lyric-lookups";
import { LrclibLyricSet, LyricsLookup, canLookUp, lookupKeyOf } from "@music/commands/lyrics";
import { Result, Schema } from "effect";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { inOrder } from "./sequence";
import { readServerSettings } from "./serverSettings";
import type { ReadCtx } from "./viewer";

/** The lookup key for a song's tags, or undefined when LRCLIB cannot match them (`canLookUp`). */
export const lookupKeyFor = (
  track: Pick<Doc<"tracks">, "title" | "artistName" | "albumTitle" | "durationMs">,
): string | undefined => {
  const query = {
    artist: track.artistName,
    title: track.title,
    album: track.albumTitle,
    durationMs: track.durationMs,
  };

  return canLookUp(query) ? lookupKeyOf(query) : undefined;
};

const queryOf = (track: Doc<"tracks">): Doc<"lyricLookups">["query"] => ({
  artist: track.artistName,
  title: track.title,
  album: track.albumTitle,
  durationS: Math.round(track.durationMs / 1000),
});

/** The lookup for `key`, if any song asked for it. */
export const lookupByKey = (ctx: ReadCtx, key: string): Promise<Doc<"lyricLookups"> | null> =>
  ctx.db
    .query("lyricLookups")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

const requestOne = async (
  ctx: MutationCtx,
  track: Doc<"tracks">,
  priority: LookupPriority,
  at: number,
): Promise<void> => {
  if (track.missing || track.lyricsSynced === true || track.lookupKey === undefined) return;
  const row = await lookupByKey(ctx, track.lookupKey);
  const state = requested(row?.state ?? null, priority, at);

  if (state === null) return;

  if (row === null) {
    await ctx.db.insert("lyricLookups", { key: track.lookupKey, query: queryOf(track), state });

    return;
  }

  // A miss asked again takes the tags of the song asking now.
  await (row.state.status === "miss"
    ? ctx.db.patch(row._id, { state, query: queryOf(track) })
    : ctx.db.patch(row._id, { state }));
};

/**
 * Asks LRCLIB for the lyrics of `tracks` at `priority`, most urgent first (see `requested`): a
 * song without a lookup gets a queued one, and a pending lookup rises to `priority` when that is
 * more urgent. Nothing happens with remote lyrics off, for a song whose own files hold synced
 * lyrics, for one with no lookup key, or for a lookup already answered (a miss counts as answered
 * for `MISS_RETRY_MS`).
 */
export const requestLyrics = async (
  ctx: MutationCtx,
  tracks: ReadonlyArray<Doc<"tracks">>,
  priority: LookupPriority,
): Promise<void> => {
  if (!(await readServerSettings(ctx)).remoteLyrics) return;
  const now = Date.now();

  // One after another: two songs with the same tags share one lookup. Songs asked for together
  // keep their order in a newest-first queue: each counts as asked a millisecond after the next.
  await inOrder(tracks, (track, position) =>
    requestOne(ctx, track, priority, newestFirst(priority) ? now - position : now),
  );
};

/** `requestLyrics` for songs by ID; IDs of songs that are gone are skipped. */
export const requestLyricsFor = async (
  ctx: MutationCtx,
  trackIds: ReadonlyArray<Id<"tracks">>,
  priority: LookupPriority,
): Promise<void> => {
  const tracks = await Promise.all([...new Set(trackIds)].map((id) => ctx.db.get(id)));

  await requestLyrics(
    ctx,
    tracks.filter((track) => track !== null),
    priority,
  );
};

/**
 * Pauses LRCLIB lookups for `pauseMs` from `now`, keeping a longer pause, and schedules the end
 * (`lyricLookups:endPause`).
 */
export const pauseLookups = async (
  ctx: MutationCtx,
  now: number,
  pauseMs: number,
): Promise<void> => {
  const pause = await ctx.db.query("lrclibPause").first();
  const until = pauseEnd(pause?.until ?? null, now, pauseMs);

  if (pause?.until === until) return;

  if (pause === null) await ctx.db.insert("lrclibPause", { until });
  else await ctx.db.patch(pause._id, { until });

  await ctx.scheduler.runAt(until, internal.lyricLookups.endPause, {});
};

const decodeSets = Schema.decodeUnknownResult(Schema.NonEmptyArray(LrclibLyricSet));

/**
 * What LRCLIB is known to hold for `track`: pending while its lookup is queued, running, or
 * waiting to retry, and its stored answer once it has one. A stored answer that no longer decodes
 * is logged and reads as none.
 */
export const lookupOf = async (ctx: ReadCtx, track: Doc<"tracks">): Promise<LyricsLookup> => {
  const row = track.lookupKey === undefined ? null : await lookupByKey(ctx, track.lookupKey);

  if (row === null) return LyricsLookup.None();

  if (row.state.status === "miss") return LyricsLookup.None();

  if (row.state.status === "instrumental") return LyricsLookup.Instrumental();

  if (row.state.status !== "found") return LyricsLookup.Pending();

  const stored = await ctx.db
    .query("lrclibLyrics")
    .withIndex("by_lookup", (q) => q.eq("lookupId", row._id))
    .unique();

  const decoded = decodeSets(stored?.sets);

  if (Result.isFailure(decoded)) {
    console.error(`Stored LRCLIB lyrics are unreadable for ${row._id}: ${decoded.failure.message}`);

    return LyricsLookup.None();
  }

  return LyricsLookup.Found({ sets: decoded.success });
};
