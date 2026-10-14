import { foldSearchText } from "@music/commands/search-text";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Tags read from one file by the media service. */
export interface ScannedTrack {
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

/** The art of the first playable track in `tracks` other than `except` that has some. */
const firstArtOf = async (
  tracks: AsyncIterable<Doc<"tracks">>,
  except: Id<"tracks"> | undefined,
): Promise<string | undefined> => {
  for await (const track of tracks) {
    if (track._id !== except && !track.missing && track.artHash !== undefined) {
      return track.artHash;
    }
  }

  return undefined;
};

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

const bumpLibrary = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  delta: { tracks?: number; albums?: number; artists?: number; durationMs?: number },
): Promise<void> => {
  const library = await ctx.db.get(libraryId);

  if (library === null) return;
  await ctx.db.patch(libraryId, {
    trackCount: Math.max(0, library.trackCount + (delta.tracks ?? 0)),
    albumCount: Math.max(0, library.albumCount + (delta.albums ?? 0)),
    artistCount: Math.max(0, library.artistCount + (delta.artists ?? 0)),
    durationMs: Math.max(0, library.durationMs + (delta.durationMs ?? 0)),
  });
};

/**
 * Applies a change in an album's playable tracks and keeps album, artist, and library counts in
 * step. An album with no playable tracks is hidden, so crossing zero changes the parent counts.
 */
export const adjustAlbum = async (
  ctx: MutationCtx,
  albumId: Id<"albums">,
  tracks: number,
  durationMs: number,
): Promise<void> => {
  const album = await ctx.db.get(albumId);

  if (album === null) return;
  const trackCount = Math.max(0, album.trackCount + tracks);
  await ctx.db.patch(albumId, {
    trackCount,
    durationMs: Math.max(0, album.durationMs + durationMs),
  });
  await bumpLibrary(ctx, album.libraryId, { tracks, durationMs });
  const appeared = album.trackCount === 0 && trackCount > 0;
  const vanished = album.trackCount > 0 && trackCount === 0;

  if (!appeared && !vanished) return;

  // A retag can move an album's last song elsewhere; check it once this write commits.
  if (vanished) {
    await ctx.scheduler.runAfter(0, internal.maintenance.pruneEmptyAlbum, { albumId });
  }

  const step = appeared ? 1 : -1;
  const artist = await ctx.db.get(album.artistId);

  if (artist === null) return;
  const albumCount = Math.max(0, artist.albumCount + step);
  await ctx.db.patch(artist._id, { albumCount });

  const artistStep =
    artist.albumCount === 0 && albumCount > 0
      ? 1
      : artist.albumCount > 0 && albumCount === 0
        ? -1
        : 0;

  await bumpLibrary(ctx, album.libraryId, { albums: step, artists: artistStep });
};

const findOrCreateArtist = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  name: string,
  art: ArtChange,
): Promise<Doc<"artists">> => {
  const artHash = art.next;
  const key = keyOf(name);

  const existing = await ctx.db
    .query("artists")
    .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId).eq("key", key))
    .unique();

  if (existing !== null) {
    const kept = await keptArt(existing.artHash, art, () =>
      firstArtOf(
        ctx.db.query("tracks").withIndex("by_artist", (q) => q.eq("artistId", existing._id)),
        art.track?._id,
      ),
    );

    if (kept !== existing.artHash) await ctx.db.patch(existing._id, { artHash: kept });

    return existing;
  }

  const id = await ctx.db.insert("artists", {
    libraryId,
    name,
    key,
    albumCount: 0,
    artHash,
    searchText: artistSearchText({ name }),
  });

  const created = await ctx.db.get(id);

  if (created === null) throw new Error("Artist vanished right after insert");

  return created;
};

const findOrCreateAlbum = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  artist: Doc<"artists">,
  track: ScannedTrack,
  art: ArtChange,
): Promise<Doc<"albums">> => {
  const key = keyOf(track.album);

  const existing = await ctx.db
    .query("albums")
    .withIndex("by_library_artist_key", (q) =>
      q.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", key),
    )
    .unique();

  if (existing !== null) {
    const artHash = await keptArt(existing.artHash, art, () =>
      firstArtOf(
        ctx.db.query("tracks").withIndex("by_album", (q) => q.eq("albumId", existing._id)),
        art.track?._id,
      ),
    );

    if (
      artHash !== existing.artHash ||
      (existing.year === undefined && track.year !== undefined) ||
      (existing.genre === undefined && track.genre !== undefined)
    ) {
      await ctx.db.patch(existing._id, {
        artHash,
        year: existing.year ?? track.year,
        genre: existing.genre ?? track.genre,
      });
    }

    return existing;
  }

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

  return created;
};

/**
 * Inserts or updates one scanned file and its album and artist. An album or artist whose art
 * came from this file's old art follows a replaced or removed cover (see `keptArt`).
 */
export const upsertScannedTrack = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  scanned: ScannedTrack,
): Promise<void> => {
  const existing = await ctx.db
    .query("tracks")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", scanned.path))
    .unique();

  const art: ArtChange = {
    track: existing,
    next: scanned.artHash,
    coverChanged: existing !== null && existing.folderArt !== scanned.folderArt,
  };

  const artist = await findOrCreateArtist(
    ctx,
    libraryId,
    scanned.albumArtist ?? scanned.artist,
    art,
  );

  const album = await findOrCreateAlbum(ctx, libraryId, artist, scanned, art);

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
    missing: false,
    searchText: trackSearchText({
      title: scanned.title,
      artistName: scanned.artist,
      albumTitle: scanned.album,
    }),
  };

  if (existing === null) {
    await ctx.db.insert("tracks", fields);
    await adjustAlbum(ctx, album._id, 1, scanned.durationMs);

    return;
  }

  await ctx.db.patch(existing._id, fields);

  // Still in the same album: only the length changes, so the album never looks empty midway.
  if (!existing.missing && existing.albumId === album._id) {
    await adjustAlbum(ctx, album._id, 0, scanned.durationMs - existing.durationMs);

    return;
  }

  if (!existing.missing) await adjustAlbum(ctx, existing.albumId, -1, -existing.durationMs);
  await adjustAlbum(ctx, album._id, 1, scanned.durationMs);
};

/**
 * Moves the track at `from` to the scanned file's path and updates it like `upsertScannedTrack`,
 * keeping its ID, so its likes, plays, playlist entries, and queue places follow the file. A
 * missing track at `from` comes back. When there is no track at `from`, or another track already
 * has the new path, the file is upserted as usual and `from` is marked missing instead.
 *
 * @returns Whether the track at `from` moved.
 */
export const moveScannedTrack = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  from: string,
  scanned: ScannedTrack,
): Promise<boolean> => {
  const byPath = (path: string) =>
    ctx.db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
      .unique();

  const [source, occupied] = await Promise.all([byPath(from), byPath(scanned.path)]);

  if (source === null || occupied !== null || from === scanned.path) {
    if (from !== scanned.path) await markTrackMissing(ctx, libraryId, from);
    await upsertScannedTrack(ctx, libraryId, scanned);

    return false;
  }

  await ctx.db.patch(source._id, { path: scanned.path });
  await upsertScannedTrack(ctx, libraryId, scanned);

  return true;
};

/** Hides a file that disappeared from disk. Likes and playlists keep pointing at it. */
export const markTrackMissing = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  path: string,
): Promise<void> => {
  const track = await ctx.db
    .query("tracks")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
    .unique();

  if (track === null || track.missing) return;
  await ctx.db.patch(track._id, { missing: true });
  await adjustAlbum(ctx, track.albumId, -1, -track.durationMs);
};
