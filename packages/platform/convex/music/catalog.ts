import type { Doc, Id } from "../_generated/dataModel";
import { inOrder } from "../core/lib/inOrder";
import type { Counted } from "../core/scans";
import { CALL_COST, sumCost, whileBudget } from "./budget";
import type { Cost } from "./budget";
import {
  MUSIC_BOUNDS,
  artHashWithin,
  checkLyrics,
  fingerprint,
  fitLyrics,
  fitTrack,
  keyOf,
  lyricsFieldsOf,
  titleKeyOf,
} from "./fit";
import { LYRICS_ROWS_READ, atBound } from "./write";
import type { MusicStore, Stored } from "./write";
import type { LocalLyricSet, ScannedLyrics, ScannedTrack } from "./validators";

/** Combining Diacritical Marks: the accents NFD splits off Latin, Greek, and Cyrillic letters. */
const DIACRITICS = /[\u0300-\u036F]/gu;

/** Letters that carry no separable accent but that people type without one. */
const LETTERS = new Map([
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ø", "o"],
  ["ł", "l"],
  ["đ", "d"],
  ["ð", "d"],
  ["þ", "th"],
  ["ı", "i"],
]);

const LETTER = /[ßæœøłđðþı]/gu;

/**
 * Lowercases `text` and strips accents, as old music's `foldSearchText` does, so search matches
 * "Doppelgänger" for "doppelganger". Only the Latin, Greek, and Cyrillic accent block goes, and
 * the result is recomposed, so kana and Hangul come back unchanged.
 */
export const foldSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(DIACRITICS, "")
    .normalize("NFC")
    .replaceAll(LETTER, (letter) => LETTERS.get(letter) ?? letter);

/** A short format label such as `FLAC 24/96` or `MP3 320`, as old music shows an album's. */
const formatLabel = (track: ScannedTrack): string => {
  const codec = track.codec.toUpperCase();

  if (track.lossless && track.bitDepth !== undefined && track.sampleRate !== undefined) {
    return `${codec} ${track.bitDepth}/${Math.round(track.sampleRate / 100) / 10}`;
  }

  if (track.bitrate !== undefined) return `${codec} ${Math.round(track.bitrate / 1000)}`;

  return codec;
};

/**
 * A length as tracks keep it: whole milliseconds from 0 to the bound, so totals stay whole and
 * safe integers however many tracks a library holds.
 */
const wholeMs = (ms: number): number =>
  Number.isFinite(ms) ? Math.min(Math.max(0, Math.round(ms)), MUSIC_BOUNDS.durationMs) : 0;

/** A scanned file's lyric sets, checked and fitted within the lyrics row's bound. */
const fittedSets = (sets: ReadonlyArray<LocalLyricSet>): ReadonlyArray<LocalLyricSet> => {
  checkLyrics(sets);

  return fitLyrics(sets);
};

/** A track's fields for a scanned file, but its library, album, and artist, within its bound. */
const trackFields = async (scanned: ScannedTrack, sets: ReadonlyArray<LocalLyricSet>) =>
  fitTrack({
    path: scanned.path,
    size: scanned.size,
    mtimeMs: scanned.mtimeMs,
    title: scanned.title,
    titleKey: titleKeyOf(scanned.title),
    artistName: scanned.artist,
    albumTitle: scanned.album,
    trackNumber: scanned.trackNumber ?? null,
    discNumber: scanned.discNumber ?? null,
    durationMs: wholeMs(scanned.durationMs),
    codec: scanned.codec,
    lossless: scanned.lossless,
    bitrate: scanned.bitrate ?? null,
    sampleRate: scanned.sampleRate ?? null,
    bitDepth: scanned.bitDepth ?? null,
    artHash: artHashWithin(scanned.artHash),
    folderArt: scanned.folderArt ?? null,
    lyricsFiles: scanned.lyricsFiles,
    lyricsReader: scanned.lyricsReader,
    ...(await lyricsFieldsOf(sets)),
    explicit: scanned.explicit,
    missing: false,
    searchText: foldSearchText(`${scanned.title} ${scanned.artist} ${scanned.album}`),
  });

