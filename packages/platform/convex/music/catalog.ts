import {
  MAX_FEATURED_LISTS,
  distinctNames,
  featuredCredits,
  isCombined,
} from "@media/contracts/artist-credits";
import { foldSearchText } from "@media/contracts/search-text";

import type { Doc, Id } from "../_generated/dataModel";
import { inOrder } from "../core/lib/inOrder";
import type { Counted } from "../core/scans";
import { CALL_COST, repeated, sumCost, whileBudget } from "./budget";
import type { Cost } from "./budget";
import {
  COMBINED_SETTLING,
  RECHECK_KEYS,
  RESOLVING,
  SCHEDULING,
  SINGLE_SETTLING,
  USE_RECORDING,
  creditLedger,
} from "./creditLedger";
import {
  MUSIC_BOUNDS,
  artHashWithin,
  checkLyrics,
  fingerprint,
  fitLyrics,
  fitTrack,
  keyOf,
  lyricsFieldsOf,
  nameWithin,
  namesWithin,
  titleKeyOf,
} from "./fit";
import { LYRICS_ROWS_READ, atBound } from "./write";
import type { MusicStore, Stored } from "./write";
import type { ArtistCredit, LocalLyricSet, ScannedLyrics, ScannedTrack } from "./validators";

/** A short format label such as `FLAC 24/96` or `MP3 320`, as an album shows it. */
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

/**
 * Separate artist values as credits: two or more distinct names within their maximums, or null
 * when the tags name the artists in one string.
 */
const taggedNames = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> | null => {
  if (values === undefined) return null;

  // Cut first, so two values that differ only past a name's maximum are one credit.
  const names = namesWithin(distinctNames(values.map(nameWithin)));

  return names.length >= 2 ? names : null;
};

/** What a song's tags say about its artists, as its row keeps them. */
interface SongTags {
  readonly artistName: string;
  readonly title: string;
  /** Its separate artist values, or null when its tags name its artists in one string. */
  readonly tagged: ReadonlyArray<string> | null;
}

/**
 * The credit strings a song's tags name as whole credits (ADR 0024, "Artist credits"): its
 * separate artist values of one part, or its artist tag and the featured-artist lists in its
 * title, without a later spelling of one already named.
 */
const songSources = (song: SongTags): ReadonlyArray<string> =>
  song.tagged === null
    ? distinctNames([song.artistName, ...featuredCredits(song.title)])
    : song.tagged.filter((name) => !isCombined(name));

/**
 * The credit strings a stored song names as evidence: none while its file is missing, since its
 * tags are not the library's any more, and none for a row written before credits.
 */
const storedSongSources = (track: Doc<"tracks">): ReadonlyArray<string> =>
  track.missing || track.credits === undefined
    ? []
    : songSources({
        artistName: track.artistName,
        title: track.title,
        tagged: track.creditsTagged === true ? track.credits.map((credit) => credit.name) : null,
      });

/** Whom an album credits and the album artist it shows, as the album's row keeps them. */
type AlbumCredits = Pick<Doc<"albums">, "artistId" | "artistName" | "credits" | "creditsTagged">;

/**
 * The credit strings an album names: its separate values of one part, or its album artist. They
 * are evidence while the album has a track on disk (`finish`).
 */
const albumSources = (album: AlbumCredits): ReadonlyArray<string> => {
  if (album.credits === undefined) return [];

  return album.creditsTagged === true
    ? album.credits.map((credit) => credit.name).filter((name) => !isCombined(name))
    : [album.artistName];
};

/** `names` but those `others` spell, by key. */
const without = (names: ReadonlyArray<string>, others: ReadonlyArray<string>) => {
  const keys = new Set(others.map(keyOf));

  return names.filter((name) => !keys.has(keyOf(name)));
};

/**
 * The artists a song or an album credits, in order: as a release before credits wrote it, its
 * one artist.
 */
const creditIdsOf = (row: {
  readonly artistId: Id<"artists">;
  readonly credits?: ReadonlyArray<ArtistCredit>;
}): ReadonlyArray<Id<"artists">> => row.credits?.map((credit) => credit.artistId) ?? [row.artistId];

const sameCredits = (one: ReadonlyArray<ArtistCredit>, other: ReadonlyArray<ArtistCredit>) =>
  one.length === other.length &&
  one.every((credit, index) => {
    const twin = other[index];

    return twin !== undefined && credit.artistId === twin.artistId && credit.name === twin.name;
  });

/**
 * A song's or an album's artist links against its credits: those to keep, one per credited
 * artist, and the stale ones, to an artist it no longer credits or a second to one it does.
 */
const sortLinks = <Link extends { readonly artistId: Id<"artists"> }>(
  links: ReadonlyArray<Link>,
  credits: ReadonlyArray<ArtistCredit>,
) => {
  const wanted = new Set(credits.map((credit) => credit.artistId));

  const kept = links.filter(
    (link, index) =>
      wanted.has(link.artistId) &&
      links.findIndex((one) => one.artistId === link.artistId) === index,
  );

  return { stale: links.filter((link) => !kept.includes(link)), kept };
};

