/**
 * Music as the server reads it from disk and sends it to the core's music scanner functions
 * (`music/scanner:*`): a song's tags, its own lyrics, and what a scan compares to skip unchanged
 * files. The shapes are old music's (`@music/commands/lyrics` and `media-backend.ts`), which the
 * core's `music/validators.ts` stores as they are.
 */
import { Option, Schema } from "effect";

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

/** A BCP 47 language tag in canonical case, such as `en`, `pt-BR`, or `ja-Latn`. */
export const Lang = Schema.String.check(Schema.isPattern(LANG)).pipe(Schema.brand("Lang"));

/** A language tag. */
export type Lang = typeof Lang.Type;

const decodeLang = Schema.decodeOption(Lang);

/** Tags that name no language: ID3's `XXX` filler, undetermined, and no linguistic content. */
const NO_LANGUAGE: ReadonlySet<string> = new Set(["xxx", "und", "zxx"]);

/**
 * Reads a language tag as files and tags write it (`eng`, `en_US`, `PT-br`) into its canonical
 * BCP 47 form. ISO 639-2 codes fold to their two-letter form where one exists (`eng` is `en`).
 *
 * @returns The language, or null when the text names none or is not a language tag.
 */
export const parseLang = (tag: string): Lang | null => {
  const candidate = tag.trim().replaceAll("_", "-");

  if (!LANG.test(candidate.toLowerCase())) return null;

  let canonical: string | undefined;

  try {
    [canonical] = Intl.getCanonicalLocales(candidate);
  } catch {
    return null;
  }

  if (canonical === undefined || NO_LANGUAGE.has(canonical)) return null;

  return Option.getOrNull(decodeLang(canonical));
};

/** A non-negative time in milliseconds. */
const Millis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** One word or syllable of a line with its own timing. `text` keeps its surrounding spaces. */
export const LyricWord = Schema.Struct({
  text: Schema.String,
  startMs: Millis,
  endMs: Schema.NullOr(Millis),
});

/** One timed word. */
export interface LyricWord extends Schema.Schema.Type<typeof LyricWord> {}

/**
 * One timed line. `endMs` is null when the source gives no end; the line then lasts until the
 * next one starts. `words` is set only when the source timed each word, never estimated.
 * `voice` names the singer when the source marks one (`v1`, `M`, a TTML agent).
 */
export const LyricLine = Schema.Struct({
  text: Schema.String,
  startMs: Millis,
  endMs: Schema.NullOr(Millis),
  words: Schema.NullOr(Schema.NonEmptyArray(LyricWord)),
  voice: Schema.NullOr(Schema.String),
});

/** One timed line. */
export interface LyricLine extends Schema.Schema.Type<typeof LyricLine> {}

/** The words of a song: timed lines, sorted by start, or untimed plain text. */
export const LyricBody = Schema.TaggedUnion({
  Synced: { lines: Schema.NonEmptyArray(LyricLine) },
  Plain: { text: Schema.NonEmptyString },
});

/** A song's words. */
export type LyricBody = typeof LyricBody.Type;

/** The lyric file formats read from beside a song. `lyricsfile` is the Lyricsfile YAML format. */
export const LyricsFormat = Schema.Literals([
  "lrc",
  "elrc",
  "ttml",
  "vtt",
  "srt",
  "txt",
  "lyricsfile",
]);

/** A lyric file format. */
export type LyricsFormat = typeof LyricsFormat.Type;

/** The tag frame or field lyrics were embedded in. `other` covers every remaining tag format. */
export const EmbeddedLyricsTag = Schema.Literals([
  "id3:USLT",
  "id3:SYLT",
  "vorbis:LYRICS",
  "vorbis:UNSYNCEDLYRICS",
  "vorbis:SYNCEDLYRICS",
  "mp4:lyr",
  "other",
]);

/** A tag lyrics were embedded in. */
export type EmbeddedLyricsTag = typeof EmbeddedLyricsTag.Type;

/** What a lyric set is to the song: its words, a translation, or a pronunciation guide. */
export const LyricKind = Schema.Literals(["main", "translation", "pronunciation"]);

/** What a lyric set is to the song. */
export type LyricKind = typeof LyricKind.Type;

/** Where a song's own lyric set came from: a file beside it (its name only) or a tag inside it. */
export const LocalLyricOrigin = Schema.TaggedUnion({
  Sidecar: { fileName: Schema.NonEmptyString, format: LyricsFormat },
  Embedded: { tag: EmbeddedLyricsTag },
});