/** Settling one album in `finish`: it and its artist read and patched. */
const SETTLING = sumCost([
  atBound.read("albums"),
  atBound.patch("albums"),
  atBound.read("artists"),
  atBound.patch("artists"),
]);

/** Deleting an emptied album, then its bare artist (`deleteIfEmpty`). */
const EMPTYING = sumCost([
  atBound.read("tracks"),
  atBound.delete("albums"),
  atBound.read("artists"),
  atBound.read("albums"),
  atBound.read("tracks"),
  atBound.delete("artists"),
]);

/**
 * The most one write of a batch costs, with every document at its bound: a move onto a path
 * another track holds, with its lyrics row rewritten (two rows read and the new sets walked), and
 * three albums settled at the call's end
 * (the one it joins, the one it leaves, and the one the other track leaves), two of them perhaps
 * emptied. Every other write costs less.
 */
const WRITE_MOST = sumCost([
  atBound.read("tracks"),
  atBound.read("tracks"),
  atBound.read("artists"),
  atBound.read("albums"),
  atBound.patch("tracks"),
  atBound.read("tracks", 2),
  atBound.patch("artists"),
  atBound.read("tracks", 2),
  atBound.patch("albums"),
  atBound.patch("tracks"),
  atBound.read("localLyrics", LYRICS_ROWS_READ),
  atBound.patch("localLyrics"),
  atBound.delete("localLyrics"),
  atBound.lyrics(LYRICS_ROWS_READ + 1),
  SETTLING,
  SETTLING,
  SETTLING,
  EMPTYING,
  EMPTYING,
]);

/** A change in an album's tracks on disk and their length. */
interface AlbumDelta {
  readonly tracks: number;
  readonly durationMs: number;
}

/** How one upsert changes the artwork of the album and artist a track files under. */
interface ArtChange {
  /** The track as stored before the upsert, or null for a new one. */
  readonly previous: string | null;
  /** The artwork the scan found for it. */
  readonly next: string | null;
  /** The folder cover beside it was replaced, added, or removed since the last scan. */
  readonly coverChanged: boolean;
}

/**
 * The artwork an album or artist keeps after an upsert, as old music decides it: a row without
 * art takes the track's; a row whose art came from this track follows a replaced cover, or falls
 * back to another track's art when this one's went; any other row keeps its own.
 */
const keptArt = async (
  current: string | null,
  art: ArtChange,
  fallback: () => Promise<string | null>,
): Promise<string | null> => {
  if (current === null) return art.next;

  if (current !== art.previous || art.next === art.previous) return current;

  if (art.next === null) return fallback();

  return art.coverChanged ? art.next : current;
};

/** The cache key of an album by its artist and its key. */
const albumKeyOf = (artistId: Id<"artists">, key: string): string => `${artistId}\u0000${key}`;

/** The artwork of the first of `tracks` that is not `except`. */
const firstArt = (tracks: ReadonlyArray<Doc<"tracks">>, except: Id<"tracks"> | null) =>
  tracks.find((track) => track._id !== except)?.artHash ?? null;

/** What a scanned file files under: its artist's key and its album's key. */
interface Filing {
  readonly artistName: string;
  readonly artistKey: string;
  readonly albumKey: string;
}

const filingOf = (scanned: ScannedTrack): Filing => {
  const artistName = scanned.albumArtist ?? scanned.artist;

  return { artistName, artistKey: keyOf(artistName), albumKey: keyOf(scanned.album) };
};

/**
 * The catalog writes of one mutation in one library, as old music's `catalogBatch` made them,
 * through the music store, which charges the call's meter for each read and write (`write.ts`).
 * Songs of a batch mostly share albums and artists, so it reads each album and artist once and
 * keeps it, and it sums count changes and settles them in `finish`, writing each album, artist,
 * and total at most once a call. Every change to which tracks a library holds goes through here,
 * so its counts stay exact: an album's tracks on disk, an artist's albums with tracks on disk, and
 * the library's totals of both, of its tracks on disk, and of their length.
 */