/** The credits no kept link names yet. */
const unlinked = (
  kept: ReadonlyArray<{ readonly artistId: Id<"artists"> }>,
  credits: ReadonlyArray<ArtistCredit>,
): ReadonlyArray<ArtistCredit> =>
  credits.filter((credit) => !kept.some((link) => link.artistId === credit.artistId));

/** Whether an artist shows in lists and counts in the library's artist total. */
const shows = (albumCount: number, trackCount: number): number =>
  Number(albumCount > 0 || trackCount > 0);

/** A track's fields for a scanned file, but its library, album, and artists, within its bound. */
const trackFields = async (
  scanned: ScannedTrack,
  sets: ReadonlyArray<LocalLyricSet>,
  tagged: ReadonlyArray<string> | null,
) =>
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
    creditsTagged: tagged !== null,
    tagsReader: scanned.tagsReader,
    searchText: foldSearchText(
      [scanned.title, scanned.artist, scanned.album, ...(tagged ?? [])].join(" "),
    ),
  });

/** Links a song or an album reads to find its own: one per credit, and two a defect left. */
const LINKS_READ = MUSIC_BOUNDS.credits + 2;

const CREDITS = MUSIC_BOUNDS.credits;

/** Settling one artist in `finish`: read, and its counts patched. */
const ARTIST_SETTLING = sumCost([atBound.read("artists"), atBound.patch("artists")]);

/**
 * Settling one album in `finish`: it read and patched, and each artist it credits, with the one a
 * change of its credits in the call left.
 */
const ALBUM_SETTLING = sumCost([
  atBound.read("albums"),
  atBound.patch("albums"),
  repeated(ARTIST_SETTLING, CREDITS + 1),
]);

/** Deleting an artist nothing credits any more (`deleteIfBare`). */
const BARE_CHECK = sumCost([
  atBound.read("artists"),
  atBound.read("albumArtists"),
  atBound.read("trackArtists"),
  atBound.read("albums"),
  atBound.read("tracks"),
  atBound.delete("artists"),
]);

/**
 * Settling the credit strings an album names in `finish`, as it gains or loses its tracks on disk
 * or its credits change: one combined string, or its separate values, those it lost and those it
 * gained.
 */
const ALBUM_SOURCES_SETTLING = repeated(SINGLE_SETTLING, 2 * CREDITS);

/**
 * Deleting an emptied album (`deleteIfEmpty`): a track looked for, its artist links read and
 * deleted, the album deleted, and each artist it credited checked.
 */
const EMPTYING = sumCost([
  atBound.read("tracks"),
  atBound.read("albumArtists", LINKS_READ),
  repeated(atBound.delete("albumArtists"), LINKS_READ),
  atBound.delete("albums"),
  repeated(BARE_CHECK, CREDITS + 1),
]);

/**
 * Rewriting one song's artist links: its links read, each a defect or the old credits left
 * deleted, and the new ones inserted or given its title again.
 */
const TRACK_LINKS = sumCost([
  atBound.read("trackArtists", LINKS_READ),
  repeated(atBound.delete("trackArtists"), LINKS_READ),
  repeated(atBound.patch("trackArtists"), CREDITS),
  repeated(atBound.patch("trackArtists"), CREDITS),
]);

/** Rewriting one album's artist links, as `TRACK_LINKS` does a song's, or their years. */
const ALBUM_LINKS = sumCost([
  atBound.read("albumArtists", LINKS_READ),
  repeated(atBound.delete("albumArtists"), LINKS_READ),
  repeated(atBound.patch("albumArtists"), CREDITS),
]);

/** Finding or making the artists of one list of credits. */
const CREDITED_ARTISTS = repeated(
  sumCost([atBound.read("artists"), atBound.patch("artists")]),
  CREDITS,
);

/** The credit strings one song's tags name in one string: its artist and its featured lists. */
const SONG_STRINGS = 1 + MAX_FEATURED_LISTS;

/**
 * The credit strings one song's tags name, gained or lost and settled at the call's end: its
 * combined ones, each recorded, or its separate values of one part.
 */
const SONG_SOURCES = sumCost([
  repeated(sumCost([USE_RECORDING, COMBINED_SETTLING]), SONG_STRINGS),
  repeated(SINGLE_SETTLING, CREDITS),
]);

/**
 * The most one `recredit` or `recreditAlbum` costs, for `CatalogBatch.each`: a song read and
 * patched, its strings resolved, its artists found or made, its links rewritten, and each artist
 * it credited or credits settled and checked at the call's end.
 */
export const RECREDIT_COST = sumCost([
  atBound.read("tracks"),
  atBound.patch("tracks"),
  repeated(RESOLVING, SONG_STRINGS),
  CREDITED_ARTISTS,
  TRACK_LINKS,
  repeated(ARTIST_SETTLING, 2 * CREDITS),
  repeated(BARE_CHECK, LINKS_READ + 1),
  // Or an album's: read and patched, its string resolved, its links rewritten and settled.
  atBound.read("albums"),
  atBound.patch("albums"),
  RESOLVING,
  ALBUM_LINKS,
  ALBUM_SETTLING,
]);

