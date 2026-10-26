import { foldSearchText } from "@music/commands/search-text";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { repointAlbumPins } from "./downloads";
import { lyricsFieldsOf, replaceLocalLyrics, type ScannedLyrics } from "./lyrics";
import { bumpLibraryCounts } from "./stats";
import { inOrder } from "./sequence";

/** Tags read from one file by the media service, and the lyrics beside and inside it. */
export interface ScannedTrack extends ScannedLyrics {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly title: string;
  readonly artist: string;
  readonly albumArtist?: string | undefined;
  readonly album: string;
  readonly trackNumber?: number | undefined;
  readonly discNumber?: number | undefined;
  readonly year?: number | undefined;
  readonly genre?: string | undefined;
  readonly durationMs: number;
  readonly codec: string;
  readonly lossless: boolean;
  readonly bitrate?: number | undefined;
  readonly sampleRate?: number | undefined;
  readonly bitDepth?: number | undefined;
  readonly artHash?: string | undefined;
  /** The folder artwork file the scan saw beside the file, as `path:size:mtime`. */
  readonly folderArt?: string | undefined;
}

/** How one upsert changes a track's artwork. */
interface ArtChange {
  /** The track as stored before the upsert, or null for a new one. */
  readonly track: Doc<"tracks"> | null;
  /** The art the scan found for it. */
  readonly next: string | undefined;
  /** The folder cover beside it was replaced, added, or removed since the last scan. */
  readonly coverChanged: boolean;
}

/**
 * The artwork an album or artist keeps when one of its tracks changes art. One that has none
 * takes the track's. One whose art is the track's old art takes the new art when the folder cover
 * was replaced (every song of the folder follows), and when the track lost its art, the art
 * of another of its tracks, or none. A new embedded picture on a single track leaves it alone.
 */
const keptArt = async (
  current: string | undefined,
  change: ArtChange,
  otherTracksArt: () => Promise<string | undefined>,
): Promise<string | undefined> => {
  const previous = change.track?.artHash;

  if (current === undefined) return change.next;

  if (previous === undefined || current !== previous || change.next === previous) return current;

  if (change.next === undefined) return otherTracksArt();

  return change.coverChanged ? change.next : current;
};

/**
 * The art of a playable track other than `except` that has some, from an index range of playable
 * tracks with art (`by_album_art` or `by_artist_art`): two reads at most, however many songs the
 * album or artist has.
 */
const firstArtOf = async (
  tracks: Promise<ReadonlyArray<Doc<"tracks">>>,
  except: Id<"tracks"> | undefined,
): Promise<string | undefined> => (await tracks).find((track) => track._id !== except)?.artHash;

const keyOf = (value: string): string => value.trim().toLowerCase();

/** What the artist search index matches: the name, folded. */
export const artistSearchText = (artist: Pick<Doc<"artists">, "name">): string =>
  foldSearchText(artist.name);

/** What the album search index matches: title and album artist, folded. */
export const albumSearchText = (album: Pick<Doc<"albums">, "title" | "artistName">): string =>
  foldSearchText(`${album.title} ${album.artistName}`);

/** What the track search index matches: title, artist, and album, folded. */
export const trackSearchText = (
  track: Pick<Doc<"tracks">, "title" | "artistName" | "albumTitle">,
): string => foldSearchText(`${track.title} ${track.artistName} ${track.albumTitle}`);

/** A short format label such as `FLAC 24/96` or `MP3 320`. */
export const formatLabel = (track: ScannedTrack): string => {
  const codec = track.codec.toUpperCase();

  if (track.lossless && track.bitDepth !== undefined && track.sampleRate !== undefined) {
    return `${codec} ${track.bitDepth}/${Math.round(track.sampleRate / 100) / 10}`;
  }

  if (track.bitrate !== undefined) return `${codec} ${Math.round(track.bitrate / 1000)}`;

  return codec;
};

/** A change in an album's playable songs and their length. */
interface AlbumDelta {
  readonly tracks: number;
  readonly durationMs: number;
}

/**
 * The catalog writes of one `media:*` mutation in one library. Songs of a batch mostly share
 * albums and artists, so it reads each album and artist once and keeps it, and it sums the count
 * changes and applies them in `finish`, writing each album, artist, and the library's counters at
 * most once per batch instead of once per song.
 */
