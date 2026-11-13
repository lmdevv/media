import { register } from "../../commands/music/albums";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { ALBUM_FACTS, libraryGates, requireAlbum } from "./access";
import { DOCUMENT_BYTES, TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { likedAmong, musicPresenter } from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";

/** What one album of a list reads besides its library's grants: the album and its library. */
const ALBUM_ROW_READS = 2;

/** What one track of an album's page reads: the track and whether the caller likes it. */
const ALBUM_TRACK_READS = 2;

export const { list, get, tracks } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      { table: "albums", index: "by_added", order: "desc" },
      paginationOpts,
      pageRowsFor(reach, ALBUM_ROW_READS, TABLE_BYTES.albums + DOCUMENT_BYTES.small),
    );

    const present = musicPresenter();

    const cards = await Promise.all(
      page.page.map(async (album) => {
        if (album.trackCount === 0) return [];

        const gate = await gates(album.libraryId);

        return gate?.admits(ALBUM_FACTS) === true ? [await present.album(album)] : [];
      }),
    );

    return { ...page, page: cards.flat() };
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
