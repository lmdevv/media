/**
 * Data migrations: rewrites of stored rows that a new version needs and a schema change cannot do.
 * The container's init runs `migrations:run` after every deploy (and `scripts/dev-backend.sh` does
 * the same), so an upgraded install migrates without anyone asking.
 *
 * Each migration walks one table in batches small enough for Convex's per-mutation limits, saving
 * its cursor in the `migrations` table after every batch, so a restart resumes where it stopped.
 * Every batch is idempotent: it computes each row's target value and writes only rows that differ.
 * Changing what a migration computes (such as the folding rules) needs a new migration name, or
 * installs that finished the old one never rewrite their rows.
 */
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { enqueueScan } from "./handlers/admin";
import { albumSearchText, artistSearchText, trackSearchText } from "./lib/catalog";
import { lookupKeyFor } from "./lib/lyricLookups";
import { hasSyncedMain } from "./lib/lyrics";
import {
  clearedLegacyQueue,
  hasLegacyItems,
  hasLegacyQueue,
  legacyQueue,
  rowQueue,
  saveQueue,
} from "./lib/queue";
import { hasLegacyCounts, splitLegacyCounts } from "./lib/stats";

const BATCH = 256;

const LYRICS_BATCH = 8;

interface Batch {
  readonly continueCursor: string;
  readonly isDone: boolean;
}

type Migration = (ctx: MutationCtx, cursor: string | null) => Promise<Batch>;

const MIGRATIONS = {
  foldTrackSearchText: async (ctx, cursor) => {
    const page = await ctx.db.query("tracks").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.map(async (track) => {
        const searchText = trackSearchText(track);

        if (track.searchText !== searchText) await ctx.db.patch(track._id, { searchText });
      }),
    );

    return page;
  },
  foldAlbumSearchText: async (ctx, cursor) => {
    const page = await ctx.db.query("albums").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.map(async (album) => {
        const searchText = albumSearchText(album);

        if (album.searchText !== searchText) await ctx.db.patch(album._id, { searchText });
      }),
    );

    return page;
  },
  foldArtistSearchText: async (ctx, cursor) => {
    const page = await ctx.db.query("artists").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.map(async (artist) => {
        const searchText = artistSearchText(artist);

        if (artist.searchText !== searchText) await ctx.db.patch(artist._id, { searchText });
      }),
    );

    return page;
  },
  splitPlaybackQueues: async (ctx, cursor) => {
    const page = await ctx.db.query("playbackSessions").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyQueue).map(async (session) => {
        const row = await ctx.db
          .query("playbackQueues")
          .withIndex("by_user", (q) => q.eq("userId", session.userId))
          .unique();

        if (row === null) await saveQueue(ctx, session.userId, legacyQueue(session));
        else await ctx.db.patch(session._id, clearedLegacyQueue);
      }),
    );

    return page;
  },
  claimLibraryRoots: async (ctx, cursor) => {
    const page = await ctx.db.query("libraries").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page
        .filter((library) => library.rootIds === undefined)
        .map((library) => enqueueScan(ctx, library._id, library.ownerId)),
    );

    return page;
  },
  queueItems: async (ctx, cursor) => {
    const page = await ctx.db.query("playbackQueues").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyItems).map((row) => saveQueue(ctx, row.userId, rowQueue(row))),
    );

    return page;
  },
  promoteOwner: async (ctx) => {
    const done = { continueCursor: "", isDone: true };

    const owner = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .first();

    if (owner !== null) return done;

    const admin = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .filter((q) => q.eq(q.field("suspendedAt"), undefined))
      .first();

    if (admin !== null) await ctx.db.patch(admin._id, { role: "owner" });

    return done;
  },
  splitLibraryStats: async (ctx, cursor) => {
    const page = await ctx.db.query("libraries").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyCounts).map((library) => splitLegacyCounts(ctx, library)),
    );

    return page;
  },
  trackLyricsSynced: async (ctx, cursor) => {
    const page = await ctx.db.query("localLyrics").paginate({ cursor, numItems: LYRICS_BATCH });

    await Promise.all(
      page.page.map(async (row) => {
        const track = await ctx.db.get(row.trackId);
        const lyricsSynced = hasSyncedMain(row.sets);

        if (track !== null && track.lyricsSynced !== lyricsSynced) {
          await ctx.db.patch(track._id, { lyricsSynced });
        }
      }),
    );

    return page;
  },
  trackLookupKeys: async (ctx, cursor) => {
    const page = await ctx.db.query("tracks").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.map(async (track) => {
        const lookupKey = lookupKeyFor(track);

        if (track.lookupKey !== lookupKey) await ctx.db.patch(track._id, { lookupKey });
      }),
    );

    return page;
  },
} satisfies Record<string, Migration>;

type MigrationName = keyof typeof MIGRATIONS;

const migrationName = v.union(
  v.literal("foldTrackSearchText"),
  v.literal("foldAlbumSearchText"),
  v.literal("foldArtistSearchText"),
  v.literal("splitPlaybackQueues"),
  v.literal("queueItems"),
  v.literal("promoteOwner"),
  v.literal("claimLibraryRoots"),
  v.literal("splitLibraryStats"),
  v.literal("trackLookupKeys"),
  v.literal("trackLyricsSynced"),
);

const NAMES: ReadonlyArray<MigrationName> = [
  "foldTrackSearchText",
  "foldAlbumSearchText",
  "foldArtistSearchText",
  "splitPlaybackQueues",
  "queueItems",
  "promoteOwner",
  "claimLibraryRoots",
  "splitLibraryStats",
  "trackLookupKeys",
  "trackLyricsSynced",
];

/**
 * Starts every migration that has not finished, from its saved cursor. Safe to run any number of
 * times: finished migrations are skipped, and if a batch chain is already in flight the duplicate
 * chain stops at its first batch (see `step`).
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    await Promise.all(
      NAMES.map(async (name) => {
        const progress = await ctx.db
          .query("migrations")
          .withIndex("by_name", (q) => q.eq("name", name))
          .unique();

        if (progress?.done === true) return;

        if (progress === null) {
          await ctx.db.insert("migrations", { name, cursor: null, done: false });
        }

        await ctx.scheduler.runAfter(0, internal.migrations.step, {
          name,
          cursor: progress?.cursor ?? null,
        });
      }),
    );
  },
});

/**
 * Runs one batch of `name` and schedules the next. A batch runs only when `cursor` is the saved
 * one, so of two chains started from the same point exactly one advances (Convex mutations are
 * serializable) and the other stops.
 */
export const step = internalMutation({
  args: { name: migrationName, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { name, cursor }) => {
    const progress = await ctx.db
      .query("migrations")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();

    if (progress === null || progress.done || progress.cursor !== cursor) return;

    const batch = await MIGRATIONS[name](ctx, cursor);

    await ctx.db.patch(progress._id, { cursor: batch.continueCursor, done: batch.isDone });

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.step, {
        name,
        cursor: batch.continueCursor,
      });
    }
  },
});
