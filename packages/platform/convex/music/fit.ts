import type { WithoutSystemFields } from "convex/server";
import { getConvexSize, getDocumentSize } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import { sha256Hex } from "../core/lib/secrets";
import { cut, uniqueWithin } from "../movies/bounds";
import type { musicTables } from "./schema";
import type { LocalLyricSet } from "./validators";

/**
 * The longest fields the music tables keep (ADR 0024), in UTF-16 code units. The music writer
 * applies them to every document it writes, so no document passes its bound in `DOCUMENT_BYTES`
 * and reads may reserve that bound for it (ADR 0005). Unlike movies, music has no long free text,
 * so each field has a fixed maximum and no document needs fitting as a whole. Display text over
 * its maximum is cut; a key or a fingerprint keeps its leading part and a hash of the whole
 * (`uniqueWithin`), so distinct values stay distinct and a rescan finds the row it wrote; an
 * artwork hash over its maximum is dropped, since a cut one would name other artwork.
 */
export const MUSIC_BOUNDS = {
  /** A track's title, artist, and album as shown, and an album's or artist's name. */
  name: 512,
  /** An artist's or album's key, which identifies it within its library across scans. */
  key: 512,
  /** A track's title key, which only orders tracks. */
  sortKey: 128,
  /** Folded text a search index matches. */
  searchText: 1024,
  /** A genre, a codec, or an album's format label. */
  label: 96,
  /** An artwork hash as the server stores it, 64 hex digits today. */
  artHash: 128,
  /** A file's folder artwork or lyric files as a scan fingerprints them. */
  fingerprint: 1024,
  /** A track's length in milliseconds, about 50 days: a million of them still sum safely. */
  durationMs: 2 ** 32,
  /** A playlist's name, in UTF-16 code units: old music's `Name`. */
  playlistName: 120,
  /** A playlist's description, in UTF-16 code units: old music's `Description`. */
  playlistDescription: 500,
  /** The playback id a play keeps, as `music.play.start` makes it. */
  playbackId: 64,
} as const;

/**
 * The most bytes, as Convex measures a document, each kind of music document is kept within by
 * the music writer. A track at its bound has a 4,096-byte path and every text at its maximum in
 * 3-byte characters, about 20 KiB. A lyrics row keeps its leading lyric sets within its bound.
 */
export const DOCUMENT_BYTES = {
  tracks: 24 * 1024,
  albums: 12 * 1024,
  artists: 8 * 1024,
  localLyrics: 512 * 1024,
  /** A name and a description at their maximums in 3-byte characters, and a few numbers. */
  playlists: 4 * 1024,
  /** Ids, numbers, and a tie: a person's rows hold no free text but a playback id. */
  small: 1024,
} as const;

/** Every music table's bound, typed over the schema's tables, so a table added without one fails. */
export const TABLE_BYTES = {
  artists: DOCUMENT_BYTES.artists,
  albums: DOCUMENT_BYTES.albums,
  tracks: DOCUMENT_BYTES.tracks,
  localLyrics: DOCUMENT_BYTES.localLyrics,
  playlists: DOCUMENT_BYTES.playlists,
  playlistItems: DOCUMENT_BYTES.small,
  likes: DOCUMENT_BYTES.small,
  plays: DOCUMENT_BYTES.small,
  playQueues: DOCUMENT_BYTES.small,
  playQueueEntries: DOCUMENT_BYTES.small,
} as const satisfies { readonly [Table in keyof typeof musicTables]: number };

const name = (text: string): string => cut(text, MUSIC_BOUNDS.name);

const label = (text: string): string => cut(text, MUSIC_BOUNDS.label);

const searchable = (text: string): string => cut(text, MUSIC_BOUNDS.searchText);

/** A folder artwork or lyric files fingerprint as `tracks` keeps it, which a scan compares. */
export const fingerprint = (text: string): string => uniqueWithin(text, MUSIC_BOUNDS.fingerprint);

/** An artwork hash within its maximum, or null when there is none or it is over it. */
export const artHashWithin = (hash: string | null | undefined): string | null =>
  hash === null || hash === undefined || hash.length === 0 || hash.length > MUSIC_BOUNDS.artHash
    ? null
    : hash;

/** An artist's or album's key for a name: trimmed, lowercased, and within the key maximum. */
export const keyOf = (text: string): string =>
  uniqueWithin(text.trim().toLowerCase(), MUSIC_BOUNDS.key);

/** A track's title key: trimmed, lowercased, and cut, since it only orders tracks. */
export const titleKeyOf = (text: string): string =>
  cut(text.trim().toLowerCase(), MUSIC_BOUNDS.sortKey);

