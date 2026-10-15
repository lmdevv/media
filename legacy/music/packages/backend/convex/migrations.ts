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
import {
  clearedLegacyQueue,
  hasLegacyItems,
  hasLegacyQueue,
  legacyQueue,
  rowQueue,
  saveQueue,
} from "./lib/queue";
import { hasLegacyCounts, splitLegacyCounts } from "./lib/stats";

/** Rows per batch: a track is well under 2 KB, so a batch stays far below the read limits. */
const BATCH = 256;

interface Batch {
  readonly continueCursor: string;
  readonly isDone: boolean;
}

/** Rewrites the batch of rows after `cursor` and reports where the next batch starts. */
type Migration = (ctx: MutationCtx, cursor: string | null) => Promise<Batch>;

const MIGRATIONS = {
  /** Track search text predates accent folding. */
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
  /** Album search text predates accent folding. */
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
  /** Artists were searched by their raw name and have no search text yet. */
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
  /**
   * The queue moved off the session into its own row, so position reports stop re-running
   * queries that read the queue. A user whose queue a write already moved is skipped.
   */
  splitPlaybackQueues: async (ctx, cursor) => {
    const page = await ctx.db.query("playbackSessions").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyQueue).map(async (session) => {
        const row = await ctx.db
          .query("playbackQueues")
          .withIndex("by_user", (q) => q.eq("userId", session.userId))
          .unique();

        // Without a row, saving creates it and clears the session; with one, the row is newer.
        if (row === null) await saveQueue(ctx, session.userId, legacyQueue(session));
        else await ctx.db.patch(session._id, clearedLegacyQueue);
      }),
    );

    return page;
  },
  /**
   * Libraries from before real folders were claimed (`media:claimRoot`) have no claim, or one
   * without folder identities, and stream nothing until claimed; a scan for each makes the media
   * service claim it now rather than at its next periodic scan.
   */
  claimLibraryRoots: async (ctx, cursor) => {
    const page = await ctx.db.query("libraries").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page
        .filter((library) => library.rootIds === undefined)
        .map((library) => enqueueScan(ctx, library._id, library.ownerId)),
    );

    return page;
  },
  /**
   * Queues stored song IDs before each entry had its own ID. Readers number such entries the
   * same way every time (see `itemsFromTrackIds`), so an ID a client saw before this batch ran
   * still names the same entry after it.
   */
  queueItems: async (ctx, cursor) => {
    const page = await ctx.db.query("playbackQueues").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyItems).map((row) => saveQueue(ctx, row.userId, rowQueue(row))),
    );

    return page;
  },
  /**
   * Servers from before owners have admins only; the earliest-created admin who is not suspended
   * becomes the owner. A suspended admin is never picked, nor unsuspended: with no admin left to
   * pick, the server stays without an owner, as one with no admins at all does, until the next
   * run finds one. One batch: the `by_role` index finds the rows directly.
   */
  promoteOwner: async (ctx) => {
    const done = { continueCursor: "", isDone: true };

    const owner = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .first();

    if (owner !== null) return done;

    // Within one role the index orders by creation time, so this is the first active admin.
    const admin = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .filter((q) => q.eq(q.field("suspendedAt"), undefined))
      .first();

    if (admin !== null) await ctx.db.patch(admin._id, { role: "owner" });

    return done;
  },
  /**
   * Library counters moved off the library row into `libraryStats`, so the counts a scan bumps
   * with every batch stop re-running every query that reads the libraries.
   */
  splitLibraryStats: async (ctx, cursor) => {
    const page = await ctx.db.query("libraries").paginate({ cursor, numItems: BATCH });

    await Promise.all(
      page.page.filter(hasLegacyCounts).map((library) => splitLegacyCounts(ctx, library)),
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