export interface CatalogBatch {
  /**
   * Inserts or updates one scanned file, its album and artist, and its own lyrics. An album or
   * artist whose art came from this file's old art follows a replaced or removed cover (see
   * `keptArt`).
   */
  readonly upsert: (scanned: ScannedTrack) => Promise<void>;
  /**
   * Moves the track at `from` to the scanned file's path and updates it like `upsert`, keeping
   * its ID, so its likes, plays, playlist entries, and queue places follow the file. A missing
   * track at `from` comes back. When there is no track at `from`, or another track already has
   * the new path, the file is upserted as usual and `from` is marked missing instead.
   *
   * @returns Whether the track at `from` moved.
   */
  readonly move: (from: string, scanned: ScannedTrack) => Promise<boolean>;
  /** Hides a file that disappeared from disk. Likes and playlists keep pointing at it. */
  readonly markMissing: (path: string) => Promise<void>;
  /**
   * Applies the batch's count changes: album, artist, and library counters. An album left with
   * no playable songs that no song points at any more is deleted (see `deleteEmptyAlbum`).
   *
   * @returns The artwork hashes some track, album, or artist stopped using in this batch. Others
   *   may still use them; the media service asks `media:artInUse` before deleting any.
   */
  readonly finish: () => Promise<ReadonlyArray<string>>;
}

