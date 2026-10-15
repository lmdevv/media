import { foldSearchText } from "@music/commands/search-text";

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { canRead } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { libraryCounts } from "../lib/stats";
import { mergedPage, numberKey, textKey } from "../lib/pages";
import type { Source } from "../lib/pages";
import { makePresenter } from "../lib/present";
import type { QueryHandlers } from "./types";

const emptyPage = { items: [], cursor: "", done: true } as const;

/** Sorts album tracks by disc, then track number, then title. */
const byDiscAndNumber = (left: Doc<"tracks">, right: Doc<"tracks">): number =>
  (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
  (left.trackNumber ?? 0) - (right.trackNumber ?? 0) ||
  left.title.localeCompare(right.title);

/**
 * Keeps the rows of one page that the viewer may read. Lists read only readable libraries' index
 * ranges, so this drops only rows of a library deleted moments ago that its purge has not reached.
 */
const readable = <Row extends { readonly libraryId: Id<"libraries"> }>(
  viewer: Viewer,
  rows: ReadonlyArray<Row>,
): Array<Row> => rows.filter((row) => canRead(viewer, row.libraryId));

/**
 * The index ranges a list reads: one global range when the viewer reads every library, else one
 * range per library they read, merged by `mergedPage`. A member who reads a small shared library
 * then never pages through another user's large private one.
 */
const listScopes = (viewer: Viewer): ReadonlyArray<Id<"libraries"> | null> =>
  viewer.readsEveryLibrary ? [null] : [...viewer.libraryIds];

/** Albums with songs, newest first, from one library or all of them. */
const albumSource =
  (ctx: QueryCtx, libraryId: Id<"libraries"> | null): Source<Doc<"albums">> =>
  async ({ start, end }, limit) => {
    const startKey = start === null ? null : numberKey(start);
    const endKey = end === null ? null : numberKey(end);

    const query =
      libraryId === null
        ? ctx.db.query("albums").withIndex("by_added", (q) => {
            const lower = endKey === null ? q : q.gte("addedAt", endKey);

            return startKey === null ? lower : lower.lte("addedAt", startKey);
          })
        : ctx.db.query("albums").withIndex("by_library_added", (q) => {
            const scoped = q.eq("libraryId", libraryId);
            const lower = endKey === null ? scoped : scoped.gte("addedAt", endKey);

            return startKey === null ? lower : lower.lte("addedAt", startKey);
          });

    return query
      .order("desc")
      .filter((q) =>
        q.and(
          q.gt(q.field("trackCount"), 0),
          start === null || startKey === null
            ? true
            : q.or(q.lt(q.field("addedAt"), startKey), q.lt(q.field("_creationTime"), start.time)),
          end === null || endKey === null
            ? true
            : q.or(q.gt(q.field("addedAt"), endKey), q.gte(q.field("_creationTime"), end.time)),
        ),
      )
      .take(limit);
  };

/** Artists with albums, by name, from one library or all of them. */
const artistSource =
  (ctx: QueryCtx, libraryId: Id<"libraries"> | null): Source<Doc<"artists">> =>
  async ({ start, end }, limit) => {
    const startKey = start === null ? null : textKey(start);
    const endKey = end === null ? null : textKey(end);

    const query =
      libraryId === null
        ? ctx.db.query("artists").withIndex("by_key", (q) => {
            const lower = startKey === null ? q : q.gte("key", startKey);

            return endKey === null ? lower : lower.lte("key", endKey);
          })
        : ctx.db.query("artists").withIndex("by_library_key", (q) => {
            const scoped = q.eq("libraryId", libraryId);
            const lower = startKey === null ? scoped : scoped.gte("key", startKey);

            return endKey === null ? lower : lower.lte("key", endKey);
          });

    return query
      .filter((q) =>
        q.and(
          q.gt(q.field("albumCount"), 0),
          start === null || startKey === null
            ? true
            : q.or(q.gt(q.field("key"), startKey), q.gt(q.field("_creationTime"), start.time)),
          end === null || endKey === null
            ? true
            : q.or(q.lt(q.field("key"), endKey), q.lte(q.field("_creationTime"), end.time)),
        ),
      )
      .take(limit);
  };

/** Playable songs by title, from one library or all of them. */
const trackSource =
  (ctx: QueryCtx, libraryId: Id<"libraries"> | null): Source<Doc<"tracks">> =>
  async ({ start, end }, limit) => {
    const startKey = start === null ? null : textKey(start);
    const endKey = end === null ? null : textKey(end);

    const query =
      libraryId === null
        ? ctx.db.query("tracks").withIndex("by_title", (q) => {
            const scoped = q.eq("missing", false);
            const lower = startKey === null ? scoped : scoped.gte("titleKey", startKey);

            return endKey === null ? lower : lower.lte("titleKey", endKey);
          })
        : ctx.db.query("tracks").withIndex("by_library_title", (q) => {
            const scoped = q.eq("libraryId", libraryId).eq("missing", false);
            const lower = startKey === null ? scoped : scoped.gte("titleKey", startKey);

            return endKey === null ? lower : lower.lte("titleKey", endKey);
          });

    return query
      .filter((q) =>
        q.and(
          start === null || startKey === null
            ? true
            : q.or(q.gt(q.field("titleKey"), startKey), q.gt(q.field("_creationTime"), start.time)),
          end === null || endKey === null
            ? true
            : q.or(q.lt(q.field("titleKey"), endKey), q.lte(q.field("_creationTime"), end.time)),
        ),
      )
      .take(limit);
  };

const readableAlbums = (viewer: Viewer, albums: ReadonlyArray<Doc<"albums"> | null>) =>
  albums.filter(
    (album): album is Doc<"albums"> =>
      album !== null && album.trackCount > 0 && canRead(viewer, album.libraryId),
  );

export const libraryQueries = {
  "library.home": async (ctx, viewer) => {
    const present = makePresenter(ctx, viewer);
    const scopes = listScopes(viewer);

    // Newest albums over the readable libraries' indexes, as `albums.list` reads them.
    const recent = await mergedPage(
      scopes.map((libraryId) => albumSource(ctx, libraryId)),
      (album) => album.addedAt,
      "desc",
      { limit: 12 },
    );

    const recentlyAdded = readableAlbums(viewer, recent.items);

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

    const counts = await Promise.all(
      viewer.libraries.map((library) => libraryCounts(ctx, library)),
    );

    let tracks = 0;
    let albums = 0;
    let artists = 0;
    let durationMs = 0;

    for (const library of counts) {
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
    const scopes = listScopes(viewer);

    const page = await mergedPage(
      scopes.map((libraryId) => albumSource(ctx, libraryId)),
      (album) => album.addedAt,
      "desc",
      args,
    );

    return { ...page, items: await Promise.all(readable(viewer, page.items).map(present.album)) };
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
    const scopes = listScopes(viewer);

    const page = await mergedPage(
      scopes.map((libraryId) => artistSource(ctx, libraryId)),
      (artist) => artist.key,
      "asc",
      args,
    );

    return { ...page, items: await Promise.all(readable(viewer, page.items).map(present.artist)) };
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
    const scopes = listScopes(viewer);

    const page = await mergedPage(
      scopes.map((libraryId) => trackSource(ctx, libraryId)),
      (track) => track.titleKey,
      "asc",
      args,
    );

    return { ...page, items: await present.tracks(readable(viewer, page.items)) };
  },

  search: async (ctx, viewer, args) => {
    // Stored search text is folded, so the query must be too: "doppelganger" finds "Doppelgänger".
    const text = foldSearchText(args.query).trim();

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
          .withSearchIndex("search_text", (q) =>
            q.search("searchText", text).eq("libraryId", libraryId),
          )
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