/**
 * The most one write of a batch costs, with every document at its bound: a move onto a path
 * another track holds, with its lyrics row rewritten (two rows read and the new sets walked), a
 * removed track's LRCLIB answer deleted, and three albums settled at the call's end (the one it
 * joins, which it may make or adopt from a release before credits, the one it leaves, and the one
 * the other track leaves), two of them perhaps emptied. Its credits add each credit string
 * resolved (its artist, two featured lists, its album artist), the artists of its credits and its
 * album's found or made, its links and its album's rewritten, each artist of the moved track,
 * of the track it replaces, and of the new credits settled, each artist a link left checked, the
 * credit strings its tags gained and lost and those of the track left missing at the old path
 * settled, and the credit strings of each of the three albums. Every other write costs less.
 */
const WRITE_MOST = sumCost([
  atBound.read("tracks"),
  atBound.read("tracks"),
  atBound.read("albums"),
  atBound.read("artists"),
  atBound.read("albums", 4),
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
  // A removed track's LRCLIB answer, and the second row a defect may have left.
  atBound.read("lrclibLyrics", LYRICS_ROWS_READ),
  atBound.delete("lrclibLyrics"),
  atBound.delete("lrclibLyrics"),
  atBound.lyrics(LYRICS_ROWS_READ),
  repeated(RESOLVING, SONG_STRINGS + 1),
  CREDITED_ARTISTS,
  CREDITED_ARTISTS,
  TRACK_LINKS,
  ALBUM_LINKS,
  repeated(SONG_SOURCES, 3),
  repeated(ALBUM_SOURCES_SETTLING, 3),
  repeated(ARTIST_SETTLING, 3 * CREDITS),
  repeated(BARE_CHECK, LINKS_READ + 1),
  ALBUM_SETTLING,
  ALBUM_SETTLING,
  ALBUM_SETTLING,
  EMPTYING,
  EMPTYING,
]);

/** A change in an album's tracks on disk and their length. */
interface AlbumDelta {
  readonly tracks: number;
  readonly durationMs: number;
}

/** How one upsert changes the artwork of the album and first artist a track files under. */
interface ArtChange {
  /** The track's row before the upsert, or null for a new one. */
  readonly previous: string | null;
  /** The artwork the scan found for it. */
  readonly next: string | null;
  /** The folder cover beside it was replaced, added, or removed since the last scan. */
  readonly coverChanged: boolean;
}

/**
 * The artwork an album or artist keeps after an upsert: a row without art takes the track's; a row
 * whose art came from this track follows a replaced cover, or falls back to another track's art
 * when this one's went; any other row keeps its own.
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

/** The artwork of the first of `tracks` that is not `except`. */
const firstArt = (tracks: ReadonlyArray<Doc<"tracks">>, except: Id<"tracks"> | null) =>
  tracks.find((track) => track._id !== except)?.artHash ?? null;

/**
 * What a scanned file's album files under: the album artist as the tags name it, its key, its
 * separate values when the tags hold them, and the album's key. One album per library, album
 * artist key, separate values or not, and key: splitting the album artist into credits never
 * merges or divides albums.
 */
interface Filing {
  readonly albumArtist: string;
  readonly artistKey: string;
  readonly tagged: ReadonlyArray<string> | null;
  readonly albumKey: string;
  /**
   * The keys of the artists a release before credits may have filed the album under: its album
   * artist as shown, and the first separate value, which that release read alone.
   */
  readonly before: ReadonlyArray<string>;
}

const filingOf = (scanned: ScannedTrack): Filing => {
  const albumArtist = nameWithin(scanned.albumArtist ?? scanned.artist);

  const values =
    scanned.albumArtists ?? (scanned.albumArtist === undefined ? scanned.artists : undefined);

  const tagged = taggedNames(values);

  return {
    albumArtist,
    artistKey: keyOf(albumArtist),
    tagged,
    albumKey: keyOf(scanned.album),
    before: [...new Set([albumArtist, ...(tagged ?? []).slice(0, 1)].map(keyOf))],
  };
};

/** The cache key of an album by its filing. */
const filingKeyOf = (filing: Filing): string =>
  `${filing.artistKey}\u0000${filing.tagged === null ? "" : "tagged"}\u0000${filing.albumKey}`;

/** Asks for a recheck of every combined credit string the named parts are in, once committed. */
export type Rechecks = (partKeys: ReadonlyArray<string>) => Promise<void>;

/**
 * The catalog writes of one mutation in one library, through the music store, which charges the
 * call's meter for each read and write (`write.ts`). Songs of a batch mostly share albums and
 * artists, so it reads each album and artist once and keeps it, and it sums count changes and
 * settles them in `finish`, writing each album, artist, credit string, and total at most once a
 * call. Every change to which tracks a library holds, and to whom they and their albums credit,
 * goes through here, so its counts stay exact: an album's tracks on disk, an artist's albums with
 * tracks on disk and tracks on disk crediting them, and the library's totals of albums, artists,
 * tracks on disk, and their length.
 */
