import { register } from "../../commands/music/artists";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { paginateAtMost } from "../core/lib/paginate";
import { reachOf } from "../core/permissions/grants";
import { ALBUM_FACTS, requireArtist } from "./access";
import { TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import { libraryPage } from "./merged";
import { phasedPage } from "./phased";
import type { LibraryList } from "./merged";
import {
  ARTIST_ART_ALBUMS,
  ARTIST_ART_READS,
  artistArt,
  likedAmong,
  musicPresenter,
} from "./present";
import { TRACK_ROW_BYTES, pageRowsFor } from "./reads";

/** What one artist of a list reads besides its library's grants: the artist and its library. */
const ARTIST_ROW_READS = 2;

/** Links to an artist's songs the top songs read. */
const TOP_TRACKS_READ = 200;

/** Songs a release before credits filed under an artist that the top songs read. */
const TOP_TRACKS_BEFORE = 100;

/** Top songs an artist's page shows. */
const TOP_TRACKS = 10;

/** Songs the top songs read at a time, until the page has enough. */
const TOP_TRACKS_CHUNK = 20;

/** What one album of an artist's page reads: its link and the album. Its library is the artist's. */
const ARTIST_ALBUM_READS = 2;

/** What one song of an artist's songs reads: its link, the song, and whether the caller likes it. */
const ARTIST_TRACK_READS = 3;

/**
 * Artists by name, in one library (`by_library_key`) or in every one (`by_key`). An artist that no
 * album or song on disk credits does not show.
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
  shows: (artist, gate) =>
    (artist.albumCount > 0 || (artist.trackCount ?? 0) > 0) && gate.admits(ALBUM_FACTS),
  // The albums an artist's artwork falls back to (`artistArt`).
  shown: ARTIST_ART_READS,
  rowReads: ARTIST_ROW_READS + 3 * ARTIST_ART_ALBUMS,
});

export const { list, get, albums, tracks } = register({
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

    const [links, before] = await Promise.all([
      ctx.db
        .query("trackArtists")
        .withIndex("by_artist_title", (q) => q.eq("artistId", artist._id))
        .take(TOP_TRACKS_READ),
      ctx.db
        .query("tracks")
        .withIndex("by_artist", (q) => q.eq("artistId", artist._id).eq("tagsReader", undefined))
        .take(TOP_TRACKS_BEFORE),
    ]);

    const shows = (track: Doc<"tracks"> | null): track is Doc<"tracks"> =>
      track !== null && !track.missing && gate.admits(trackFacts(track));

    const shownFrom = async (
      from: number,
      found: ReadonlyArray<Doc<"tracks">>,
    ): Promise<ReadonlyArray<Doc<"tracks">>> => {
      if (from >= links.length || found.length >= TOP_TRACKS) return found;

      const songs = await Promise.all(
        links.slice(from, from + TOP_TRACKS_CHUNK).map(async (link) => ctx.db.get(link.trackId)),
      );

      return shownFrom(from + TOP_TRACKS_CHUNK, [...found, ...songs.filter(shows)]);
    };

    const linked = await shownFrom(0, []);

    const top = [...linked, ...before.filter(shows)]
      .toSorted((left, right) =>
        left.titleKey === right.titleKey
          ? left.tie.localeCompare(right.tie)
          : left.titleKey < right.titleKey
            ? -1
            : 1,
      )
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
    const rows = pageRowsFor(reach, ARTIST_ALBUM_READS, TABLE_BYTES.albums);

    const page = await phasedPage<Doc<"albums">>(
      paginationOpts,
      async (options) => {
        const found = await paginateAtMost(
          ctx.db,
          {
            table: "albumArtists",
            index: "by_artist_year",
            range: (q) => q.eq("artistId", artist._id),
            order: "desc",
          },
          options,
          rows,
        );

        const listed = await Promise.all(found.page.map(async (link) => ctx.db.get(link.albumId)));

        return { ...found, page: listed.filter((album) => album !== null) };
      },
      async (options) =>
        paginateAtMost(
          ctx.db,
          {
            table: "albums",
            index: "by_artist_year",
            range: (q) => q.eq("artistId", artist._id).eq("artistKey", undefined),
            order: "desc",
          },
          options,
          rows,
        ),
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
  tracks: async (ctx, { artistId, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const { row: artist, gate } = await requireArtist(ctx.db, reach, artistId);
    const rows = pageRowsFor(reach, ARTIST_TRACK_READS, TRACK_ROW_BYTES);

    const page = await phasedPage<Doc<"tracks">>(
      paginationOpts,
      async (options) => {
        const found = await paginateAtMost(
          ctx.db,
          {
            table: "trackArtists",
            index: "by_artist_title",
            range: (q) => q.eq("artistId", artist._id),
          },
          options,
          rows,
        );

        const listed = await Promise.all(found.page.map(async (link) => ctx.db.get(link.trackId)));

        return { ...found, page: listed.filter((track) => track !== null) };
      },
      async (options) =>
        paginateAtMost(
          ctx.db,
          {
            table: "tracks",
            index: "by_artist",
            range: (q) => q.eq("artistId", artist._id).eq("tagsReader", undefined),
          },
          options,
          rows,
        ),
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