/** Starts the catalog writes of one mutation in `libraryId`. Call `finish` once at the end. */
export const catalogBatch = (ctx: MutationCtx, libraryId: Id<"libraries">): CatalogBatch => {
  const artists = new Map<string, Doc<"artists">>();
  const albums = new Map<string, Doc<"albums">>();
  const deltas = new Map<Id<"albums">, AlbumDelta>();
  const released = new Set<string>();
  /** For each album songs left in this batch, how many went to each other album. */
  const moves = new Map<Id<"albums">, Map<Id<"albums">, number>>();

  const noteMove = (from: Id<"albums">, to: Id<"albums">): void => {
    const counts = moves.get(from) ?? new Map<Id<"albums">, number>();

    counts.set(to, (counts.get(to) ?? 0) + 1);
    moves.set(from, counts);
  };

  /**
   * The album that took the most of `albumId`'s songs in this batch, the first one on a tie, or
   * none when no song left it. An album re-tagged across two batches is judged by the moves of
   * the batch that emptied it.
   */
  const successorOf = (albumId: Id<"albums">): Id<"albums"> | undefined =>
    [...(moves.get(albumId) ?? [])].toSorted(([, left], [, right]) => right - left)[0]?.[0];

  const release = (previous: string | undefined, next: string | undefined): void => {
    if (previous !== undefined && previous !== next) released.add(previous);
  };

  const adjust = (albumId: Id<"albums">, tracks: number, durationMs: number): void => {
    if (tracks === 0 && durationMs === 0) return;
    const previous = deltas.get(albumId) ?? { tracks: 0, durationMs: 0 };

    deltas.set(albumId, {
      tracks: previous.tracks + tracks,
      durationMs: previous.durationMs + durationMs,
    });
  };

  const trackAt = (path: string) =>
    ctx.db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
      .unique();

  const artistFor = async (name: string, art: ArtChange): Promise<Doc<"artists">> => {
    const key = keyOf(name);

    const existing =
      artists.get(key) ??
      (await ctx.db
        .query("artists")
        .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId).eq("key", key))
        .unique());

    if (existing === null) {
      const id = await ctx.db.insert("artists", {
        libraryId,
        name,
        key,
        albumCount: 0,
        artHash: art.next,
        searchText: artistSearchText({ name }),
      });

      const created = await ctx.db.get(id);

      if (created === null) throw new Error("Artist vanished right after insert");
      artists.set(key, created);

      return created;
    }

    const kept = await keptArt(existing.artHash, art, () =>
      firstArtOf(
        ctx.db
          .query("tracks")
          .withIndex("by_artist_art", (q) =>
            q.eq("artistId", existing._id).eq("missing", false).gt("artHash", ""),
          )
          .take(2),
        art.track?._id,
      ),
    );

    if (kept === existing.artHash) {
      artists.set(key, existing);

      return existing;
    }

    await ctx.db.patch(existing._id, { artHash: kept });
    release(existing.artHash, kept);
    const updated = { ...existing, artHash: kept };
    artists.set(key, updated);

    return updated;
  };

  const albumFor = async (
    artist: Doc<"artists">,
    track: ScannedTrack,
    art: ArtChange,
  ): Promise<Doc<"albums">> => {
    const key = keyOf(track.album);
    const cacheKey = `${artist._id}:${key}`;

    const existing =
      albums.get(cacheKey) ??
      (await ctx.db
        .query("albums")
        .withIndex("by_library_artist_key", (q) =>
          q.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", key),
        )
        .unique());

    if (existing === null) {
      const id = await ctx.db.insert("albums", {
        libraryId,
        artistId: artist._id,
        artistName: artist.name,
        title: track.album,
        key,
        year: track.year,
        genre: track.genre,
        artHash: track.artHash,
        trackCount: 0,
        durationMs: 0,
        format: formatLabel(track),
        addedAt: Date.now(),
        searchText: albumSearchText({ title: track.album, artistName: artist.name }),
      });

      const created = await ctx.db.get(id);

      if (created === null) throw new Error("Album vanished right after insert");
      albums.set(cacheKey, created);

      return created;
    }

    const artHash = await keptArt(existing.artHash, art, () =>
      firstArtOf(
        ctx.db
          .query("tracks")
          .withIndex("by_album_art", (q) =>
            q.eq("albumId", existing._id).eq("missing", false).gt("artHash", ""),
          )
          .take(2),
        art.track?._id,
      ),
    );

    const changes = {
      artHash,
      year: existing.year ?? track.year,
      genre: existing.genre ?? track.genre,
    };

    if (
      changes.artHash === existing.artHash &&
      changes.year === existing.year &&
      changes.genre === existing.genre
    ) {
      albums.set(cacheKey, existing);

      return existing;
    }

    await ctx.db.patch(existing._id, changes);
    release(existing.artHash, artHash);
    const updated = { ...existing, ...changes };
    albums.set(cacheKey, updated);

    return updated;
  };

  const upsert = async (scanned: ScannedTrack): Promise<void> => {
    const existing = await trackAt(scanned.path);

    const art: ArtChange = {
      track: existing,
      next: scanned.artHash,
      coverChanged: existing !== null && existing.folderArt !== scanned.folderArt,
    };

    const artist = await artistFor(scanned.albumArtist ?? scanned.artist, art);
    const album = await albumFor(artist, scanned, art);

    const fields = {
      libraryId,
      albumId: album._id,
      artistId: artist._id,
      path: scanned.path,
      size: scanned.size,
      mtimeMs: scanned.mtimeMs,
      title: scanned.title,
      titleKey: keyOf(scanned.title),
      artistName: scanned.artist,
      albumTitle: scanned.album,
      trackNumber: scanned.trackNumber,
      discNumber: scanned.discNumber,
      durationMs: scanned.durationMs,
      codec: scanned.codec,
      lossless: scanned.lossless,
      bitrate: scanned.bitrate,
      sampleRate: scanned.sampleRate,
      bitDepth: scanned.bitDepth,
      artHash: scanned.artHash,
      folderArt: scanned.folderArt,
      ...lyricsFieldsOf(scanned),
      missing: false,
      searchText: trackSearchText({
        title: scanned.title,
        artistName: scanned.artist,
        albumTitle: scanned.album,
      }),
    };

    if (existing === null) {
      const id = await ctx.db.insert("tracks", fields);
      await replaceLocalLyrics(ctx, id, scanned.lyrics);
      adjust(album._id, 1, scanned.durationMs);

      return;
    }

    await ctx.db.patch(existing._id, fields);
    await replaceLocalLyrics(ctx, existing._id, scanned.lyrics);
    release(existing.artHash, scanned.artHash);

    // Still in the same album: only the length changes, so the album never looks empty midway.
    if (!existing.missing && existing.albumId === album._id) {
      adjust(album._id, 0, scanned.durationMs - existing.durationMs);

      return;
    }

    if (existing.albumId !== album._id) noteMove(existing.albumId, album._id);

    if (!existing.missing) adjust(existing.albumId, -1, -existing.durationMs);
    adjust(album._id, 1, scanned.durationMs);
  };

  const markMissing = async (path: string): Promise<void> => {
    const track = await trackAt(path);

    if (track === null || track.missing) return;
    await ctx.db.patch(track._id, { missing: true });
    adjust(track.albumId, -1, -track.durationMs);
  };

  const move = async (from: string, scanned: ScannedTrack): Promise<boolean> => {
    const [source, occupied] = await Promise.all([trackAt(from), trackAt(scanned.path)]);

    if (source === null || occupied !== null || from === scanned.path) {
      if (from !== scanned.path) await markMissing(from);
      await upsert(scanned);

      return false;
    }

    await ctx.db.patch(source._id, { path: scanned.path });
    await upsert(scanned);

    return true;
  };

  const finish = async (): Promise<ReadonlyArray<string>> => {
    const library = { tracks: 0, albums: 0, artists: 0, durationMs: 0 };
    const artistSteps = new Map<Id<"artists">, number>();
    const vanished: Array<Id<"albums">> = [];

    // Albums are independent; their artists' counts are summed here and written below.
    await Promise.all(
      [...deltas].map(async ([albumId, delta]) => {
        const album = await ctx.db.get(albumId);

        if (album === null) return;
        const trackCount = Math.max(0, album.trackCount + delta.tracks);
        await ctx.db.patch(albumId, {
          trackCount,
          durationMs: Math.max(0, album.durationMs + delta.durationMs),
        });
        library.tracks += delta.tracks;
        library.durationMs += delta.durationMs;
        const appeared = album.trackCount === 0 && trackCount > 0;

        if (!appeared && !(album.trackCount > 0 && trackCount === 0)) return;

        if (!appeared) vanished.push(albumId);
        const step = appeared ? 1 : -1;
        library.albums += step;
        artistSteps.set(album.artistId, (artistSteps.get(album.artistId) ?? 0) + step);
      }),
    );

    await Promise.all(
      [...artistSteps].map(async ([artistId, step]) => {
        const artist = step === 0 ? null : await ctx.db.get(artistId);

        if (artist === null) return;
        const albumCount = Math.max(0, artist.albumCount + step);
        await ctx.db.patch(artist._id, { albumCount });

        if (artist.albumCount === 0 && albumCount > 0) library.artists += 1;

        if (artist.albumCount > 0 && albumCount === 0) library.artists -= 1;
      }),
    );

    if (
      library.tracks !== 0 ||
      library.albums !== 0 ||
      library.artists !== 0 ||
      library.durationMs !== 0
    ) {
      await bumpLibraryCounts(ctx, libraryId, library);
    }

    // Every write of the batch is done, so an album no song points at any more (a retag moved its
    // songs) goes now, and its art is released only once no row holds it. Its downloads follow
    // its songs. One after another: two albums of one artist may both be its last.
    await inOrder(vanished, async (albumId) => {
      for (const hash of await deleteEmptyAlbum(ctx, albumId)) release(hash, undefined);
      const successor = successorOf(albumId);

      if (successor !== undefined && (await ctx.db.get(albumId)) === null) {
        await repointAlbumPins(ctx, albumId, successor);
      }
    });

    return [...released];
  };

  return { upsert, move, markMissing, finish };
};