type Fields<T extends keyof typeof musicTables> = WithoutSystemFields<Doc<T>>;

/** A track's text fields, which the writer keeps within their maximums. */
export type TrackText = Pick<
  Fields<"tracks">,
  | "title"
  | "titleKey"
  | "artistName"
  | "albumTitle"
  | "codec"
  | "searchText"
  | "lyricsFiles"
  | "artHash"
  | "folderArt"
>;

/** A genre or a label within its maximum, or null for none. */
export const labelWithin = (text: string | null): string | null =>
  text === null ? null : label(text);

/** A folder artwork fingerprint within its maximum, or null for none. */
const folderArtWithin = (text: string | null): string | null =>
  text === null ? null : fingerprint(text);

/** A track's fields within their maximums. Its path is a scan's to keep within 4,096 bytes. */
export const fitTrack = <Track extends TrackText>(track: Track): Track => ({
  ...track,
  title: name(track.title),
  titleKey: cut(track.titleKey, MUSIC_BOUNDS.sortKey),
  artistName: name(track.artistName),
  albumTitle: name(track.albumTitle),
  codec: label(track.codec),
  searchText: searchable(track.searchText),
  lyricsFiles: fingerprint(track.lyricsFiles),
  artHash: artHashWithin(track.artHash),
  folderArt: folderArtWithin(track.folderArt),
});

/** An album's fields within their maximums. */
export const fitAlbum = (album: Fields<"albums">): Fields<"albums"> => ({
  ...album,
  title: name(album.title),
  artistName: name(album.artistName),
  key: uniqueWithin(album.key, MUSIC_BOUNDS.key),
  genre: labelWithin(album.genre),
  format: label(album.format),
  searchText: searchable(album.searchText),
  artHash: artHashWithin(album.artHash),
});

/** An artist's fields within their maximums. */
export const fitArtist = (artist: Fields<"artists">): Fields<"artists"> => ({
  ...artist,
  name: name(artist.name),
  key: uniqueWithin(artist.key, MUSIC_BOUNDS.key),
  searchText: searchable(artist.searchText),
  artHash: artHashWithin(artist.artHash),
});

/** A playlist's name within its maximum. */
export const playlistNameWithin = (typed: string): string => cut(typed, MUSIC_BOUNDS.playlistName);

/** A playlist's description within its maximum, or null for none. */
export const descriptionWithin = (description: string | null): string | null =>
  description === null ? null : cut(description, MUSIC_BOUNDS.playlistDescription);

/** A play's playback id within its maximum, which `music.play.report` checks before it writes. */
export const fitPlay = (play: Fields<"plays">): Fields<"plays"> => ({
  ...play,
  playbackId: play.playbackId === null ? null : cut(play.playbackId, MUSIC_BOUNDS.playbackId),
});

/** Room a lyrics row's `trackId` and field names take beside its sets, in Convex's measure. */
const LYRICS_ROW_OVERHEAD = 128;

const EMPTY_LYRICS_ROW = getDocumentSize({ sets: [] }) + LYRICS_ROW_OVERHEAD;

const setsBytes = (sets: ReadonlyArray<LocalLyricSet>): number =>
  getDocumentSize({ sets: [...sets] }) + LYRICS_ROW_OVERHEAD;

/**
 * A file's lyric sets within the lyrics row's bound: the leading sets that fit, in the order the
 * server found them, so the main lyrics it found first stay. Lyrics are never refused for size.
 * Convex sizes an array as a fixed marker plus its elements, so each set adds its own size.
 */
export const fitLyrics = (sets: ReadonlyArray<LocalLyricSet>): ReadonlyArray<LocalLyricSet> => {
  let bytes = EMPTY_LYRICS_ROW;

  for (const [index, set] of sets.entries()) {
    bytes += getConvexSize(set);

    if (bytes > DOCUMENT_BYTES.localLyrics) return sets.slice(0, index);
  }

  return sets;
};

type LyricOrigin = LocalLyricSet["origin"];

type LyricBody = LocalLyricSet["body"];

type LyricLine = Extract<LyricBody, { readonly lines: unknown }>["lines"][number];

type LyricWord = NonNullable<LyricLine["words"]>[number];

const sameList = <Item>(
  left: ReadonlyArray<Item>,
  right: ReadonlyArray<Item>,
  same: (one: Item, other: Item) => boolean,
): boolean =>
  left.length === right.length &&
  left.every((one, index) => {
    const other = right[index];

    return other !== undefined && same(one, other);
  });

