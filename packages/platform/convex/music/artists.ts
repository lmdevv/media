import { register } from "../../commands/music/artists";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { ALBUM_FACTS, requireArtist } from "./access";
import { TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { libraryPage } from "./merged";
import type { LibraryList } from "./merged";
import { ARTIST_ART_ALBUMS, artistArt, likedAmong, musicPresenter } from "./present";
import { pageRowsFor, rowsOf } from "./reads";

/** What one artist of a list reads besides its library's grants: the artist and its library. */
const ARTIST_ROW_READS = 2;

/** An artist's songs the top songs are taken from, as old music read them. */
const TOP_TRACKS_READ = 200;

/** Top songs an artist's page shows. */
const TOP_TRACKS = 10;

/** What one album of an artist's page reads: the album. Its library is the artist's. */
const ARTIST_ALBUM_READS = 1;

/**
 * Artists by name, in one library (`by_library_key`) or in every one (`by_key`). An artist with no
 * album on disk does not show.
 */
const byName = (db: DatabaseReader): LibraryList<Doc<"artists">, string> => ({
  order: "asc",
  key: (artist) => artist.key,
  keyFrom: (text) => text,
  rowBytes: TABLE_BYTES.artists,
  inLibrary: (libraryId: Id<"libraries">) => ({
    atKey: async (key, tie, count) =>
      db
        .query("artists")
        .withIndex("by_library_key", (q) =>
          q.eq("libraryId", libraryId).eq("key", key).gt("tie", tie),
        )
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("artists")
        .withIndex("by_library_key", (q) => {
          const inIt = q.eq("libraryId", libraryId);

          return key === null ? inIt : inIt.gt("key", key);
        })
        .take(count),
  }),
  everywhere: {
    atKey: async (key, tie, count) =>
      db
        .query("artists")
        .withIndex("by_key", (q) => q.eq("key", key).gt("tie", tie))
        .take(count),
    pastKey: async (key, count) =>
      db
        .query("artists")
        .withIndex("by_key", (q) => (key === null ? q : q.gt("key", key)))
        .take(count),
  },
  shows: (artist, gate) => artist.albumCount > 0 && gate.admits(ALBUM_FACTS),
  // The newest albums an artist's artwork falls back to (`artistArt`).
  shown: rowsOf("albums", ARTIST_ART_ALBUMS),
  rowReads: ARTIST_ROW_READS + ARTIST_ART_ALBUMS,
});

export const { list, get, albums } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const page = await libraryPage(ctx.db, reach, byName(ctx.db), paginationOpts);
    const present = musicPresenter();

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (artist) => present.artist(artist, await artistArt(ctx.db, artist))),
      ),
    };
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
