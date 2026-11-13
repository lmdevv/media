import { getDocumentSize } from "convex/values";
import type { Value } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { inOrder } from "../core/lib/inOrder";
import type { Counted } from "../core/scans";
import { NO_COST, addCost, cost } from "./budget";
import type { Cost, Step } from "./budget";
import {
  DOCUMENT_BYTES,
  artHashWithin,
  checkLyrics,
  fingerprint,
  fitLyrics,
  fitTrack,
  keyOf,
  lyricsFieldsOf,
  titleKeyOf,
} from "./fit";
import { moveTotals } from "./totals";
import type { Moved } from "./totals";
import {
  deleteAlbum,
  deleteArtist,
  deleteTrack,
  insertAlbum,
  insertArtist,
  insertTrack,
  setAlbumCounts,
  setAlbumTags,
  setArtistAlbums,
  setArtistArt,
  setTrackLyrics,
  setTrackMissing,
  setTrackPath,
  writeLyrics,
  writeTrack,
} from "./write";
import type { Stored } from "./write";
import type { LocalLyricSet, ScannedLyrics, ScannedTrack } from "./validators";

type Db = MutationCtx["db"];

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

/** A length as tracks keep it: whole milliseconds, at least 0, so totals stay whole. */
const wholeMs = (ms: number): number => (Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0);

/** Room the three ids of a track take beside its other fields, in Convex's measure. */
const TRACK_IDS_BYTES = 256;

/** A scanned file's lyric sets, checked and fitted within the lyrics row's bound. */
const fittedSets = (sets: ReadonlyArray<LocalLyricSet>): ReadonlyArray<LocalLyricSet> => {
  checkLyrics(sets);

  return fitLyrics(sets);
};

/** A track's fields for a scanned file, but its library, album, and artist, within its bound. */
const trackFields = (scanned: ScannedTrack, sets: ReadonlyArray<LocalLyricSet>) =>
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
    ...lyricsFieldsOf(sets),
    explicit: scanned.explicit,
    missing: false,
    searchText: foldSearchText(`${scanned.title} ${scanned.artist} ${scanned.album}`),
  });

/** One read of a row by index: one range, and the row's bytes when it exists. */
const readOf = (row: Record<string, Value> | null): Cost =>
  cost(1, 0, row === null ? 0 : getDocumentSize(row));

/** One write of a row of at most `bytes`: an insert, or a patch, which reads the row too. */
const writeOf = (bytes: number, patch: boolean): Cost =>
  cost(patch ? 1 : 0, 1, patch ? bytes : 0, bytes);

/** Reading and replacing a track's lyrics row: its stored bytes in, the new sets out. */
const lyricsCost = (storedBytes: number | null, sets: ReadonlyArray<LocalLyricSet>): Cost =>
  storedBytes === null && sets.length === 0
    ? NO_COST
    : cost(1, 1, storedBytes ?? 0, lyricsFieldsOf(sets).lyricsBytes ?? 0);

/**
 * An album that gains a track this call, settled once at the end: read and patched, and its
 * artist read and patched when it first holds a track on disk.
 */
const GAINING_ALBUM = cost(
  4,
  2,
  2 * (DOCUMENT_BYTES.albums + DOCUMENT_BYTES.artists),
  DOCUMENT_BYTES.albums + DOCUMENT_BYTES.artists,
);

/**
 * An album that loses a track this call, settled once at the end: as a gaining one, and when no
 * track is left in it, its emptiness checked and the album deleted, then its artist's checked and
 * the artist deleted.
 */
const LOSING_ALBUM = addCost(
  GAINING_ALBUM,
  cost(5, 2, 2 * DOCUMENT_BYTES.tracks + DOCUMENT_BYTES.albums),
);

/** Looking for another track's artwork when a cover went: two tracks of an index range. */
const ART_FALLBACK = cost(1, 0, 2 * DOCUMENT_BYTES.tracks);

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

