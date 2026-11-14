import { register } from "../../commands/music/albums";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { readsOf } from "../movies/reads";
import { ALBUM_FACTS, requireAlbum } from "./access";
import { TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { libraryPage } from "./merged";
import type { LibraryList } from "./merged";
import { likedAmong, musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";

/** What one album of a list reads besides its library's grants: the album and its library. */
const ALBUM_ROW_READS = 2;

/** What one track of an album's page reads: the track and whether the caller likes it. */
const ALBUM_TRACK_READS = 2;

/**
 * Albums newest first, in one library (`by_library_added`) or in every one (`by_added`). An album
 * whose songs all went missing does not show.
 */
const newest = (db: DatabaseReader): LibraryList<Doc<"albums">, number> => ({
  order: "desc",
  key: (album) => album.addedAt,
  keyFrom: (text) => {
    const addedAt = Number(text);

    return text.length > 0 && Number.isFinite(addedAt) ? addedAt : null;
  },
  rowBytes: TABLE_BYTES.albums,
  inLibrary: (libraryId: Id<"libraries">) => ({
    atKey: async (key, tie, count) =>
      db
        .query("albums")
        .withIndex("by_library_added", (q) =>
          q.eq("libraryId", libraryId).eq("addedAt", key).lt("tie", tie),
        )
        .order("desc")
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("albums")
        .withIndex("by_library_added", (q) => {
          const inIt = q.eq("libraryId", libraryId);

          return key === null ? inIt : inIt.lt("addedAt", key);
        })
        .order("desc")
        .take(count),
  }),
  everywhere: {
    atKey: async (key, tie, count) =>
      db
        .query("albums")
        .withIndex("by_added", (q) => q.eq("addedAt", key).lt("tie", tie))
        .order("desc")
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("albums")
        .withIndex("by_added", (q) => (key === null ? q : q.lt("addedAt", key)))
        .order("desc")
        .take(count),
  },
  shows: (album, gate) => album.trackCount > 0 && gate.admits(ALBUM_FACTS),
  shown: readsOf(0, 0, 0),
  rowReads: ALBUM_ROW_READS,
});

export const { list, get, tracks } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const page = await libraryPage(ctx.db, reach, newest(ctx.db), paginationOpts);
    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(page.page.map(async (album) => present.album(album))),
    };
  },
  get: async (ctx, { albumId }, caller) => {
    const { row: album } = await requireAlbum(ctx.db, await reachOf(ctx.db, caller), albumId);

    return {
      album: await musicPresenter().album(album),
      durationMs: album.durationMs,
      genre: album.genre,
      format: album.format,
    };
  },
  tracks: async (ctx, { albumId, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const { row: album, gate } = await requireAlbum(ctx.db, reach, albumId);

    const page = await paginateAtMost(
      ctx.db,
      { table: "tracks", index: "by_album", range: (q) => q.eq("albumId", album._id) },
      paginationOpts,
      pageRowsFor(reach, ALBUM_TRACK_READS, TRACK_ROW_BYTES),
    );

    const shown = page.page.filter((track) => !track.missing && gate.admits(trackFacts(track)));

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      shown.map((track) => track._id),
    );

    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        shown.map(async (track) => present.track(track, liked.has(track._id))),
      ),
    };
  },
});