/**
 * Deletes an album without playable songs once no song points at it any more, as after a retag
 * moved its songs to another album, and then its artist if nothing points at that either. An
 * album whose songs are only missing keeps its row, so the songs find it again when their files
 * come back.
 *
 * @returns The artwork the deleted album and artist held.
 */
export const deleteEmptyAlbum = async (
  ctx: MutationCtx,
  albumId: Id<"albums">,
): Promise<ReadonlyArray<string>> => {
  const album = await ctx.db.get(albumId);

  if (album === null || album.trackCount > 0) return [];

  const song = await ctx.db
    .query("tracks")
    .withIndex("by_album", (q) => q.eq("albumId", album._id))
    .first();

  if (song !== null) return [];
  await ctx.db.delete(album._id);
  const held = album.artHash === undefined ? [] : [album.artHash];
  const artist = await ctx.db.get(album.artistId);

  if (artist === null || artist.albumCount > 0) return held;

  const [otherAlbum, otherSong] = await Promise.all([
    ctx.db
      .query("albums")
      .withIndex("by_artist", (q) => q.eq("artistId", artist._id))
      .first(),
    ctx.db
      .query("tracks")
      .withIndex("by_artist", (q) => q.eq("artistId", artist._id))
      .first(),
  ]);

  if (otherAlbum !== null || otherSong !== null) return held;
  await ctx.db.delete(artist._id);

  return artist.artHash === undefined ? held : [...held, artist.artHash];
};