/** Whether keeping a row's artwork needs another track's: this track's art held it and went. */
const needsFallback = (current: string | null, art: ArtChange): boolean =>
  current !== null && current === art.previous && art.next === null;

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
 * The catalog writes of one mutation in one library, as old music's `catalogBatch` made them: each
 * write is planned as a `Step` whose cost the caller's budget charges first (`budget.ts`). Songs of
 * a batch mostly share albums and artists, so it reads each album and artist once and keeps it,
 * and it sums count changes and settles them in `finish`, writing each album, artist, and total at
 * most once a call. Every change to which tracks a library holds goes through here, so its counts
 * stay exact: an album's tracks on disk, an artist's albums with tracks on disk, and the library's
 * totals of both, of its tracks on disk, and of their length.
 */
export interface CatalogBatch {
  /**
   * Inserts or updates one scanned file, its album and artist, and its own lyrics. An album or
   * artist whose art came from this file's old art follows a replaced or removed cover.
   */
  readonly upsert: (scanned: ScannedTrack) => Promise<Step<Id<"tracks">>>;
  /**
   * Moves the track at `from` to the scanned file's path and updates it as `upsert` does, keeping
   * its id. With no track at `from`, or another track at the new path, it upserts the file and
   * marks `from` missing instead, answering false.
   */
  readonly move: (from: string, scanned: ScannedTrack) => Promise<Step<boolean>>;
  /** Marks a file that left the disk missing, keeping its row; answers whether it was on disk. */
  readonly markMissing: (path: string) => Promise<Step<boolean>>;
  /**
   * Saves lyrics a scan read again for a file whose audio did not change; answers whether the
   * library has the file.
   */
  readonly saveLyrics: (scanned: ScannedLyrics) => Promise<Step<boolean>>;
  /** Deletes a track with its lyrics, for the purge of a folder the library no longer has. */
  readonly remove: (track: Doc<"tracks">) => Step<void>;
  /**
   * Settles the call: patches each album and artist whose counts moved, moves the library's
   * album, artist, and duration totals, and deletes each album the call left without any track,
   * then its artist when nothing files under it. Answers the tracks on disk it added and removed,
   * for the core's item count, and the artwork some row stopped using, which the server checks
   * with `music/art:inUse` before it deletes any.
   */
  readonly finish: () => Promise<Counted<ReadonlyArray<string>>>;
}

/**
 * Starts the catalog writes of one mutation in `libraryId`. Call `finish` once at the end. A
 * removed library's purge passes `totals: false`: its totals are already gone with it.
 */
