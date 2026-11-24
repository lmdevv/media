import { foldSearchText } from "@media/contracts/search-text";
import { v } from "convex/values";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { inOrder } from "../core/lib/inOrder";
import { withLibraryItems } from "../core/scans";
import { NO_COST, meterFrom } from "./budget";
import { keyOf, titleKeyOf } from "./fit";
import { artistCredit } from "./validators";
import { musicStore } from "./write";

/**
 * The stack suite's seam into artist credits (ADR 0024, "Artist credits"): a library's credit
 * rows and links as a test compares them, whether rechecks and rewrites are still running, and a
 * seed of rows as the release before credits wrote them, which a scan then adopts. The server
 * never calls it.
 */

/** Rows of each kind `state` reads at most. */
const STATE_ROWS = 500;

/** How many credit rechecks and rewrites are scheduled or running. */
export const work = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").order("desc").take(500);

    return scheduled.filter(
      (row) =>
        row.name.startsWith("music/credits") &&
        (row.state.kind === "pending" || row.state.kind === "inProgress"),
    ).length;
  },
});

const named = v.object({ id: v.string(), name: v.string() });

/** Links by what they link from, then the artist's name. */
const byText = <Row extends { readonly id: string; readonly name: string }>(
  rows: ReadonlyArray<Row>,
) =>
  rows.toSorted((left, right) =>
    left.id === right.id ? left.name.localeCompare(right.name) : left.id.localeCompare(right.id),
  );

/**
 * A library's artists, albums, tracks, credit strings, and links, up to 500 of each, in a stable
 * order, so a test compares what two scans left.
 */
