import type { Doc, Id } from "../_generated/dataModel";
import { canRead } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { makePresenter } from "../lib/present";
import type { QueryHandlers } from "./types";

const DEFAULT_PAGE = 50;

const emptyPage = { items: [], cursor: "", done: true } as const;

/** Sorts album tracks by disc, then track number, then title. */
const byDiscAndNumber = (left: Doc<"tracks">, right: Doc<"tracks">): number =>
  (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
  (left.trackNumber ?? 0) - (right.trackNumber ?? 0) ||
  left.title.localeCompare(right.title);

/**
 * Keeps the rows of one page that the viewer may read. Paginated queries filter by library here,
 * after `paginate`, rather than in the database query: Convex re-runs a subscribed page from its
 * recorded cursors, and a query whose filter lists the viewer's libraries changes shape whenever a
 * library is added or removed, which fails every open page with `InvalidCursor`. A page can come
 * back short or empty while `done` is false; clients keep loading until `done`.
 */
const readable = <Row extends { readonly libraryId: Id<"libraries"> }>(
  viewer: Viewer,
  rows: ReadonlyArray<Row>,
): Array<Row> => rows.filter((row) => canRead(viewer, row.libraryId));

const readableAlbums = (viewer: Viewer, albums: ReadonlyArray<Doc<"albums"> | null>) =>
  albums.filter(
    (album): album is Doc<"albums"> =>
      album !== null && album.trackCount > 0 && canRead(viewer, album.libraryId),
  );

export const libraryQueries = {
  "library.home": async (ctx, viewer) => {
    const present = makePresenter(ctx, viewer);
    const recent = await ctx.db.query("albums").withIndex("by_added").order("desc").take(200);
    const recentlyAdded = readableAlbums(viewer, recent).slice(0, 12);

    const plays = await ctx.db
      .query("history")
      .withIndex("by_user", (q) => q.eq("userId", viewer.id))
      .order("desc")
      .take(100);

    const playedAlbumIds: Array<Id<"albums">> = [];

    for (const play of plays) {
      if (!playedAlbumIds.includes(play.albumId)) playedAlbumIds.push(play.albumId);

      if (playedAlbumIds.length >= 12) break;
    }

    const played = readableAlbums(
      viewer,
      await Promise.all(playedAlbumIds.map((id) => ctx.db.get(id))),
    );

    const playedArtistIds = [...new Set(played.map((album) => album.artistId))].slice(0, 12);

    const playedArtists = (await Promise.all(playedArtistIds.map((id) => ctx.db.get(id)))).filter(
      (artist): artist is Doc<"artists"> => artist !== null,
    );

    let tracks = 0;
    let albums = 0;
    let artists = 0;
    let durationMs = 0;

    for (const library of viewer.libraries) {
      tracks += library.trackCount;
      albums += library.albumCount;
      artists += library.artistCount;
      durationMs += library.durationMs;
    }

    return {
      recentlyAdded: await Promise.all(recentlyAdded.map(present.album)),
      recentlyPlayed: await Promise.all(played.map(present.album)),
      recentlyPlayedArtists: await Promise.all(playedArtists.map(present.artist)),
      stats: { tracks, albums, artists, durationMs },
    };
  },

  "albums.list": async (ctx, viewer, args) => {
    if (viewer.libraryIds.size === 0) return emptyPage;
    const present = makePresenter(ctx, viewer);

    const page = await ctx.db
      .query("albums")
      .withIndex("by_added")
      .order("desc")
      .filter((q) => q.gt(q.field("trackCount"), 0))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? DEFAULT_PAGE });

    return {
      items: await Promise.all(readable(viewer, page.page).map(present.album)),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },

  "albums.get": async (ctx, viewer, args) => {
    const album = await ctx.db.get(tableId(ctx, "albums", args.albumId));

    if (album === null || !canRead(viewer, album.libraryId)) {
      return fail("not_found", "Album not found");
    }

    const present = makePresenter(ctx, viewer);

    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_album", (q) => q.eq("albumId", album._id))
      .collect();

    const playable = tracks.filter((track) => !track.missing).toSorted(byDiscAndNumber);

    return {
      album: await present.album(album),
      durationMs: album.durationMs,
      genre: album.genre ?? null,
      format: album.format,
      tracks: await present.tracks(playable),
    };
  },

  "artists.list": async (ctx, viewer, args) => {
    if (viewer.libraryIds.size === 0) return emptyPage;
    const present = makePresenter(ctx, viewer);

    const page = await ctx.db
      .query("artists")
      .withIndex("by_key")
      .filter((q) => q.gt(q.field("albumCount"), 0))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? DEFAULT_PAGE });

    return {
      items: await Promise.all(readable(viewer, page.page).map(present.artist)),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },

  "artists.get": async (ctx, viewer, args) => {
    const artist = await ctx.db.get(tableId(ctx, "artists", args.artistId));

    if (artist === null || !canRead(viewer, artist.libraryId)) {
      return fail("not_found", "Artist not found");
    }

    const present = makePresenter(ctx, viewer);

    const albums = await ctx.db
      .query("albums")
      .withIndex("by_artist", (q) => q.eq("artistId", artist._id))
      .collect();

    const visible = readableAlbums(viewer, albums).toSorted(
      (left, right) => (right.year ?? 0) - (left.year ?? 0),
    );

    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_artist", (q) => q.eq("artistId", artist._id))
      .take(200);

    const top = tracks.filter((track) => !track.missing).slice(0, 10);

    return {
      artist: await present.artist(artist),
      albums: await Promise.all(visible.map(present.album)),
      topTracks: await present.tracks(top),
    };
  },

  "tracks.list": async (ctx, viewer, args) => {
    if (viewer.libraryIds.size === 0) return emptyPage;
    const present = makePresenter(ctx, viewer);

    const page = await ctx.db
      .query("tracks")
      .withIndex("by_title", (q) => q.eq("missing", false))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit ?? DEFAULT_PAGE });

    return {
      items: await present.tracks(readable(viewer, page.page)),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },

  search: async (ctx, viewer, args) => {
    const text = args.query.trim();

    if (text.length === 0) return { tracks: [], albums: [], artists: [] };
    const limit = args.limit ?? 20;
    const present = makePresenter(ctx, viewer);
    const libraryIds = [...viewer.libraryIds];

    const perLibrary = await Promise.all(
      libraryIds.map(async (libraryId) => ({
        tracks: await ctx.db
          .query("tracks")
          .withSearchIndex("search_text", (q) =>
            q.search("searchText", text).eq("libraryId", libraryId).eq("missing", false),
          )
          .take(limit),
        albums: await ctx.db
          .query("albums")
          .withSearchIndex("search_text", (q) =>
            q.search("searchText", text).eq("libraryId", libraryId),
          )
          .take(limit),
        artists: await ctx.db
          .query("artists")
          .withSearchIndex("search_name", (q) => q.search("name", text).eq("libraryId", libraryId))
          .take(limit),
      })),
    );

    const tracks = perLibrary.flatMap((result) => result.tracks);
    const albums = perLibrary.flatMap((result) => result.albums);
    const artists = perLibrary.flatMap((result) => result.artists);

    return {
      tracks: await present.tracks(tracks.slice(0, limit)),
      albums: await Promise.all(
        albums
          .filter((album) => album.trackCount > 0)
          .slice(0, limit)
          .map(present.album),
      ),
      artists: await Promise.all(
        artists
          .filter((artist) => artist.albumCount > 0)
          .slice(0, limit)
          .map(present.artist),
      ),
    };
  },
} satisfies Partial<QueryHandlers>;
