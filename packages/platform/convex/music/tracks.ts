import { v } from "convex/values";

import { register } from "../../commands/music/tracks";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { foldersOf, isInside } from "../core/folders";
import { serverQuery } from "../core/lib/serverFacing";
import { reachOf } from "../core/permissions/grants";
import { requireTrack } from "./access";
import { trackFacts } from "./items";
import { libraryPage } from "./merged";
import type { LibraryList } from "./merged";
import { likedAmong, musicPresenter } from "./present";
import { LIKED_READS, TRACK_ROW_BYTES } from "./reads";

/** What one song of the list reads besides its library's grants: it, its library, and its like. */
const TRACK_ROW_READS = 3;

/** Songs on disk by title, in one library (`by_library_title`) or in every one (`by_title`). */
const songs = (db: DatabaseReader): LibraryList<Doc<"tracks">, string> => ({
  order: "asc",
  key: (track) => track.titleKey,
  keyFrom: (text) => text,
  rowBytes: TRACK_ROW_BYTES,
  inLibrary: (libraryId: Id<"libraries">) => ({
    atKey: async (key, tie, count) =>
      db
        .query("tracks")
        .withIndex("by_library_title", (q) =>
          q.eq("libraryId", libraryId).eq("missing", false).eq("titleKey", key).gt("tie", tie),
        )
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("tracks")
        .withIndex("by_library_title", (q) => {
          const onDisk = q.eq("libraryId", libraryId).eq("missing", false);

          return key === null ? onDisk : onDisk.gt("titleKey", key);
        })
        .take(count),
  }),
  everywhere: {
    atKey: async (key, tie, count) =>
      db
        .query("tracks")
        .withIndex("by_title", (q) => q.eq("missing", false).eq("titleKey", key).gt("tie", tie))
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("tracks")
        .withIndex("by_title", (q) => {
          const onDisk = q.eq("missing", false);

          return key === null ? onDisk : onDisk.gt("titleKey", key);
        })
        .take(count),
  },
  shows: (track, gate) => gate.admits(trackFacts(track)),
  shown: LIKED_READS,
  rowReads: TRACK_ROW_READS,
});

export const { list, get } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const page = await libraryPage(ctx.db, reach, songs(ctx.db), paginationOpts);

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      page.page.map((track) => track._id),
    );

    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (track) => present.track(track, liked.has(track._id))),
      ),
    };
  },
  get: async (ctx, { trackId }, caller) => {
    const { row: track } = await requireTrack(ctx.db, await reachOf(ctx.db, caller), trackId);
    const liked = await likedAmong(ctx.db, caller.userId, [track._id]);

    return musicPresenter().track(track, liked.has(track._id));
  },
});

/**
 * What the server needs to stream a track a ticket names, as old music's `trackSource` answered
 * it: its path, its library's folders now, its file's size and change time, and its codec. Null
 * for an id that names no track, and for a track a scan marked missing, whose library is gone or
 * is not a music library, or that no folder of its library holds now (a removed folder's purge has
 * yet to reach it). Reads the track, its library, and its folders: at most 18 documents.
 */
export const resolve = serverQuery({
  args: { trackId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      trackId: v.id("tracks"),
      libraryId: v.id("libraries"),
      path: v.string(),
      roots: v.array(v.string()),
      size: v.number(),
      mtimeMs: v.number(),
      codec: v.string(),
    }),
  ),
  handler: async (ctx, { trackId }) => {
    const id = ctx.db.normalizeId("tracks", trackId);
    const track = id === null ? null : await ctx.db.get(id);

    if (track === null || track.missing) return null;

    const library = await ctx.db.get(track.libraryId);

    if (library?.kind !== "music") return null;

    const roots = await foldersOf(ctx.db, library._id);

    if (!roots.some((root) => isInside(track.path, root))) return null;

    return {
      trackId: track._id,
      libraryId: library._id,
      path: track.path,
      roots: [...roots],
      size: track.size,
      mtimeMs: track.mtimeMs,
      codec: track.codec,
    };
  },
});