export interface CatalogBatch {
  /** Runs `write` on the leading items while `whileBudget` admits another. */
  readonly each: <Item, Result>(
    items: ReadonlyArray<Item>,
    write: (item: Item) => Promise<Result>,
  ) => Promise<ReadonlyArray<Result>>;
  /**
   * Inserts or updates one scanned file, its album and artist, and its own lyrics. An album or
   * artist whose art came from this file's old art follows a replaced or removed cover.
   */
  readonly upsert: (scanned: ScannedTrack) => Promise<Id<"tracks">>;
  /**
   * Moves the track at `from` to the scanned file's path and updates it as `upsert` does, keeping
   * its id. With no track at `from`, or another track at the new path, it upserts the file and
   * marks `from` missing instead, answering false.
   */
  readonly move: (from: string, scanned: ScannedTrack) => Promise<boolean>;
  /** Marks a file that left the disk missing, keeping its row; answers whether it was on disk. */
  readonly markMissing: (path: string) => Promise<boolean>;
  /**
   * Saves lyrics a scan read again for a file whose audio did not change; answers whether the
   * library has the file.
   */
  readonly saveLyrics: (scanned: ScannedLyrics) => Promise<boolean>;
  /** Deletes a track with its lyrics, for the purge of a folder the library no longer has. */
  readonly remove: (track: Doc<"tracks">) => Promise<void>;
  /**
   * Settles the call: patches each album and artist whose counts moved, moves the library's
   * album, artist, and duration totals, and deletes each album the call left without any track,
   * then its artist when nothing files under it. Answers the tracks on disk it added and removed,
   * for the core's item count, and the artwork some row stopped using, which the server checks
   * with `music/art:inUse` before it deletes any.
   */
  readonly finish: () => Promise<Counted<ReadonlyArray<string>>>;
}

export interface BatchOptions {
  /** False for a removed library's purge: its totals are already gone with it. */
  readonly totals?: boolean;
  /** What the call may spend, `CALL_COST` unless a test passes less. */
  readonly limit?: Cost;
}

