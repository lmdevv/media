import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { level } from "../../commands/access";
import { callerScope } from "../../commands/scopes";
import { internalMutation, internalQuery } from "../_generated/server";
import { callerOfSession } from "../core/auth/caller";
import { claimFolders } from "../core/folders";
import { fail } from "../core/lib/errors";
import { inOrder } from "../core/lib/inOrder";
import { paginate } from "../core/lib/paginate";
import { grantCreator, requireItems } from "../core/permissions/grants";
import { contentActions } from "../core/permissions/policy";
import { itemCount, withLibraryItems } from "../core/scans";
import { CALL_COST, cost } from "./budget";
import { catalogBatch } from "./catalog";
import { trackFacts } from "./items";
import { restPage, tracksPage } from "./purge";
import { totalNames, totalsOf } from "./totals";
import type { ScannedTrack } from "./validators";

/**
 * The stack suite's seam into the music catalog, as `movies/probe.ts` is for movies: a seed of
 * tracks written through the catalog batch without a scan, `open` and `page`, which decide tracks
 * through `requireItems` as the music commands will, and reads of the rows and totals a test
 * checks. The server never calls it.
 */

const SEED_MAX = 200;

const seededTrack = v.object({
  name: v.string(),
  explicit: v.boolean(),
  /** The album it files under, `Seed Album` when absent. */
  album: v.optional(v.string()),
});

/** A seeded song as a scan would send it: one second of FLAC by `Seed Artist`, without lyrics. */
const scannedOf = (
  folder: string,
  track: { readonly name: string; readonly explicit: boolean; readonly album?: string },
): ScannedTrack => ({
  path: `${folder}/${track.name}.flac`,
  size: 1000,
  mtimeMs: 0,
  title: track.name,
  artist: "Seed Artist",
  album: track.album ?? "Seed Album",
  durationMs: 1000,
  codec: "flac",
  lossless: true,
  explicit: track.explicit,
  lyricsFiles: "",
  lyricsReader: 1,
  lyrics: [],
});

/**
 * Makes music libraries managed by `managerId`, each with a folder of its own and tracks in it,
 * explicit or not, written through the catalog batch so every count and total moves, and queues
 * no scan.
 *
 * @throws Error when asked for none or more than 200 libraries.
 */
export const seed = internalMutation({
  args: {
    managerId: v.id("users"),
    libraries: v.array(v.object({ name: v.string(), items: v.array(seededTrack) })),
    /** People given `view` on every library made, as a share would. */
    viewers: v.optional(v.array(v.id("users"))),
  },
  returns: v.array(
    v.object({
      libraryId: v.id("libraries"),
      folder: v.string(),
      itemIds: v.array(v.id("tracks")),
    }),
  ),
  handler: async (ctx, { managerId, libraries, viewers }) => {
    if (libraries.length === 0 || libraries.length > SEED_MAX) {
      throw new Error(`seed makes 1 to ${SEED_MAX} libraries; got ${libraries.length}`);
    }

    const seeded = await inOrder(libraries, async ({ name, items }) => {
      const libraryId = await ctx.db.insert("libraries", { name, kind: "music", lastScan: null });
      const folder = `/probe/${libraryId}`;

      await claimFolders(ctx, libraryId, [folder]);
      await grantCreator(ctx, { type: "library", id: libraryId }, managerId);
      await inOrder(viewers ?? [], async (viewerId) =>
        ctx.db.insert("grants", {
          resourceType: "library",
          resourceId: libraryId,
          principal: viewerId,
          level: "view",
        }),
      );

      const itemIds = await withLibraryItems(ctx, libraryId, async () => {
        const batch = catalogBatch(ctx.db, libraryId);

        const written = await inOrder(items, async (item) =>
          (await batch.upsert(scannedOf(folder, item))).run(),
        );

        const settled = await batch.finish();

        return { ...settled, value: [...written] };
      });

      return { libraryId, folder, itemIds };
    });

    return [...seeded];
  },
});

const opened = v.object({ itemId: v.id("tracks"), path: v.string(), level });

/** Opens a track as a session would through a command that declares `scope`. */
export const open = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    action: v.union(...contentActions.map((action) => v.literal(action))),
    itemId: v.id("tracks"),
  },
  returns: opened,
  handler: async (ctx, { sessionId, scope, action, itemId }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const track = (await ctx.db.get(itemId)) ?? fail("not_found", "No such track");
    const gate = await requireItems(ctx, caller, action, track.libraryId);

    if (!gate.admits(trackFacts(track))) fail("not_found", "No such track");

    return { itemId: track._id, path: track.path, level: gate.level };
  },
});

/** One page of a library's tracks a session sees, by path, as a track list would page them. */
export const page = internalQuery({
  args: {
    sessionId: v.id("authSessions"),
    scope: callerScope,
    libraryId: v.id("libraries"),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(opened),
  handler: async (ctx, { sessionId, scope, libraryId, paginationOpts }) => {
    const caller = await callerOfSession(ctx.db, sessionId, scope);
    const gate = await requireItems(ctx, caller, "view", libraryId);

    const found = await paginate(
      ctx.db,
      {
        table: "tracks",
        index: "by_library_path",
        range: (q) => q.eq("libraryId", libraryId),
      },
      paginationOpts,
    );

    return {
      ...found,
      page: found.page
        .filter((track) => gate.admits(trackFacts(track)))
        .map((track) => ({ itemId: track._id, path: track.path, level: gate.level })),
    };
  },
});

const totals = v.object({
  tracks: v.number(),
  albums: v.number(),
  artists: v.number(),
  durationMs: v.number(),
});

/** A library's totals as its counters hold them. */
export const counted = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: totals,
  handler: (ctx, { libraryId }) => totalsOf(ctx.db, libraryId),
});