/** Numbers as Convex stores them: `-0` is not `0`, and `NaN` is itself. */
const sameNumber = (one: number | null, other: number | null): boolean => Object.is(one, other);

const sameWord = (one: LyricWord, other: LyricWord): boolean =>
  one.text === other.text &&
  sameNumber(one.startMs, other.startMs) &&
  sameNumber(one.endMs, other.endMs);

const sameLine = (one: LyricLine, other: LyricLine): boolean =>
  one.text === other.text &&
  sameNumber(one.startMs, other.startMs) &&
  sameNumber(one.endMs, other.endMs) &&
  one.voice === other.voice &&
  (one.words === null || other.words === null
    ? one.words === other.words
    : sameList(one.words, other.words, sameWord));

const sameOrigin = (one: LyricOrigin, other: LyricOrigin): boolean =>
  "fileName" in one
    ? "fileName" in other && one.fileName === other.fileName && one.format === other.format
    : "tag" in other && one.tag === other.tag;

const sameBody = (one: LyricBody, other: LyricBody): boolean =>
  "text" in one
    ? "text" in other && one.text === other.text
    : "lines" in other && sameList(one.lines, other.lines, sameLine);

const sameSet = (one: LocalLyricSet, other: LocalLyricSet): boolean =>
  one.kind === other.kind &&
  one.lang === other.lang &&
  sameOrigin(one.origin, other.origin) &&
  sameBody(one.body, other.body);

/**
 * Whether two lists of lyric sets hold the same sets in the same order, field by field and in any
 * field order, as Convex hands back a stored object's fields in its own. It walks the sets' known
 * shape and stops at the first difference: Convex's generic `compareValues` took about 5 µs a set,
 * so a call rescanning dense lyrics ran out of its 1 s.
 */
export const sameLyrics = (
  one: ReadonlyArray<LocalLyricSet>,
  other: ReadonlyArray<LocalLyricSet>,
): boolean => sameList(one, other, sameSet);

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

const isMillis = (value: number): boolean => Number.isFinite(value) && value >= 0;

const timed = (item: { readonly startMs: number; readonly endMs: number | null }): boolean =>
  isMillis(item.startMs) && (item.endMs === null || isMillis(item.endMs));

const setProblem = (set: LocalLyricSet): string | null => {
  if (set.lang !== null && !LANG.test(set.lang)) return `language ${set.lang} is not a BCP 47 tag`;

  if ("fileName" in set.origin && set.origin.fileName.length === 0) {
    return "a lyric file has no name";
  }

  if ("text" in set.body) return set.body.text.length === 0 ? "plain lyrics are empty" : null;

  if (set.body.lines.length === 0) return "synced lyrics have no lines";

  const line = set.body.lines.find(
    (one) =>
      !timed(one) || (one.words !== null && (one.words.length === 0 || !one.words.every(timed))),
  );

  return line === undefined ? null : `the line "${cut(line.text, 64)}" has a bad time or no words`;
};

/**
 * Checks lyric sets as old music's `LocalLyricSet` schema did, past what the validator checks: a
 * language is a BCP 47 tag, a lyric file has a name, plain text and synced lines are not empty,
 * and every time is a finite number of milliseconds of at least 0.
 *
 * @throws Error on a set that breaks one, a defect in the server's lyrics reader, which checks
 * the same schema before it sends them.
 */
export const checkLyrics = (sets: ReadonlyArray<LocalLyricSet>): void => {
  const problem = sets.map(setProblem).find((one) => one !== null) ?? null;

  if (problem !== null) throw new Error(`Lyrics are not lyric sets: ${problem}`);
};

/** What a track keeps about its own lyrics, for the sets the writer stores. */
export interface LyricsFields {
  readonly lyricsBytes: number | null;
  readonly lyricsHash: string | null;
  readonly lyricsSynced: boolean;
}

/**
 * The fields a track keeps about lyric sets, already fitted, which its row stores. The hash is
 * Web Crypto's, as old music's was: the synchronous one in `core/lib/sha256.ts` took about 14 ms
 * for a row of dense sets.
 */
export const lyricsFieldsOf = async (sets: ReadonlyArray<LocalLyricSet>): Promise<LyricsFields> =>
  sets.length === 0
    ? { lyricsBytes: null, lyricsHash: null, lyricsSynced: false }
    : {
        lyricsBytes: setsBytes(sets),
        lyricsHash: await sha256Hex(JSON.stringify(sets)),
        lyricsSynced: sets.some((set) => set.kind === "main" && "lines" in set.body),
      };