/** Where a song's own lyric set came from. */
export type LocalLyricOrigin = typeof LocalLyricOrigin.Type;

/** One version of a song's own lyrics, in one language, from a file beside it or a tag in it. */
export const LocalLyricSet = Schema.Struct({
  kind: LyricKind,
  lang: Schema.NullOr(Lang),
  origin: LocalLyricOrigin,
  body: LyricBody,
});

/** A song's own lyric set. */
export interface LocalLyricSet extends Schema.Schema.Type<typeof LocalLyricSet> {}

const lyricsFields = {
  /** The lyric files beside the file, as `name:size:mtime` joined by `/`; empty when none. */
  lyricsFiles: Schema.String,
  /** The version of the server's lyrics reader that read them. */
  lyricsReader: Schema.Int,
  /** The file's own lyric sets, from its lyric files and tags; none when it has none. */
  lyrics: Schema.Array(LocalLyricSet),
};

/**
 * One audio file a scan read, with its tags and its own lyrics, as `music/scanner:upsert` takes
 * it. `path` is absolute and inside one of the library's folders.
 */
export const ScannedTrack = Schema.Struct({
  ...lyricsFields,
  path: Schema.String,
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  title: Schema.String,
  artist: Schema.String,
  /** The album's artist when the tags name one; the album files under it, else under `artist`. */
  albumArtist: Schema.optionalKey(Schema.String),
  album: Schema.String,
  trackNumber: Schema.optionalKey(Schema.Finite),
  discNumber: Schema.optionalKey(Schema.Finite),
  year: Schema.optionalKey(Schema.Finite),
  genre: Schema.optionalKey(Schema.String),
  durationMs: Schema.Finite,
  codec: Schema.String,
  lossless: Schema.Boolean,
  bitrate: Schema.optionalKey(Schema.Finite),
  sampleRate: Schema.optionalKey(Schema.Finite),
  bitDepth: Schema.optionalKey(Schema.Finite),
  /** The artwork the scan found for the file, embedded or beside it, as the server stores it. */
  artHash: Schema.optionalKey(Schema.String),
  /** The folder artwork file beside the file, as `path:size:mtime`, so replacing it rescans. */
  folderArt: Schema.optionalKey(Schema.String),
  /** Whether the file's tags mark it explicit, which a kid's explicit filter hides (D17). */
  explicit: Schema.Boolean,
});

/** One audio file a scan read. */
export interface ScannedTrack extends Schema.Schema.Type<typeof ScannedTrack> {}

/** The lyrics a scan read again for a file whose audio did not change. */
export const ScannedLyrics = Schema.Struct({ path: Schema.String, ...lyricsFields });

/** The lyrics a scan read again. */
export interface ScannedLyrics extends Schema.Schema.Type<typeof ScannedLyrics> {}

/**
 * The longest folder artwork or lyric files fingerprint the core keeps as it is. A longer one is
 * kept as its leading part, `#`, and the hex SHA-256 of the whole (`music/fit.ts`), and `known`
 * answers it so; a scan compares its own fingerprints through the same bound.
 */
export const MUSIC_FINGERPRINT_MAX = 1024;

/**
 * A file the library knows, as a scan compares it with the disk: old music's fingerprint.
 * `folderArt` is null when the file had no folder artwork. Fingerprints come back within
 * `MUSIC_FINGERPRINT_MAX`.
 */
export const KnownTrack = Schema.Struct({
  path: Schema.String,
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  missing: Schema.Boolean,
  folderArt: Schema.NullOr(Schema.String),
  lyricsFiles: Schema.String,
  lyricsReader: Schema.Finite,
  /** The size of the file's own lyrics as stored, null when it has none. */
  lyricsBytes: Schema.NullOr(Schema.Finite),
  durationMs: Schema.Finite,
  title: Schema.String,
  artist: Schema.String,
  album: Schema.String,
});

/** A file the library knows. */
export interface KnownTrack extends Schema.Schema.Type<typeof KnownTrack> {}

/** The track a ticket names, as the server streams it (`music/tracks:resolve`). */
export const ResolvedTrack = Schema.Struct({
  trackId: Schema.String,
  libraryId: Schema.String,
  /** Absolute, inside one of `roots`. */
  path: Schema.String,
  /** The library's folders now. */
  roots: Schema.Array(Schema.String),
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  /** The scanner's short codec name (`flac`, `mp3`, ...), which picks what a transcode copies. */
  codec: Schema.String,
});

/** A track the server streams. */
export interface ResolvedTrack extends Schema.Schema.Type<typeof ResolvedTrack> {}