export const state = internalQuery({
  args: { libraryId: v.id("libraries") },
  returns: v.object({
    artists: v.array(
      v.object({
        id: v.id("artists"),
        name: v.string(),
        albumCount: v.number(),
        trackCount: v.union(v.number(), v.null()),
      }),
    ),
    albums: v.array(
      v.object({
        id: v.id("albums"),
        title: v.string(),
        artistName: v.string(),
        artistId: v.id("artists"),
        artistKey: v.union(v.string(), v.null()),
        credits: v.union(v.array(artistCredit), v.null()),
        trackCount: v.number(),
      }),
    ),
    tracks: v.array(
      v.object({
        id: v.id("tracks"),
        path: v.string(),
        albumId: v.id("albums"),
        artistId: v.id("artists"),
        credits: v.union(v.array(artistCredit), v.null()),
        missing: v.boolean(),
      }),
    ),
    credits: v.array(
      v.object({ text: v.string(), uses: v.number(), artists: v.array(v.string()) }),
    ),
    parts: v.array(v.object({ part: v.string(), credit: v.string() })),
    songs: v.array(v.object({ credit: v.string(), trackId: v.id("tracks") })),
    trackLinks: v.array(named),
    albumLinks: v.array(named),
  }),
  handler: async (ctx, { libraryId }) => {
    const [artists, albums, tracks, credits, parts, songs] = await Promise.all([
      ctx.db
        .query("artists")
        .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
      ctx.db
        .query("albums")
        .withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
      ctx.db
        .query("tracks")
        .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
      ctx.db
        .query("artistCredits")
        .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
      ctx.db
        .query("creditParts")
        .withIndex("by_library_part", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
      ctx.db
        .query("creditTracks")
        .withIndex("by_library_credit", (q) => q.eq("libraryId", libraryId))
        .take(STATE_ROWS),
    ]);

    const names = new Map(artists.map((artist) => [artist._id, artist.name]));
    const nameOf = (artistId: Id<"artists">) => names.get(artistId) ?? `missing ${artistId}`;

    const trackLinks = await Promise.all(
      tracks.map(async (track) =>
        (
          await ctx.db
            .query("trackArtists")
            .withIndex("by_track", (q) => q.eq("trackId", track._id))
            .take(STATE_ROWS)
        ).map((link) => ({ id: track.path, name: nameOf(link.artistId) })),
      ),
    );

    const albumLinks = await Promise.all(
      albums.map(async (album) =>
        (
          await ctx.db
            .query("albumArtists")
            .withIndex("by_album", (q) => q.eq("albumId", album._id))
            .take(STATE_ROWS)
        ).map((link) => ({
          id: `${album.artistName} / ${album.title}`,
          name: nameOf(link.artistId),
        })),
      ),
    );

    return {
      artists: artists.map((artist) => ({
        id: artist._id,
        name: artist.name,
        albumCount: artist.albumCount,
        trackCount: artist.trackCount ?? null,
      })),
      albums: albums
        .map((album) => ({
          id: album._id,
          title: album.title,
          artistName: album.artistName,
          artistId: album.artistId,
          artistKey: album.artistKey ?? null,
          credits: album.credits ?? null,
          trackCount: album.trackCount,
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
      tracks: tracks.map((track) => ({
        id: track._id,
        path: track.path,
        albumId: track.albumId,
        artistId: track.artistId,
        credits: track.credits ?? null,
        missing: track.missing,
      })),
      credits: credits.map((credit) => ({
        text: credit.text,
        uses: credit.uses,
        artists: credit.artists,
      })),
      parts: parts.map((part) => ({ part: part.partKey, credit: part.creditKey })),
      songs: songs.map((song) => ({ credit: song.creditKey, trackId: song.trackId })),
      trackLinks: byText(trackLinks.flat()),
      albumLinks: byText(albumLinks.flat()),
    };
  },
});

const oldTrack = v.object({
  path: v.string(),
  title: v.string(),
  artist: v.string(),
  albumArtist: v.optional(v.string()),
  album: v.string(),
});

/**
 * Writes tracks into a music library as the release before artist credits did: each under one
 * artist, its album artist or else its artist, which its album files under too, with no credits,
 * links, or credit strings, and the counts and totals that release kept. A scan since then adopts
 * them.
 */
export const seedBeforeCredits = internalMutation({
  args: { libraryId: v.id("libraries"), tracks: v.array(oldTrack) },
  returns: v.array(v.id("tracks")),
  handler: async (ctx, { libraryId, tracks }) => {
    const store = musicStore(ctx.db, meterFrom(NO_COST));

    const filings = new Map<string, { readonly name: string; readonly albums: Set<string> }>();

    for (const track of tracks) {
      const name = track.albumArtist ?? track.artist;
      const filing = filings.get(keyOf(name)) ?? { name, albums: new Set<string>() };

      filing.albums.add(keyOf(track.album));
      filings.set(keyOf(name), filing);
    }

    const artistIds = new Map<string, Id<"artists">>();

    await inOrder([...filings], async ([key, filing]) => {
      const artist = await store.insertArtist({
        libraryId,
        name: filing.name,
        key,
        albumCount: filing.albums.size,
        artHash: null,
        searchText: foldSearchText(filing.name),
      });

      artistIds.set(key, artist._id);
    });

    const albumIds = new Map<string, Id<"albums">>();

    return withLibraryItems(ctx, libraryId, async () => {
      const trackIds = await inOrder(tracks, async (track) => {
        const filed = track.albumArtist ?? track.artist;
        const artistId = artistIds.get(keyOf(filed));

        if (artistId === undefined) throw new Error(`No artist for ${filed}`);

        const albumKey = `${keyOf(filed)}\u0000${keyOf(track.album)}`;

        const siblings = tracks.filter(
          (other) =>
            `${keyOf(other.albumArtist ?? other.artist)}\u0000${keyOf(other.album)}` === albumKey,
        );

        const albumId =
          albumIds.get(albumKey) ??
          (
            await store.insertAlbum({
              libraryId,
              artistId,
              artistName: filings.get(keyOf(filed))?.name ?? filed,
              title: track.album,
              key: keyOf(track.album),
              year: null,
              genre: null,
              artHash: null,
              trackCount: siblings.length,
              durationMs: siblings.length * 1000,
              format: "FLAC",
              addedAt: Date.now(),
              searchText: foldSearchText(`${track.album} ${filed}`),
            })
          )._id;

        albumIds.set(albumKey, albumId);

        return store.insertTrack(
          {
            libraryId,
            albumId,
            artistId,
            path: track.path,
            size: 1000,
            mtimeMs: 0,
            title: track.title,
            titleKey: titleKeyOf(track.title),
            artistName: track.artist,
            albumTitle: track.album,
            trackNumber: null,
            discNumber: null,
            durationMs: 1000,
            codec: "flac",
            lossless: true,
            bitrate: null,
            sampleRate: null,
            bitDepth: null,
            artHash: null,
            folderArt: null,
            lyricsFiles: "",
            lyricsReader: 1,
            lyricsBytes: null,
            lyricsHash: null,
            lyricsSynced: false,
            explicit: false,
            missing: false,
            searchText: foldSearchText(`${track.title} ${track.artist} ${track.album}`),
          },
          [],
        );
      });

      await store.moveTotals(libraryId, {
        albums: albumIds.size,
        artists: filings.size,
        durationMs: tracks.length * 1000,
      });

      return { value: [...trackIds], added: tracks.length, removed: 0 };
    });
  },
});
