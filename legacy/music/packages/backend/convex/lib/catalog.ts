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
}

const keyOf = (value: string): string => value.trim().toLowerCase();

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
  artHash: string | undefined,
): Promise<Doc<"artists">> => {
  const key = keyOf(name);

  const existing = await ctx.db
    .query("artists")
    .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId).eq("key", key))
    .unique();

  if (existing !== null) {
    if (existing.artHash === undefined && artHash !== undefined) {
      await ctx.db.patch(existing._id, { artHash });
    }

    return existing;
  }

  const id = await ctx.db.insert("artists", { libraryId, name, key, albumCount: 0, artHash });
  const created = await ctx.db.get(id);

  if (created === null) throw new Error("Artist vanished right after insert");

  return created;
};

const findOrCreateAlbum = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  artist: Doc<"artists">,
  track: ScannedTrack,
): Promise<Doc<"albums">> => {
  const key = keyOf(track.album);

  const existing = await ctx.db
    .query("albums")
    .withIndex("by_library_artist_key", (q) =>
      q.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", key),
    )
    .unique();

  if (existing !== null) {
    if (
      (existing.artHash === undefined && track.artHash !== undefined) ||
      (existing.year === undefined && track.year !== undefined) ||
      (existing.genre === undefined && track.genre !== undefined)
    ) {
      await ctx.db.patch(existing._id, {
        artHash: existing.artHash ?? track.artHash,
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
    searchText: `${track.album} ${artist.name}`,
  });

  const created = await ctx.db.get(id);

  if (created === null) throw new Error("Album vanished right after insert");

  return created;
};

/** Inserts or updates one scanned file and its album and artist. */
export const upsertScannedTrack = async (
  ctx: MutationCtx,
  libraryId: Id<"libraries">,
  scanned: ScannedTrack,
): Promise<void> => {
  const artist = await findOrCreateArtist(
    ctx,
    libraryId,
    scanned.albumArtist ?? scanned.artist,
    scanned.artHash,
  );

  const album = await findOrCreateAlbum(ctx, libraryId, artist, scanned);

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
    missing: false,
    searchText: `${scanned.title} ${scanned.artist} ${scanned.album}`,
  };

  const existing = await ctx.db
    .query("tracks")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", scanned.path))
    .unique();

  if (existing === null) {
    await ctx.db.insert("tracks", fields);
    await adjustAlbum(ctx, album._id, 1, scanned.durationMs);

    return;
  }

  await ctx.db.patch(existing._id, fields);

  if (!existing.missing) await adjustAlbum(ctx, existing.albumId, -1, -existing.durationMs);
  await adjustAlbum(ctx, album._id, 1, scanned.durationMs);
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
