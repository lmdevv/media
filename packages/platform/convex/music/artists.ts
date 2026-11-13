import { register } from "../../commands/music/artists";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { ALBUM_FACTS, libraryGates, requireArtist } from "./access";
import { DOCUMENT_BYTES, TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { ARTIST_ART_ALBUMS, artistArt, likedAmong, musicPresenter } from "./present";
import { pageRowsFor } from "./reads";

/**
 * What one artist of a list reads besides its library's grants: the artist, its library, and the
 * newest albums its artwork falls back to.
 */
const ARTIST_ROW_READS = 2 + ARTIST_ART_ALBUMS;

const ARTIST_ROW_BYTES =
  TABLE_BYTES.artists + DOCUMENT_BYTES.small + ARTIST_ART_ALBUMS * TABLE_BYTES.albums;

/** An artist's songs the top songs are taken from, as old music read them. */
const TOP_TRACKS_READ = 200;

/** Top songs an artist's page shows. */
const TOP_TRACKS = 10;

/** What one album of an artist's page reads: the album. Its library is the artist's. */
const ARTIST_ALBUM_READS = 1;

export const { list, get, albums } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const gates = libraryGates(ctx.db, reach, "view");

    const page = await paginateAtMost(
      ctx.db,
      { table: "artists", index: "by_key" },
      paginationOpts,
      pageRowsFor(reach, ARTIST_ROW_READS, ARTIST_ROW_BYTES),
    );

    const present = musicPresenter();

    const cards = await Promise.all(
      page.page.map(async (artist) => {
        if (artist.albumCount === 0) return [];

        const gate = await gates(artist.libraryId);

        return gate?.admits(ALBUM_FACTS) === true
          ? [await present.artist(artist, await artistArt(ctx.db, artist))]
          : [];
      }),
    );

    return { ...page, page: cards.flat() };
  },
  get: async (ctx, { artistId }, caller) => {
    const { row: artist, gate } = await requireArtist(
      ctx.db,
      await reachOf(ctx.db, caller),
      artistId,
    );

    const songs = await ctx.db
      .query("tracks")
      .withIndex("by_artist", (q) => q.eq("artistId", artist._id))
      .take(TOP_TRACKS_READ);

    const top = songs
      .filter((track) => !track.missing && gate.admits(trackFacts(track)))
      .slice(0, TOP_TRACKS);

    const liked = await likedAmong(
      ctx.db,
      caller.userId,
      top.map((track) => track._id),
    );

    const present = musicPresenter();

    return {
      artist: await present.artist(artist, await artistArt(ctx.db, artist)),
      topTracks: await Promise.all(
        top.map(async (track) => present.track(track, liked.has(track._id))),
      ),
    };
  },
  albums: async (ctx, { artistId, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const { row: artist } = await requireArtist(ctx.db, reach, artistId);

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "albums",
        index: "by_artist_year",
        range: (q) => q.eq("artistId", artist._id),
        order: "desc",
      },
      paginationOpts,
      pageRowsFor(reach, ARTIST_ALBUM_READS, TABLE_BYTES.albums),
    );

    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        page.page
          .filter((album) => album.trackCount > 0)
          .map(async (album) => present.album(album)),
      ),
    };
  },
});
