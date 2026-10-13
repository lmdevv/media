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
import { albumSearchText, artistSearchText, trackSearchText } from "./lib/catalog";

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
} satisfies Record<string, Migration>;

type MigrationName = keyof typeof MIGRATIONS;

const migrationName = v.union(
  v.literal("foldTrackSearchText"),
  v.literal("foldAlbumSearchText"),
  v.literal("foldArtistSearchText"),
);

const NAMES: ReadonlyArray<MigrationName> = [
  "foldTrackSearchText",
  "foldAlbumSearchText",
  "foldArtistSearchText",
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
