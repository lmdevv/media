/**
 * Background work on LRCLIB lookups (see `lib/lyricLookups.ts`): the songs of a download pin and
 * the admin backfill, a page at a time, retries coming due, the end of a pause, and leases that
 * ran out.
 */
import { expiredLease, retried } from "@music/commands/lyric-lookups";
import { v } from "convex/values";
import { Match } from "effect";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { requestLyrics, requestLyricsFor } from "./lib/lyricLookups";
import { readServerSettings } from "./lib/serverSettings";
import { pinTarget } from "./schema";

/** Songs one mutation requests lyrics for at most. */
const REQUEST_PAGE = 200;

const cursorArg = v.union(v.string(), v.null());

/**
 * Requests lyrics for the songs a download pin keeps (`downloads.add`), a page of its album or
 * playlist at a time, rescheduling itself from `cursor`. It stops when remote lyrics are off.
 */
export const requestPinned = internalMutation({
  args: { target: pinTarget, cursor: cursorArg },
  handler: async (ctx, { target, cursor }) => {
    if (!(await readServerSettings(ctx)).remoteLyrics) return;

    const page = await Match.value(target).pipe(
      Match.discriminatorsExhaustive("kind")({
        track: async ({ id }) => {
          await requestLyricsFor(ctx, [id], "pin");

          return null;
        },
        album: async ({ id }) => {
          const tracks = await ctx.db
            .query("tracks")
            .withIndex("by_album", (q) => q.eq("albumId", id))
            .paginate({ cursor, numItems: REQUEST_PAGE });

          await requestLyrics(ctx, tracks.page, "pin");

          return tracks;
        },
        playlist: async ({ id }) => {
          const items = await ctx.db
            .query("playlistItems")
            .withIndex("by_playlist", (q) => q.eq("playlistId", id))
            .paginate({ cursor, numItems: REQUEST_PAGE });

          await requestLyricsFor(
            ctx,
            items.page.map((item) => item.trackId),
            "pin",
          );

          return items;
        },
      }),
    );

    if (page !== null && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.lyricLookups.requestPinned, {
        target,
        cursor: page.continueCursor,
      });
    }
  },
});

/**
 * Requests lyrics for every song in `libraryIds` at backfill priority (`lyrics.backfill`), a page
 * at a time, rescheduling itself from `cursor`, then with the next library. It stops when remote
 * lyrics are turned off.
 */
export const backfill = internalMutation({
  args: { libraryIds: v.array(v.id("libraries")), cursor: cursorArg },
  handler: async (ctx, { libraryIds, cursor }) => {
    const [libraryId, ...later] = libraryIds;

    if (libraryId === undefined || !(await readServerSettings(ctx)).remoteLyrics) return;

    const page = await ctx.db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({ cursor, numItems: REQUEST_PAGE });

    await requestLyrics(ctx, page.page, "backfill");

    const next = page.isDone
      ? { libraryIds: later, cursor: null }
      : { libraryIds, cursor: page.continueCursor };

    if (next.libraryIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.lyricLookups.backfill, next);
    }
  },
});

/** Queues a lookup again once its retry time came (scheduled by `media:saveLookup`). */
export const requeue = internalMutation({
  args: { lookupId: v.id("lyricLookups") },
  handler: async (ctx, { lookupId }) => {
    const row = await ctx.db.get(lookupId);

    if (row?.state.status !== "waiting") return;
    const state = retried(row.state, Date.now());

    if (state !== null) await ctx.db.patch(row._id, { state });
  },
});

/** Ends the LRCLIB pause once its time came, showing the media service the queue again. */
export const endPause = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pause = await ctx.db.query("lrclibPause").first();

    if (pause !== null && pause.until <= Date.now()) await ctx.db.delete(pause._id);
  },
});

/**
 * Queues lookups again whose lease ran out, as when the media service stopped mid-request,
 * counting each as a failed try.
 */
export const releaseExpiredLeases = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const leased = await ctx.db
      .query("lyricLookups")
      .withIndex("by_state", (q) => q.eq("state.status", "leased"))
      .collect();

    await Promise.all(
      leased.map(async (row) => {
        if (row.state.status === "leased" && row.state.leaseUntil < now) {
          await ctx.db.patch(row._id, { state: expiredLease(row.state, now) });
        }
      }),
    );
  },
});