export const catalogBatch = (
  db: Db,
  libraryId: Id<"libraries">,
  options: { readonly totals: boolean } = { totals: true },
): CatalogBatch => {
  const artists = new Map<string, Stored<"artists"> | null>();
  const albums = new Map<string, Stored<"albums"> | null>();
  const deltas = new Map<Id<"albums">, AlbumDelta>();
  const losing = new Set<Id<"albums">>();
  const charged = new Set<string>();
  const released = new Set<string>();
  let added = 0;
  let removed = 0;
  let durationMs = 0;

  const release = (previous: string | null, next: string | null): void => {
    if (previous !== null && previous !== next) released.add(previous);
  };

  const adjust = (albumId: Id<"albums">, tracks: number, length: number): void => {
    const previous = deltas.get(albumId) ?? { tracks: 0, durationMs: 0 };

    deltas.set(albumId, {
      tracks: previous.tracks + tracks,
      durationMs: previous.durationMs + length,
    });
  };

  /** A track that came onto the disk or left it, for the library's track and length totals. */
  const present = (track: { readonly durationMs: number }, step: 1 | -1): void => {
    if (step === 1) added += 1;
    else removed += 1;

    durationMs += step * track.durationMs;
  };

  /** What settling an album costs the first time a call touches it; nothing after. */
  const settling = (key: string, settle: Cost): Cost => {
    if (charged.has(key)) return NO_COST;

    charged.add(key);

    return settle;
  };

  const trackAt = (path: string): Promise<Doc<"tracks"> | null> =>
    db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId).eq("path", path))
      .unique();

  const findArtist = async (key: string): Promise<Cost> => {
    if (artists.has(key)) return NO_COST;

    const found = await db
      .query("artists")
      .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId).eq("key", key))
      .first();

    artists.set(key, found);

    return readOf(found);
  };

  const findAlbum = async (artistKey: string, key: string): Promise<Cost> => {
    const artist = artists.get(artistKey) ?? null;

    if (artist === null) return NO_COST;

    const cacheKey = albumKeyOf(artist._id, key);

    if (albums.has(cacheKey)) return NO_COST;

    const found = await db
      .query("albums")
      .withIndex("by_library_artist_key", (q) =>
        q.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", key),
      )
      .first();

    albums.set(cacheKey, found);

    return readOf(found);
  };

  /** Another track's artwork on disk for an artist, at most two tracks read. */
  const artistArt = async (artistId: Id<"artists">, except: Id<"tracks"> | null) =>
    firstArt(
      await db
        .query("tracks")
        .withIndex("by_artist_art", (q) =>
          q.eq("artistId", artistId).eq("missing", false).gt("artHash", ""),
        )
        .take(2),
      except,
    );

  /** Another track's artwork on disk for an album, at most two tracks read. */
  const albumArt = async (albumId: Id<"albums">, except: Id<"tracks"> | null) =>
    firstArt(
      await db
        .query("tracks")
        .withIndex("by_album_art", (q) =>
          q.eq("albumId", albumId).eq("missing", false).gt("artHash", ""),
        )
        .take(2),
      except,
    );

  const artistFor = async (
    filing: Filing,
    art: ArtChange,
    except: Id<"tracks"> | null,
  ): Promise<Stored<"artists">> => {
    const existing = artists.get(filing.artistKey) ?? null;

    if (existing === null) {
      const created = await insertArtist(db, {
        libraryId,
        name: filing.artistName,
        key: filing.artistKey,
        albumCount: 0,
        artHash: art.next,
        searchText: foldSearchText(filing.artistName),
      });

      artists.set(filing.artistKey, created);

      return created;
    }

    const artHash = await keptArt(existing.artHash, art, () => artistArt(existing._id, except));

    if (artHash === existing.artHash) return existing;

    await setArtistArt(db, existing._id, artHash);
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
    const existing = albums.get(cacheKey) ?? null;

    if (existing === null) {
      const created = await insertAlbum(db, {
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

    await setAlbumTags(db, existing._id, changes);
    release(existing.artHash, artHash);

    const updated = { ...existing, ...changes };

    albums.set(cacheKey, updated);

    return updated;
  };

  /**
   * Plans an upsert of `scanned` over `existing`, the track already at its path or the one a move
   * brings there, or null for a new track. Reads the artist and album it files under, once a call.
   */
  const planUpsert = async (
    scanned: ScannedTrack,
    existing: Doc<"tracks"> | null,
  ): Promise<Step<Id<"tracks">>> => {
    const filing = filingOf(scanned);
    const sets = fittedSets(scanned.lyrics);
    const fields = trackFields(scanned, sets);

    const art: ArtChange = {
      previous: existing?.artHash ?? null,
      next: fields.artHash,
      coverChanged: existing !== null && existing.folderArt !== fields.folderArt,
    };

    const lookups = addCost(
      await findArtist(filing.artistKey),
      await findAlbum(filing.artistKey, filing.albumKey),
    );

    const artist = artists.get(filing.artistKey) ?? null;

    const album =
      artist === null ? null : (albums.get(albumKeyOf(artist._id, filing.albumKey)) ?? null);

    const rows = [
      artist === null
        ? writeOf(DOCUMENT_BYTES.artists, false)
        : addCost(
            needsFallback(artist.artHash, art) ? ART_FALLBACK : NO_COST,
            artist.artHash === art.next ? NO_COST : writeOf(DOCUMENT_BYTES.artists, true),
          ),
      album === null
        ? writeOf(DOCUMENT_BYTES.albums, false)
        : addCost(
            needsFallback(album.artHash, art) ? ART_FALLBACK : NO_COST,
            writeOf(DOCUMENT_BYTES.albums, true),
          ),
      writeOf(getDocumentSize(fields) + TRACK_IDS_BYTES, existing !== null),
      lyricsCost(existing?.lyricsBytes ?? null, sets),
      settling(`gain:${filing.artistKey}\u0000${filing.albumKey}`, GAINING_ALBUM),
      existing === null || existing.albumId === album?._id
        ? NO_COST
        : settling(`lose:${existing.albumId}`, LOSING_ALBUM),
    ];

    return {
      cost: rows.reduce(addCost, lookups),
      run: async () => {
        const except = existing?._id ?? null;
        const filedArtist = await artistFor(filing, art, except);
        const filedAlbum = await albumFor(filedArtist, scanned, filing, art, except);
        const placed = { ...fields, libraryId, albumId: filedAlbum._id, artistId: filedArtist._id };

        if (existing === null) {
          const trackId = await insertTrack(db, placed);

          await writeLyrics(db, trackId, false, sets);
          adjust(filedAlbum._id, 1, fields.durationMs);
          present(fields, 1);

          return trackId;
        }

        await writeTrack(db, existing._id, placed);
        await writeLyrics(db, existing._id, existing.lyricsBytes !== null, sets);
        release(existing.artHash, fields.artHash);

        if (existing.albumId !== filedAlbum._id) losing.add(existing.albumId);

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
      },
    };
  };

  const missingStep = (track: Doc<"tracks"> | null, read: Cost): Step<boolean> => {
    if (track === null || track.missing) return { cost: read, run: async () => false };

    return {
      cost: addCost(
        addCost(read, writeOf(getDocumentSize(track), true)),
        settling(`lose:${track.albumId}`, LOSING_ALBUM),
      ),
      run: async () => {
        await setTrackMissing(db, track._id);
        adjust(track.albumId, -1, -track.durationMs);
        losing.add(track.albumId);
        present(track, -1);

        return true;
      },
    };
  };

  const upsert = async (scanned: ScannedTrack): Promise<Step<Id<"tracks">>> => {
    const existing = await trackAt(scanned.path);
    const planned = await planUpsert(scanned, existing);

    return { ...planned, cost: addCost(readOf(existing), planned.cost) };
  };

  const move = async (from: string, scanned: ScannedTrack): Promise<Step<boolean>> => {
    const source = await trackAt(from);
    const occupied = from === scanned.path ? source : await trackAt(scanned.path);
    const reads = addCost(readOf(source), from === scanned.path ? NO_COST : readOf(occupied));

    if (source === null || occupied !== null || from === scanned.path) {
      const gone = from === scanned.path ? null : missingStep(source, NO_COST);
      const planned = await planUpsert(scanned, occupied);

      return {
        cost: addCost(addCost(reads, gone?.cost ?? NO_COST), planned.cost),
        run: async () => {
          await gone?.run();
          await planned.run();

          return false;
        },
      };
    }

    const moved = { ...source, path: scanned.path };
    const planned = await planUpsert(scanned, moved);

    return {
      cost: addCost(addCost(reads, writeOf(getDocumentSize(moved), true)), planned.cost),
      run: async () => {
        await setTrackPath(db, source._id, scanned.path);
        await planned.run();

        return true;
      },
    };
  };

  const markMissing = async (path: string): Promise<Step<boolean>> => {
    const track = await trackAt(path);

    return missingStep(track, readOf(track));
  };

  const saveLyrics = async (scanned: ScannedLyrics): Promise<Step<boolean>> => {
    const track = await trackAt(scanned.path);

    if (track === null) return { cost: readOf(track), run: async () => false };

    const sets = fittedSets(scanned.lyrics);

    const fields = {
      lyricsFiles: fingerprint(scanned.lyricsFiles),
      lyricsReader: scanned.lyricsReader,
      ...lyricsFieldsOf(sets),
    };

    const unchanged =
      track.lyricsFiles === fields.lyricsFiles &&
      track.lyricsReader === fields.lyricsReader &&
      track.lyricsBytes === fields.lyricsBytes &&
      track.lyricsHash === fields.lyricsHash &&
      track.lyricsSynced === fields.lyricsSynced;

    return {
      cost: addCost(
        addCost(readOf(track), unchanged ? NO_COST : writeOf(getDocumentSize(track), true)),
        lyricsCost(track.lyricsBytes, sets),
      ),
      run: async () => {
        if (!unchanged) await setTrackLyrics(db, track._id, fields);

        await writeLyrics(db, track._id, track.lyricsBytes !== null, sets);

        return true;
      },
    };
  };

  const remove = (track: Doc<"tracks">): Step<void> => ({
    cost: addCost(
      addCost(lyricsCost(track.lyricsBytes, []), cost(1, 1)),
      settling(`lose:${track.albumId}`, LOSING_ALBUM),
    ),
    run: async () => {
      await writeLyrics(db, track._id, track.lyricsBytes !== null, []);
      await deleteTrack(db, track._id);
      losing.add(track.albumId);

      if (!track.missing) {
        adjust(track.albumId, -1, -track.durationMs);
        present(track, -1);
      }
    },
  });

  /** Deletes an artist nothing files under any more, answering the artwork it held. */
  const deleteIfBare = async (artistId: Id<"artists">): Promise<string | null> => {
    const artist = await db.get(artistId);

    if (artist === null || artist.albumCount > 0) return null;

    const [album, track] = await Promise.all([
      db
        .query("albums")
        .withIndex("by_artist", (q) => q.eq("artistId", artistId))
        .first(),
      db
        .query("tracks")
        .withIndex("by_artist", (q) => q.eq("artistId", artistId))
        .first(),
    ]);

    if (album !== null || track !== null) return null;

    await deleteArtist(db, artistId);

    return artist.artHash;
  };

  /** Deletes an album no track points at any more, then its artist when it is bare too. */
  const deleteIfEmpty = async (album: Doc<"albums">): Promise<void> => {
    const track = await db
      .query("tracks")
      .withIndex("by_album", (q) => q.eq("albumId", album._id))
      .first();

    if (track !== null) return;

    await deleteAlbum(db, album._id);
    release(album.artHash, null);
    release(await deleteIfBare(album.artistId), null);
  };

  const finish = async (): Promise<Counted<ReadonlyArray<string>>> => {
    const artistSteps = new Map<Id<"artists">, number>();
    const emptied: Array<Doc<"albums">> = [];
    let albumsMoved = 0;

    const settled = await Promise.all(
      [...new Set([...deltas.keys(), ...losing])].map(async (albumId) => db.get(albumId)),
    );

    await Promise.all(
      settled.map(async (album) => {
        if (album === null) return;

        const delta = deltas.get(album._id) ?? { tracks: 0, durationMs: 0 };
        const trackCount = album.trackCount + delta.tracks;

        if (delta.tracks !== 0 || delta.durationMs !== 0) {
          await setAlbumCounts(db, album._id, {
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
        const artist = step === 0 ? null : await db.get(artistId);

        if (artist === null) return;

        const albumCount = artist.albumCount + step;

        await setArtistAlbums(db, artistId, albumCount);
        artistsMoved += Number(albumCount > 0) - Number(artist.albumCount > 0);
      }),
    );

    const moved: Moved = { albums: albumsMoved, artists: artistsMoved, durationMs };

    if (options.totals) await moveTotals(db, libraryId, moved);

    await inOrder(emptied, deleteIfEmpty);

    return { value: [...released], added, removed };
  };

  return { upsert, move, markMissing, saveLyrics, remove, finish };
};