/**
 * Whether any shard of the library's album, artist, or duration totals is left, or its track
 * total, the core's item count, holds anything.
 */
export const hasTotals = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.boolean(),
  handler: async (ctx, { libraryId }) => {
    const shards = await Promise.all(
      totalNames(libraryId).map(async (name) =>
        ctx.db
          .query("counters")
          .withIndex("by_name_shard", (q) => q.eq("name", name))
          .first(),
      ),
    );

    return shards.some((shard) => shard !== null) || (await itemCount(ctx.db, libraryId)) !== 0;
  },
});

const ROWS_PAGE = 500;

/**
 * One page of a library's tracks as a test recounts them from the rows: how many rows, how many
 * on disk and their length, and the albums and artists those on disk file under. A test sums the
 * pages and compares them with the counters.
 */
export const rows = internalQuery({
  args: { libraryId: v.id("libraries"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    rows: v.number(),
    present: v.number(),
    durationMs: v.number(),
    albumIds: v.array(v.id("albums")),
    artistIds: v.array(v.id("artists")),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, { libraryId, cursor }) => {
    const found = await paginate(
      ctx.db,
      {
        table: "tracks",
        index: "by_library_path",
        range: (q) => q.eq("libraryId", libraryId),
      },
      { numItems: ROWS_PAGE, cursor },
    );

    const onDisk = found.page.filter((track) => !track.missing);

    return {
      rows: found.page.length,
      present: onDisk.length,
      durationMs: onDisk.reduce((sum, track) => sum + track.durationMs, 0),
      albumIds: [...new Set(onDisk.map((track) => track.albumId))],
      artistIds: [...new Set(onDisk.map((track) => track.artistId))],
      continueCursor: found.continueCursor,
      isDone: found.isDone,
    };
  },
});

const CATALOG_ROWS_MAX = 1000;

/** Up to 1,000 of a library's albums as a test lists them: title, artist, and tracks on disk. */
export const albumList = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.array(v.object({ title: v.string(), artistName: v.string(), trackCount: v.number() })),
  handler: async (ctx, { libraryId }) =>
    (
      await ctx.db
        .query("albums")
        .withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
        .take(CATALOG_ROWS_MAX)
    ).map(({ title, artistName, trackCount }) => ({ title, artistName, trackCount })),
});

/** How many album and artist rows a library holds, up to 1,000 each. */
export const catalogRows = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.object({ albums: v.number(), artists: v.number() }),
  handler: async (ctx, { libraryId }) => {
    const [albums, artists] = await Promise.all([
      ctx.db
        .query("albums")
        .withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
        .take(CATALOG_ROWS_MAX),
      ctx.db
        .query("artists")
        .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId))
        .take(CATALOG_ROWS_MAX),
    ]);

    return { albums: albums.length, artists: artists.length };
  },
});

/** How many of `trackIds` still have a track row, and how many a lyrics row. */
export const leftOf = internalQuery({
  args: { trackIds: v.array(v.id("tracks")) },
  returns: v.object({ tracks: v.number(), lyrics: v.number() }),
  handler: async (ctx, { trackIds }) => {
    const left = await Promise.all(
      trackIds.map(async (trackId) => ({
        track: (await ctx.db.get(trackId)) !== null,
        lyrics:
          (await ctx.db
            .query("localLyrics")
            .withIndex("by_track", (q) => q.eq("trackId", trackId))
            .first()) !== null,
      })),
    );

    return {
      tracks: left.filter((one) => one.track).length,
      lyrics: left.filter((one) => one.lyrics).length,
    };
  },
});

/** A track as a test checks it: its album and artist, and whether it is on disk. */
export const track = internalQuery({
  args: { trackId: v.id("tracks") },
  returns: v.union(
    v.null(),
    v.object({
      path: v.string(),
      albumId: v.id("albums"),
      artistId: v.id("artists"),
      missing: v.boolean(),
      explicit: v.boolean(),
      artHash: v.union(v.string(), v.null()),
      lyricsBytes: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { trackId }) => {
    const found = await ctx.db.get(trackId);

    return found === null
      ? null
      : {
          path: found.path,
          albumId: found.albumId,
          artistId: found.artistId,
          missing: found.missing,
          explicit: found.explicit,
          artHash: found.artHash,
          lyricsBytes: found.lyricsBytes,
        };
  },
});

/** A library's track ids at `paths`, in order, null where it has none. */
export const trackIdsAt = internalQuery({
  args: { libraryId: v.id("libraries"), paths: v.array(v.string()) },
  returns: v.array(v.union(v.id("tracks"), v.null())),
  handler: (ctx, { libraryId, paths }) =>
    Promise.all(
      paths.map(
        async (path) =>
          (
            await ctx.db
              .query("tracks")
              .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
              .first()
          )?._id ?? null,
      ),
    ),
});

/**
 * Runs one page of the music purge's tracks stage, or of a removed library's last stage, and
 * schedules nothing, so a test can act between pages.
 */
export const purgePage = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    stage: v.union(v.literal("tracks"), v.literal("rest")),
    cursor: v.union(v.string(), v.null()),
    /** A smaller budget of index ranges than a call's, so a test can stop a page partway. */
    ranges: v.optional(v.number()),
  },
  returns: v.object({ cursor: v.union(v.string(), v.null()), more: v.boolean() }),
  handler: async (ctx, { libraryId, stage, cursor, ranges }) => {
    if (stage === "rest") return { cursor: null, more: await restPage(ctx, libraryId) };

    const limit =
      ranges === undefined
        ? CALL_COST
        : { ...CALL_COST, work: cost(ranges, CALL_COST.work.writes).work };

    const next = await tracksPage(ctx, libraryId, cursor, limit);

    return { cursor: next.cursor, more: next.more };
  },
});