export interface CatalogBatch {
  /**
   * Runs `write` on the leading items while `whileBudget` admits another whose worst case is
   * `most`, an upsert's unless given.
   */
  readonly each: <Item, Result>(
    items: ReadonlyArray<Item>,
    write: (item: Item) => Promise<Result>,
    most?: Cost,
  ) => Promise<ReadonlyArray<Result>>;
  /**
   * Inserts or updates one scanned file, its album and the artists it and its album credit, and
   * its own lyrics. An album or first artist whose art came from this file's old art follows a
   * replaced or removed cover.
   */
  readonly upsert: (scanned: ScannedTrack) => Promise<Id<"tracks">>;
  /**
   * Moves the track at `from` to the scanned file's path and updates it as `upsert` does, keeping
   * its id. With no track at `from`, or another track at the new path, it upserts the file and
   * marks `from` missing instead, answering false.
   */
  readonly move: (from: string, scanned: ScannedTrack) => Promise<boolean>;
  /**
   * Marks a file that left the disk missing, keeping its row, and its tags stop being credit
   * evidence; answers whether it was on disk.
   */
  readonly markMissing: (path: string) => Promise<boolean>;
  /**
   * Saves lyrics a scan read again for a file whose audio did not change; answers whether the
   * library has the file.
   */
  readonly saveLyrics: (scanned: ScannedLyrics) => Promise<boolean>;
  /** Deletes a track with its lyrics and links, for the purge of a folder the library dropped. */
  readonly remove: (track: Doc<"tracks">) => Promise<void>;
  /**
   * Rewrites whom a song credits as its credit strings resolve now; answers whether that changed.
   * A song whose tags hold separate artist values, or that a release before credits wrote, keeps
   * its credits.
   */
  readonly recredit: (trackId: Id<"tracks">) => Promise<boolean>;
  /** Rewrites whom an album credits as its album artist resolves now, as `recredit` a song. */
  readonly recreditAlbum: (albumId: Id<"albums">) => Promise<boolean>;
  /**
   * Settles the call: patches each album and artist whose counts moved, moves the library's
   * album, artist, and duration totals, deletes each album the call left without any track,
   * settles the credit strings whose uses moved and asks for a recheck of those whose evidence
   * changed, and deletes each artist the call left credited by nothing. Answers the tracks on
   * disk it added and removed, for the core's item count, and the artwork some row stopped using,
   * which the server checks with `music/art:inUse` before it deletes any.
   */
  readonly finish: () => Promise<Counted<ReadonlyArray<string>>>;
}

export interface BatchOptions {
  /** False for a removed library's purge: its totals are already gone with it. */
  readonly totals?: boolean;
  /** What the call may spend, `CALL_COST` unless a test passes less. */
  readonly limit?: Cost;
}

/**
 * Starts the catalog writes of one mutation in `libraryId`, which ask `rechecks` for the
 * rechecks the credit evidence they changed needs. Call `finish` once at the end.
 */