/** Starts the catalog writes of one mutation in `libraryId`. Call `finish` once at the end. */
export const catalogBatch = (
  store: MusicStore,
  libraryId: Id<"libraries">,
  options: BatchOptions = {},
): CatalogBatch => {
  const artists = new Map<string, Stored<"artists"> | null>();
  const albums = new Map<string, Stored<"albums"> | null>();
  const madeArtists = new Set<Id<"artists">>();
  const deltas = new Map<Id<"albums">, AlbumDelta>();
  const losing = new Set<Id<"albums">>();
  const owed = new Set<string>();
  const released = new Set<string>();
  let added = 0;
  let removed = 0;
  let durationMs = 0;

  /** Charges, once a call for each `key`, work `finish` will do. */
  const owe = (key: string, work: Cost): void => {
    if (owed.has(key)) return;

    owed.add(key);
    store.meter.charge(work);
  };

  const release = (previous: string | null, next: string | null): void => {
    if (previous !== null && previous !== next) released.add(previous);
  };

  const adjust = (albumId: Id<"albums">, tracks: number, length: number): void => {
    const previous = deltas.get(albumId) ?? { tracks: 0, durationMs: 0 };

    owe(`settle:${albumId}`, SETTLING);
    deltas.set(albumId, {
      tracks: previous.tracks + tracks,
      durationMs: previous.durationMs + length,
    });
  };

  /** An album a track left, which `finish` deletes when no track row points at it any more. */
  const mayEmpty = (albumId: Id<"albums">): void => {
    owe(`settle:${albumId}`, SETTLING);
    owe(`empty:${albumId}`, EMPTYING);
    losing.add(albumId);
  };

  /** A track that came onto the disk or left it, for the library's track and length totals. */
  const present = (track: { readonly durationMs: number }, step: 1 | -1): void => {
    if (step === 1) added += 1;
    else removed += 1;

    durationMs += step * track.durationMs;
  };

  const trackAt = (path: string): Promise<Doc<"tracks"> | null> =>
    store.unique("tracks", (q) =>
      q.withIndex("by_library_path", (index) => index.eq("libraryId", libraryId).eq("path", path)),
    );

  const findArtist = async (key: string): Promise<Stored<"artists"> | null> => {
    if (!artists.has(key)) {
      artists.set(
        key,
        await store.first("artists", (q) =>
          q.withIndex("by_library_key", (index) => index.eq("libraryId", libraryId).eq("key", key)),
        ),
      );
    }

    return artists.get(key) ?? null;
  };

  /** An album of `artist` by key, read once a call; an artist this call made has none to read. */
  const findAlbum = async (
    artist: Stored<"artists">,
    key: string,
  ): Promise<Stored<"albums"> | null> => {
    const cacheKey = albumKeyOf(artist._id, key);

    if (!albums.has(cacheKey) && madeArtists.has(artist._id)) albums.set(cacheKey, null);

    if (!albums.has(cacheKey)) {
      albums.set(
        cacheKey,
        await store.first("albums", (q) =>
          q.withIndex("by_library_artist_key", (index) =>
            index.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", key),
          ),
        ),
      );
    }

    return albums.get(cacheKey) ?? null;
  };

  /** Another track's artwork on disk for an artist, at most two tracks read. */
  const artistArt = async (artistId: Id<"artists">, except: Id<"tracks"> | null) =>
    firstArt(
      await store.take(
        "tracks",
        (q) =>
          q.withIndex("by_artist_art", (index) =>
            index.eq("artistId", artistId).eq("missing", false).gt("artHash", ""),
          ),
        2,
      ),
      except,
    );

  /** Another track's artwork on disk for an album, at most two tracks read. */
  const albumArt = async (albumId: Id<"albums">, except: Id<"tracks"> | null) =>
    firstArt(
      await store.take(
        "tracks",
        (q) =>
          q.withIndex("by_album_art", (index) =>
            index.eq("albumId", albumId).eq("missing", false).gt("artHash", ""),
          ),
        2,
      ),
      except,
    );

  const artistFor = async (
    filing: Filing,
    art: ArtChange,
    except: Id<"tracks"> | null,
  ): Promise<Stored<"artists">> => {
    const existing = await findArtist(filing.artistKey);

    if (existing === null) {
      const created = await store.insertArtist({
        libraryId,
        name: filing.artistName,
        key: filing.artistKey,
        albumCount: 0,
        artHash: art.next,
        searchText: foldSearchText(filing.artistName),
      });

      artists.set(filing.artistKey, created);
      madeArtists.add(created._id);

      return created;
    }

    const artHash = await keptArt(existing.artHash, art, () => artistArt(existing._id, except));

    if (artHash === existing.artHash) return existing;

    await store.setArtistArt(existing._id, artHash);
    release(existing.artHash, artHash);

    const updated = { ...existing, artHash };

    artists.set(filing.artistKey, updated);

    return updated;
  };

  const albumFor = async (
    artist: Stored<"artists">,
    scanned: ScannedTrack,
    filing: Filing,
    art: ArtChange,
    except: Id<"tracks"> | null,
  ): Promise<Stored<"albums">> => {
    const cacheKey = albumKeyOf(artist._id, filing.albumKey);
    const existing = await findAlbum(artist, filing.albumKey);

    if (existing === null) {
      const created = await store.insertAlbum({
        libraryId,
        artistId: artist._id,
        artistName: artist.name,
        title: scanned.album,
        key: filing.albumKey,
        year: scanned.year ?? null,
        genre: scanned.genre ?? null,
        artHash: art.next,
        trackCount: 0,
        durationMs: 0,
        format: formatLabel(scanned),
        addedAt: Date.now(),
        searchText: foldSearchText(`${scanned.album} ${artist.name}`),
      });

      albums.set(cacheKey, created);

      return created;
    }

    const artHash = await keptArt(existing.artHash, art, () => albumArt(existing._id, except));

    const changes = {
      artHash,
      year: existing.year ?? scanned.year ?? null,
      genre: existing.genre ?? scanned.genre ?? null,
    };

    if (
      changes.artHash === existing.artHash &&
      changes.year === existing.year &&
      changes.genre === existing.genre
    ) {
      return existing;
    }

    await store.setAlbumTags(existing._id, changes);
    release(existing.artHash, artHash);

    const updated = { ...existing, ...changes };

    albums.set(cacheKey, updated);

    return updated;
  };

  /**
   * Writes `scanned` over `existing`, the track already at its path or the one a move brings
   * there, or null for a new track, with the artist and album it files under, read once a call.
   */
  const upsertOver = async (
    scanned: ScannedTrack,
    existing: Doc<"tracks"> | null,
  ): Promise<Id<"tracks">> => {
    const filing = filingOf(scanned);
    const sets = fittedSets(scanned.lyrics);
    const fields = await trackFields(scanned, sets);
    const except = existing?._id ?? null;

    const art: ArtChange = {
      previous: existing?.artHash ?? null,
      next: fields.artHash,
      coverChanged: existing !== null && existing.folderArt !== fields.folderArt,
    };

    const filedArtist = await artistFor(filing, art, except);
    const filedAlbum = await albumFor(filedArtist, scanned, filing, art, except);
    const placed = { ...fields, libraryId, albumId: filedAlbum._id, artistId: filedArtist._id };

    if (existing === null) {
      const trackId = await store.insertTrack(placed, sets);

      adjust(filedAlbum._id, 1, fields.durationMs);
      present(fields, 1);

      return trackId;
    }

    await store.writeTrack(existing._id, placed);
    await store.writeLyrics(existing._id, sets);
    release(existing.artHash, fields.artHash);

    if (existing.albumId !== filedAlbum._id) mayEmpty(existing.albumId);

    if (existing.missing) {
      adjust(filedAlbum._id, 1, fields.durationMs);
      present(fields, 1);

      return existing._id;
    }

    durationMs += fields.durationMs - existing.durationMs;

    if (existing.albumId === filedAlbum._id) {
      adjust(filedAlbum._id, 0, fields.durationMs - existing.durationMs);

      return existing._id;
    }

    adjust(existing.albumId, -1, -existing.durationMs);
    adjust(filedAlbum._id, 1, fields.durationMs);

    return existing._id;
  };

  /** Marks `track` missing when it is on disk; answers whether it was. */
  const markGone = async (track: Doc<"tracks"> | null): Promise<boolean> => {
    if (track === null || track.missing) return false;

    await store.setTrackMissing(track._id);
    adjust(track.albumId, -1, -track.durationMs);
    mayEmpty(track.albumId);
    present(track, -1);

    return true;
  };

  const upsert = async (scanned: ScannedTrack): Promise<Id<"tracks">> =>
    upsertOver(scanned, await trackAt(scanned.path));

  const move = async (from: string, scanned: ScannedTrack): Promise<boolean> => {
    const source = await trackAt(from);

    if (from === scanned.path) {
      await upsertOver(scanned, source);

      return false;
    }

    const occupied = await trackAt(scanned.path);

    if (source === null || occupied !== null) {
      await markGone(source);
      await upsertOver(scanned, occupied);

      return false;
    }

    // The upsert writes every field of the track, its new path included, so the move is one write.
    await upsertOver(scanned, { ...source, path: scanned.path });

    return true;
  };

  const markMissing = async (path: string): Promise<boolean> => markGone(await trackAt(path));

  const saveLyrics = async (scanned: ScannedLyrics): Promise<boolean> => {
    const track = await trackAt(scanned.path);

    if (track === null) return false;

    const sets = fittedSets(scanned.lyrics);

    const fields = {
      lyricsFiles: fingerprint(scanned.lyricsFiles),
      lyricsReader: scanned.lyricsReader,
      ...(await lyricsFieldsOf(sets)),
    };

    const unchanged =
      track.lyricsFiles === fields.lyricsFiles &&
      track.lyricsReader === fields.lyricsReader &&
      track.lyricsBytes === fields.lyricsBytes &&
      track.lyricsHash === fields.lyricsHash &&
      track.lyricsSynced === fields.lyricsSynced;

    if (!unchanged) await store.setTrackLyrics(track._id, fields);

    await store.writeLyrics(track._id, sets);

    return true;
  };

  const remove = async (track: Doc<"tracks">): Promise<void> => {
    await store.writeLyrics(track._id, []);
    await store.deleteTrack(track._id);
    mayEmpty(track.albumId);

    if (!track.missing) {
      adjust(track.albumId, -1, -track.durationMs);
      present(track, -1);
    }
  };

  /** Deletes an artist nothing files under any more, answering the artwork it held. */
  const deleteIfBare = async (artistId: Id<"artists">): Promise<string | null> => {
    const artist = await store.get("artists", artistId);

    if (artist === null || artist.albumCount > 0) return null;

    const [album, track] = await Promise.all([
      store.first("albums", (q) =>
        q.withIndex("by_artist", (index) => index.eq("artistId", artistId)),
      ),
      store.first("tracks", (q) =>
        q.withIndex("by_artist", (index) => index.eq("artistId", artistId)),
      ),
    ]);

    if (album !== null || track !== null) return null;

    await store.deleteArtist(artistId);

    return artist.artHash;
  };

  /** Deletes an album no track points at any more, then its artist when it is bare too. */
  const deleteIfEmpty = async (album: Doc<"albums">): Promise<void> => {
    const track = await store.first("tracks", (q) =>
      q.withIndex("by_album", (index) => index.eq("albumId", album._id)),
    );

    if (track !== null) return;

    await store.deleteAlbum(album._id);
    release(album.artHash, null);
    release(await deleteIfBare(album.artistId), null);
  };

  const finish = async (): Promise<Counted<ReadonlyArray<string>>> => {
    const artistSteps = new Map<Id<"artists">, number>();
    const emptied: Array<Doc<"albums">> = [];
    let albumsMoved = 0;

    const settled = await Promise.all(
      [...new Set([...deltas.keys(), ...losing])].map(async (albumId) =>
        store.get("albums", albumId),
      ),
    );

    await Promise.all(
      settled.map(async (album) => {
        if (album === null) return;

        const delta = deltas.get(album._id) ?? { tracks: 0, durationMs: 0 };
        const trackCount = album.trackCount + delta.tracks;

        if (delta.tracks !== 0 || delta.durationMs !== 0) {
          await store.setAlbumCounts(album._id, {
            trackCount,
            durationMs: album.durationMs + delta.durationMs,
          });
        }

        if (trackCount === 0 && losing.has(album._id)) emptied.push(album);

        const step = Number(trackCount > 0) - Number(album.trackCount > 0);

        if (step === 0) return;

        albumsMoved += step;
        artistSteps.set(album.artistId, (artistSteps.get(album.artistId) ?? 0) + step);
      }),
    );

    let artistsMoved = 0;

    await Promise.all(
      [...artistSteps].map(async ([artistId, step]) => {
        const artist = step === 0 ? null : await store.get("artists", artistId);

        if (artist === null) return;

        const albumCount = artist.albumCount + step;

        await store.setArtistAlbums(artistId, albumCount);
        artistsMoved += Number(albumCount > 0) - Number(artist.albumCount > 0);
      }),
    );

    if (options.totals ?? true) {
      await store.moveTotals(libraryId, {
        albums: albumsMoved,
        artists: artistsMoved,
        durationMs,
      });
    }

    await inOrder(emptied, deleteIfEmpty);

    return { value: [...released], added, removed };
  };

  return {
    each: (items, write) =>
      whileBudget(store.meter, options.limit ?? CALL_COST, WRITE_MOST, items, write),
    upsert,
    move,
    markMissing,
    saveLyrics,
    remove,
    finish,
  };
};