export const catalogBatch = (
  store: MusicStore,
  libraryId: Id<"libraries">,
  rechecks: Rechecks,
  options: BatchOptions = {},
): CatalogBatch => {
  const artists = new Map<string, Stored<"artists"> | null>();
  const albums = new Map<string, Stored<"albums"> | null>();
  const madeArtists = new Set<Id<"artists">>();
  const deltas = new Map<Id<"albums">, AlbumDelta>();
  const losing = new Set<Id<"albums">>();
  const recredited = new Set<Id<"albums">>();
  /** An album's credits when the call first changed them: null for an album the call made. */
  const albumStart = new Map<Id<"albums">, AlbumCredits | null>();
  /** How the call moved each artist's tracks on disk that credit them. */
  const artistTracks = new Map<Id<"artists">, number>();
  /** Artists the call took a link or a first credit from, which may be credited by nothing now. */
  const bare = new Set<Id<"artists">>();
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

  const ledger = creditLedger(store, libraryId, owe);

  const release = (previous: string | null, next: string | null): void => {
    if (previous !== null && previous !== next) released.add(previous);
  };

  const touchAlbum = (albumId: Id<"albums">): void => {
    owe(`settle:${albumId}`, ALBUM_SETTLING);
  };

  /**
   * An album whose credit strings may start or stop being evidence: it gains or loses tracks on
   * disk, or what it names changes. `finish` settles them.
   */
  const mayMoveEvidence = (albumId: Id<"albums">): void => {
    owe(`evidence:${albumId}`, ALBUM_SOURCES_SETTLING);
  };

  const adjust = (albumId: Id<"albums">, tracks: number, length: number): void => {
    const previous = deltas.get(albumId) ?? { tracks: 0, durationMs: 0 };

    touchAlbum(albumId);

    if (tracks !== 0) mayMoveEvidence(albumId);

    deltas.set(albumId, {
      tracks: previous.tracks + tracks,
      durationMs: previous.durationMs + length,
    });
  };

  /** An album a track left, which `finish` deletes when no track row points at it any more. */
  const mayEmpty = (albumId: Id<"albums">): void => {
    touchAlbum(albumId);
    owe(`empty:${albumId}`, EMPTYING);
    losing.add(albumId);
  };

  /** A track that came onto the disk or left it, for the library's track and length totals. */
  const present = (track: { readonly durationMs: number }, step: 1 | -1): void => {
    if (step === 1) added += 1;
    else removed += 1;

    durationMs += step * track.durationMs;
  };

  /** Moves the tracks on disk crediting each of `artistIds` by `step`. */
  const countTracks = (artistIds: ReadonlyArray<Id<"artists">>, step: 1 | -1): void => {
    for (const artistId of artistIds) {
      owe(`artist:${artistId}`, ARTIST_SETTLING);
      artistTracks.set(artistId, (artistTracks.get(artistId) ?? 0) + step);
    }
  };

  const mayBeBare = (artistId: Id<"artists">): void => {
    owe(`bare:${artistId}`, BARE_CHECK);
    bare.add(artistId);
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

  /** The artist named `name` in the library, made with `artHash` when there is none. */
  const artistNamed = async (name: string, artHash: string | null): Promise<Stored<"artists">> => {
    const key = keyOf(name);
    const existing = await findArtist(key);

    if (existing !== null) return existing;

    const created = await store.insertArtist({
      libraryId,
      name,
      key,
      albumCount: 0,
      trackCount: 0,
      artHash,
      searchText: foldSearchText(name),
    });

    artists.set(key, created);
    madeArtists.add(created._id);

    return created;
  };

  /**
   * The credits for `names`, their artists found or made with `artHash`: one credit per artist,
   * and at least one, for the name a song or an album shows when its tags name none.
   */
  const creditsOf = async (
    names: ReadonlyArray<string>,
    fallback: string,
    artHash: string | null,
  ): Promise<{ readonly first: ArtistCredit; readonly all: ReadonlyArray<ArtistCredit> }> => {
    const listed = names.length > 0 ? names : [fallback];

    const found = await inOrder(listed, async (name) => ({
      artistId: (await artistNamed(name, artHash))._id,
      name,
    }));

    const credits = found.filter(
      (credit, index) => found.findIndex((one) => one.artistId === credit.artistId) === index,
    );

    const [first] = credits;

    if (first === undefined) throw new Error("A song or an album credits at least one artist");

    return { first, all: credits };
  };

  /** The names a song credits: its separate values, or its credit strings as they resolve now. */
  const songNamesOf = async (song: SongTags): Promise<ReadonlyArray<string>> => {
    if (song.tagged !== null) return song.tagged;

    const resolved = await inOrder(songSources(song), ledger.artistsOf);

    return namesWithin(distinctNames(resolved.flat()));
  };

  /** Rewrites a song's artist links to its credits, inserting them all for a new song. */
  const linkTrack = async (
    trackId: Id<"tracks">,
    credits: ReadonlyArray<ArtistCredit>,
    titleKey: string,
    fresh: boolean,
  ): Promise<void> => {
    const links = fresh
      ? []
      : await store.take(
          "trackArtists",
          (q) => q.withIndex("by_track", (index) => index.eq("trackId", trackId)),
          LINKS_READ,
        );

    const { stale, kept } = sortLinks(links, credits);

    for (const link of stale) mayBeBare(link.artistId);

    await Promise.all([
      ...stale.map(async (link) => store.deleteTrackArtist(link._id)),
      ...kept
        .filter((link) => link.titleKey !== titleKey)
        .map(async (link) => store.setTrackArtistTitle(link._id, titleKey)),
      ...unlinked(kept, credits).map(async (credit) =>
        store.insertTrackArtist({ libraryId, artistId: credit.artistId, trackId, titleKey }),
      ),
    ]);
  };

  /** Rewrites an album's artist links to its credits, as `linkTrack` a song's. */
  const linkAlbum = async (
    album: Pick<Doc<"albums">, "_id" | "year">,
    credits: ReadonlyArray<ArtistCredit>,
    fresh: boolean,
  ): Promise<void> => {
    const links = fresh
      ? []
      : await store.take(
          "albumArtists",
          (q) => q.withIndex("by_album", (index) => index.eq("albumId", album._id)),
          LINKS_READ,
        );

    const { stale, kept } = sortLinks(links, credits);

    for (const link of stale) mayBeBare(link.artistId);

    await Promise.all([
      ...stale.map(async (link) => store.deleteAlbumArtist(link._id)),
      ...kept
        .filter((link) => link.year !== album.year)
        .map(async (link) => store.setAlbumArtistYear(link._id, album.year)),
      ...unlinked(kept, credits).map(async (credit) =>
        store.insertAlbumArtist({
          libraryId,
          artistId: credit.artistId,
          albumId: album._id,
          year: album.year,
        }),
      ),
    ]);
  };

  /** Notes an album whose credits the call changes, with whom it credited before. */
  const recreditedAlbum = (album: Stored<"albums">): void => {
    touchAlbum(album._id);
    recredited.add(album._id);

    if (!albumStart.has(album._id)) albumStart.set(album._id, album);
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

  /** The artwork of a song's first artist after an upsert (`keptArt`). */
  const followArt = async (
    artistId: Id<"artists">,
    name: string,
    art: ArtChange,
    except: Id<"tracks"> | null,
  ): Promise<void> => {
    const key = keyOf(name);
    const existing = await findArtist(key);

    if (existing?._id !== artistId) return;

    const artHash = await keptArt(existing.artHash, art, () => artistArt(existing._id, except));

    if (artHash === existing.artHash) return;

    await store.setArtistArt(existing._id, artHash);
    release(existing.artHash, artHash);
    artists.set(key, { ...existing, artHash });
  };

  /** An album a release before credits filed under the artist keyed `artistKey`. */
  const albumFiledUnder = async (
    artistKey: string,
    albumKey: string,
  ): Promise<Stored<"albums"> | null> => {
    const artist = await findArtist(artistKey);

    if (artist === null || madeArtists.has(artist._id)) return null;

    const candidates = await store.take(
      "albums",
      (q) =>
        q.withIndex("by_library_artist_key", (index) =>
          index.eq("libraryId", libraryId).eq("artistId", artist._id).eq("key", albumKey),
        ),
      4,
    );

    return candidates.find((album) => album.artistKey === undefined) ?? null;
  };

  /**
   * An album a release before credits filed as `filing` names it, which its first scan since
   * adopts; none under an artist the call made.
   */
  const albumBeforeCredits = async (
    filing: Filing,
    keys: ReadonlyArray<string> = filing.before,
  ): Promise<Stored<"albums"> | null> => {
    const [key, ...rest] = keys;

    if (key === undefined) return null;

    return (await albumFiledUnder(key, filing.albumKey)) ?? albumBeforeCredits(filing, rest);
  };

  /** The album a filing names, read once a call. */
  const findAlbum = async (filing: Filing): Promise<Stored<"albums"> | null> => {
    const cacheKey = filingKeyOf(filing);

    if (!albums.has(cacheKey)) {
      const filed = await store.first("albums", (q) =>
        q.withIndex("by_library_filing", (index) =>
          index
            .eq("libraryId", libraryId)
            .eq("artistKey", filing.artistKey)
            .eq("creditsTagged", filing.tagged !== null)
            .eq("key", filing.albumKey),
        ),
      );

      albums.set(cacheKey, filed ?? (await albumBeforeCredits(filing)));
    }

    return albums.get(cacheKey) ?? null;
  };

  /** The names an album credits: its separate values, or its album artist as it resolves now. */
  const albumNamesOf = async (
    albumArtist: string,
    tagged: ReadonlyArray<string> | null,
  ): Promise<ReadonlyArray<string>> => tagged ?? namesWithin(await ledger.artistsOf(albumArtist));

  /**
   * Credits an album as its album artist `artistName`, keyed `artistKey`, names it now: its
   * separate values `tagged`, or the string as it resolves now. Writes the album's credits and
   * links when they change, and answers the album as it is then, with whether they changed. A row
   * a release before credits wrote takes its album artist key and credits here.
   */
  const creditAlbum = async (
    album: Stored<"albums">,
    named: {
      readonly artistName: string;
      readonly artistKey: string;
      readonly tagged: ReadonlyArray<string> | null;
    },
    artHash: string | null,
  ): Promise<{ readonly album: Stored<"albums">; readonly changed: boolean }> => {
    const credits = await creditsOf(
      await albumNamesOf(named.artistName, named.tagged),
      named.artistName,
      artHash,
    );

    const changes = {
      artistId: credits.first.artistId,
      artistName: named.artistName,
      artistKey: named.artistKey,
      credits: [...credits.all],
      creditsTagged: named.tagged !== null,
    };

    if (
      album.credits !== undefined &&
      album.artistName === changes.artistName &&
      album.artistKey === changes.artistKey &&
      album.creditsTagged === changes.creditsTagged &&
      sameCredits(credits.all, album.credits)
    ) {
      return { album, changed: false };
    }

    recreditedAlbum(album);
    await store.setAlbumCredits(album._id, changes);
    await linkAlbum(album, credits.all, false);

    if (album.artistId !== changes.artistId) mayBeBare(album.artistId);

    const updated = { ...album, ...changes };
    const before = albumSources(album);
    const after = albumSources(updated);

    if (without(after, before).length > 0 || without(before, after).length > 0) {
      mayMoveEvidence(album._id);
    }

    return { album: updated, changed: true };
  };

  const albumFor = async (
    scanned: ScannedTrack,
    filing: Filing,
    art: ArtChange,
    except: Id<"tracks"> | null,
  ): Promise<Stored<"albums">> => {
    const cacheKey = filingKeyOf(filing);
    const found = await findAlbum(filing);

    if (found === null) {
      const credits = await creditsOf(
        await albumNamesOf(filing.albumArtist, filing.tagged),
        filing.albumArtist,
        art.next,
      );

      const created = await store.insertAlbum({
        libraryId,
        artistId: credits.first.artistId,
        artistName: filing.albumArtist,
        artistKey: filing.artistKey,
        credits: [...credits.all],
        creditsTagged: filing.tagged !== null,
        title: scanned.album,
        key: filing.albumKey,
        year: scanned.year ?? null,
        genre: scanned.genre ?? null,
        artHash: art.next,
        trackCount: 0,
        durationMs: 0,
        format: formatLabel(scanned),
        addedAt: Date.now(),
        searchText: foldSearchText(`${scanned.album} ${filing.albumArtist}`),
      });

      albums.set(cacheKey, created);
      albumStart.set(created._id, null);
      touchAlbum(created._id);
      await linkAlbum(created, credits.all, true);

      return created;
    }

    // Separate album artist values credit the album as the file a scan read last names them,
    // and an album artist string as it resolves now, which may have changed while the album had
    // no track on disk. A release before credits filed separate values under the first alone.
    const credited = await creditAlbum(
      found,
      {
        artistName:
          found.artistKey === undefined && filing.tagged !== null
            ? filing.albumArtist
            : found.artistName,
        artistKey: filing.artistKey,
        tagged: filing.tagged,
      },
      art.next,
    );

    const existing = credited.album;
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
      albums.set(cacheKey, existing);

      return existing;
    }

    await store.setAlbumTags(existing._id, changes);
    release(existing.artHash, artHash);

    const updated = { ...existing, ...changes };

    if (changes.year !== existing.year && updated.credits !== undefined) {
      await linkAlbum(updated, updated.credits, false);
    }

    albums.set(cacheKey, updated);

    return updated;
  };

  /**
   * Writes `scanned` over `existing`, the track already at its path or the one a move brings
   * there, or null for a new track, with the album it files under and the artists it credits.
   */
  const upsertOver = async (
    scanned: ScannedTrack,
    existing: Doc<"tracks"> | null,
  ): Promise<Id<"tracks">> => {
    const filing = filingOf(scanned);
    const tagged = taggedNames(scanned.artists);
    const sets = fittedSets(scanned.lyrics);
    const fields = await trackFields(scanned, sets, tagged);
    const song: SongTags = { artistName: fields.artistName, title: fields.title, tagged };
    const except = existing?._id ?? null;

    const art: ArtChange = {
      previous: existing?.artHash ?? null,
      next: fields.artHash,
      coverChanged: existing !== null && existing.folderArt !== fields.folderArt,
    };

    const names = await songNamesOf(song);
    const filedAlbum = await albumFor(scanned, filing, art, except);
    const credits = await creditsOf(names, fields.artistName, art.next);

    await followArt(credits.first.artistId, credits.first.name, art, except);

    const placed = {
      ...fields,
      libraryId,
      albumId: filedAlbum._id,
      artistId: credits.first.artistId,
      credits: [...credits.all],
    };

    const creditIds = credits.all.map((credit) => credit.artistId);
    const sources = songSources(song);

    if (existing === null) {
      const trackId = await store.insertTrack(placed, sets);

      await linkTrack(trackId, credits.all, fields.titleKey, true);
      countTracks(creditIds, 1);
      await ledger.use({ trackId, gained: sources, lost: [] });
      adjust(filedAlbum._id, 1, fields.durationMs);
      present(fields, 1);

      return trackId;
    }

    await store.writeTrack(existing._id, placed);
    await store.writeLyrics(existing._id, sets);
    release(existing.artHash, fields.artHash);
    await linkTrack(existing._id, credits.all, fields.titleKey, false);

    if (!existing.missing) countTracks(existing.credits?.map((one) => one.artistId) ?? [], -1);
    countTracks(creditIds, 1);

    if (existing.artistId !== credits.first.artistId) mayBeBare(existing.artistId);

    const before = storedSongSources(existing);

    await ledger.use({
      trackId: existing._id,
      gained: without(sources, before),
      lost: without(before, sources),
    });

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

  /**
   * Marks `track` missing when it is on disk, so its credit strings stop being evidence; answers
   * whether it was.
   */
  const markGone = async (track: Doc<"tracks"> | null): Promise<boolean> => {
    if (track === null || track.missing) return false;

    await store.setTrackMissing(track._id);
    await ledger.use({ trackId: track._id, gained: [], lost: storedSongSources(track) });
    countTracks(track.credits?.map((credit) => credit.artistId) ?? [], -1);
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
    await store.deleteLrclibLyrics(track._id);

    const links = await store.take(
      "trackArtists",
      (q) => q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
      LINKS_READ,
    );

    for (const link of links) mayBeBare(link.artistId);

    await Promise.all(links.map(async (link) => store.deleteTrackArtist(link._id)));
    mayBeBare(track.artistId);
    await ledger.use({ trackId: track._id, gained: [], lost: storedSongSources(track) });
    await store.deleteTrack(track._id);
    mayEmpty(track.albumId);

    if (!track.missing) {
      countTracks(track.credits?.map((credit) => credit.artistId) ?? [], -1);
      adjust(track.albumId, -1, -track.durationMs);
      present(track, -1);
    }
  };

  const recredit = async (trackId: Id<"tracks">): Promise<boolean> => {
    const track = await store.get("tracks", trackId);

    if (track?.credits === undefined || track.creditsTagged === true) return false;

    const names = await songNamesOf({
      artistName: track.artistName,
      title: track.title,
      tagged: null,
    });

    const credits = await creditsOf(names, track.artistName, track.artHash);

    if (sameCredits(credits.all, track.credits)) return false;

    await store.setTrackCredits(track._id, {
      artistId: credits.first.artistId,
      credits: [...credits.all],
    });

    await linkTrack(track._id, credits.all, track.titleKey, false);

    if (!track.missing) {
      countTracks(
        track.credits.map((credit) => credit.artistId),
        -1,
      );
      countTracks(
        credits.all.map((credit) => credit.artistId),
        1,
      );
    }

    if (track.artistId !== credits.first.artistId) mayBeBare(track.artistId);

    return true;
  };

  const recreditAlbum = async (albumId: Id<"albums">): Promise<boolean> => {
    const album = await store.get("albums", albumId);

    if (album?.credits === undefined || album.creditsTagged === true) return false;

    const credited = await creditAlbum(
      album,
      {
        artistName: album.artistName,
        artistKey: album.artistKey ?? keyOf(album.artistName),
        tagged: null,
      },
      album.artHash,
    );

    return credited.changed;
  };

  /** Deletes an artist nothing credits or files under any more, answering the artwork it held. */
  const deleteIfBare = async (artistId: Id<"artists">): Promise<string | null> => {
    const artist = await store.get("artists", artistId);

    if (artist === null || artist.albumCount > 0 || (artist.trackCount ?? 0) > 0) return null;

    const [albumLink, trackLink, album, track] = await Promise.all([
      store.first("albumArtists", (q) =>
        q.withIndex("by_artist_year", (index) => index.eq("artistId", artistId)),
      ),
      store.first("trackArtists", (q) =>
        q.withIndex("by_artist_title", (index) => index.eq("artistId", artistId)),
      ),
      // A first credit, or an album or a track a release before credits filed under the artist.
      store.first("albums", (q) =>
        q.withIndex("by_artist", (index) => index.eq("artistId", artistId)),
      ),
      store.first("tracks", (q) =>
        q.withIndex("by_artist", (index) => index.eq("artistId", artistId)),
      ),
    ]);

    if (albumLink !== null || trackLink !== null || album !== null || track !== null) return null;

    await store.deleteArtist(artistId);

    return artist.artHash;
  };

  /** Deletes an album no track points at any more, with its links. */
  const deleteIfEmpty = async (album: Doc<"albums">): Promise<void> => {
    const track = await store.first("tracks", (q) =>
      q.withIndex("by_album", (index) => index.eq("albumId", album._id)),
    );

    if (track !== null) return;

    const links = await store.take(
      "albumArtists",
      (q) => q.withIndex("by_album", (index) => index.eq("albumId", album._id)),
      LINKS_READ,
    );

    for (const link of links) mayBeBare(link.artistId);

    await Promise.all(links.map(async (link) => store.deleteAlbumArtist(link._id)));
    mayBeBare(album.artistId);
    await store.deleteAlbum(album._id);
    release(album.artHash, null);
  };

  const finish = async (): Promise<Counted<ReadonlyArray<string>>> => {
    const artistAlbums = new Map<Id<"artists">, number>();
    const emptied: Array<Doc<"albums">> = [];
    let albumsMoved = 0;

    const stepAlbums = (artistIds: ReadonlyArray<Id<"artists">>, step: number): void => {
      for (const artistId of artistIds) {
        artistAlbums.set(artistId, (artistAlbums.get(artistId) ?? 0) + step);
      }
    };

    const settled = await Promise.all(
      [...new Set([...deltas.keys(), ...losing, ...recredited])].map(async (albumId) =>
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

        const before = Number(album.trackCount > 0);
        const after = Number(trackCount > 0);
        const start = albumStart.has(album._id) ? (albumStart.get(album._id) ?? null) : album;

        albumsMoved += after - before;
        stepAlbums(start === null ? [] : creditIdsOf(start), -before);
        stepAlbums(creditIdsOf(album), after);

        // An album's credit strings are evidence while it has a track on disk.
        const named = before === 1 && start !== null ? albumSources(start) : [];
        const naming = after === 1 ? albumSources(album) : [];

        await ledger.use({
          trackId: null,
          gained: without(naming, named),
          lost: without(named, naming),
        });
      }),
    );

    let artistsMoved = 0;

    await Promise.all(
      [...new Set([...artistAlbums.keys(), ...artistTracks.keys()])].map(async (artistId) => {
        const albumStep = artistAlbums.get(artistId) ?? 0;
        const trackStep = artistTracks.get(artistId) ?? 0;

        const artist =
          albumStep === 0 && trackStep === 0 ? null : await store.get("artists", artistId);

        if (artist === null) return;

        const counts = {
          albumCount: artist.albumCount + albumStep,
          trackCount: (artist.trackCount ?? 0) + trackStep,
        };

        await store.setArtistCounts(artistId, counts);
        artistsMoved +=
          shows(counts.albumCount, counts.trackCount) -
          shows(artist.albumCount, artist.trackCount ?? 0);
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

    const evidence = await ledger.settle();

    await inOrder(
      Array.from({ length: Math.ceil(evidence.length / RECHECK_KEYS) }, (_, index) =>
        evidence.slice(index * RECHECK_KEYS, (index + 1) * RECHECK_KEYS),
      ),
      async (keys) => {
        store.meter.charge(repeated(SCHEDULING, keys.length));
        await rechecks(keys);
      },
    );

    const freed = await inOrder([...bare], deleteIfBare);

    for (const artHash of freed) release(artHash, null);

    return { value: [...released], added, removed };
  };

  return {
    each: async (items, write, most = WRITE_MOST) => {
      await ledger.prepare();

      return whileBudget(store.meter, options.limit ?? CALL_COST, most, items, write);
    },
    upsert,
    move,
    markMissing,
    saveLyrics,
    remove,
    recredit,
    recreditAlbum,
    finish,
  };
};
