/**
 * Song lyrics as every client reads them: the lyric sets a track's files and tags hold, what
 * LRCLIB returned for it, and the one answer `lyrics.get` gives after weighing the two. Pure, so
 * the server, the media service, and a phone holding downloads resolve lyrics the same way.
 */
import { Data, Option, Schema } from "effect";

import { TrackId } from "./ids";
import { Millis, UNKNOWN_ARTIST } from "./models";
import { foldSearchText } from "./search-text";

const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u;

/** A BCP 47 language tag in canonical case, such as `en`, `pt-BR`, or `ja-Latn`. */
export const Lang = Schema.String.check(Schema.isPattern(LANG)).pipe(Schema.brand("Lang"));

export type Lang = typeof Lang.Type;

const decodeLang = Schema.decodeOption(Lang);

/** Tags that name no language: ID3's `XXX` filler, undetermined, and no linguistic content. */
const NO_LANGUAGE = new Set(["xxx", "und", "zxx"]);

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
    // Intl throws a RangeError for a well-formed but invalid tag, such as a repeated variant.
    return null;
  }

  if (canonical === undefined || NO_LANGUAGE.has(canonical)) return null;

  return Option.getOrNull(decodeLang(canonical));
};

/** One word or syllable of a line with its own timing. `text` keeps its surrounding spaces. */
export const LyricWord = Schema.Struct({
  text: Schema.String,
  startMs: Millis,
  endMs: Schema.NullOr(Millis),
});

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

export interface LyricLine extends Schema.Schema.Type<typeof LyricLine> {}

/** The words of a song: timed lines, sorted by start, or untimed plain text. */
export const LyricBody = Schema.TaggedUnion({
  Synced: { lines: Schema.NonEmptyArray(LyricLine) },
  Plain: { text: Schema.NonEmptyString },
});

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

export type EmbeddedLyricsTag = typeof EmbeddedLyricsTag.Type;

/** The `id` of an LRCLIB lyrics record. */
export const LrclibRecordId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("LrclibRecordId"),
);

export type LrclibRecordId = typeof LrclibRecordId.Type;

/**
 * Where a lyric set came from: a file beside the song (its name only, never its folder), a tag
 * inside the song's file, or an LRCLIB record.
 */
export const LyricOrigin = Schema.TaggedUnion({
  Sidecar: { fileName: Schema.NonEmptyString, format: LyricsFormat },
  Embedded: { tag: EmbeddedLyricsTag },
  Lrclib: { recordId: LrclibRecordId },
});

export type LyricOrigin = typeof LyricOrigin.Type;

/** What a lyric set is to the song: its words, a translation, or a pronunciation guide. */
export const LyricKind = Schema.Literals(["main", "translation", "pronunciation"]);

export type LyricKind = typeof LyricKind.Type;

const lyricSetFields = {
  kind: LyricKind,
  lang: Schema.NullOr(Lang),
  origin: LyricOrigin,
};

/** One version of a song's lyrics, in one language, from one source. */
export const LyricSet = Schema.Struct({ ...lyricSetFields, body: LyricBody });

export interface LyricSet extends Schema.Schema.Type<typeof LyricSet> {}

/** A lyric set a song's own files hold: from a file beside it or a tag inside it. */
export const LocalLyricSet = Schema.Struct({
  ...lyricSetFields,
  origin: Schema.Union([LyricOrigin.cases.Sidecar, LyricOrigin.cases.Embedded]),
  body: LyricBody,
});

export interface LocalLyricSet extends Schema.Schema.Type<typeof LocalLyricSet> {}

/** A lyric set from an LRCLIB record. */
export const LrclibLyricSet = Schema.Struct({
  ...lyricSetFields,
  origin: LyricOrigin.cases.Lrclib,
  body: LyricBody,
});

export interface LrclibLyricSet extends Schema.Schema.Type<typeof LrclibLyricSet> {}

const SyncedLyricSet = Schema.Struct({ ...lyricSetFields, body: LyricBody.cases.Synced });

const PlainLyricSet = Schema.Struct({ ...lyricSetFields, body: LyricBody.cases.Plain });

/** Where the lyrics a client shows came from, for its source caption. */
export const LyricsSource = Schema.Literals(["file", "lrclib"]);

export type LyricsSource = typeof LyricsSource.Type;

/**
 * The lyrics a client shows for a track (`lyrics.get`):
 *
 * - `None`: nothing to show, and nothing is being looked up.
 * - `Pending`: LRCLIB is being asked. `fallback` is the song's own plain text, shown meanwhile.
 * - `Instrumental`: LRCLIB says the song has no vocals, and the song has no lyrics of its own.
 * - `Synced` and `Plain`: the lyrics to show, with every other set from the same source
 *   (translations, pronunciations, and main lyrics that lost to `main`) in `extras`.
 */
export const TrackLyrics = Schema.TaggedUnion({
  None: {},
  Pending: { fallback: Schema.NullOr(PlainLyricSet) },
  Instrumental: {},
  Synced: { source: LyricsSource, main: SyncedLyricSet, extras: Schema.Array(LyricSet) },
  Plain: { source: LyricsSource, main: PlainLyricSet, extras: Schema.Array(LyricSet) },
});

export type TrackLyrics = typeof TrackLyrics.Type;

/**
 * The lyrics a device keeps with a downloaded song (`downloads.lyrics`), as it shows them without
 * the server: `TrackLyrics` less `Pending`, since a lookup never finishes without the server.
 */
export const OfflineLyrics = Schema.Union([
  TrackLyrics.cases.None,
  TrackLyrics.cases.Instrumental,
  TrackLyrics.cases.Synced,
  TrackLyrics.cases.Plain,
]).pipe(Schema.toTaggedUnion("_tag"));

export type OfflineLyrics = typeof OfflineLyrics.Type;

/**
 * `lyrics` as a device without the server shows them: a pending lookup shows the song's own
 * plain words it carries as its fallback, or none.
 */
export const offlineLyricsOf = (lyrics: TrackLyrics): OfflineLyrics => {
  if (!TrackLyrics.guards.Pending(lyrics)) return lyrics;

  if (lyrics.fallback === null) return OfflineLyrics.cases.None.make({});

  return OfflineLyrics.cases.Plain.make({ source: "file", main: lyrics.fallback, extras: [] });
};

/**
 * The version of the lyrics a device keeps with a downloaded song (`downloads.lyrics`): a digest
 * of the content revisions of the song's own lyrics (`tracks.lyricsHash`) and of LRCLIB's stored
 * answer for it, and of the rules that resolve them. It moves when either content changes or a
 * lookup is answered, and never with the song's audio, so new lyrics never fetch the song again.
 */
export const LyricsRevision = Schema.NonEmptyString.pipe(Schema.brand("LyricsRevision"));

export type LyricsRevision = typeof LyricsRevision.Type;

/** Songs one `downloads.lyrics` read asks about at most. */
export const HELD_LYRICS_LIMIT = 200;

/** A downloaded song and the revision of the lyrics the device keeps for it, null for none. */
export const HeldLyrics = Schema.Struct({ trackId: TrackId, rev: Schema.NullOr(LyricsRevision) });

export interface HeldLyrics extends Schema.Schema.Type<typeof HeldLyrics> {}

/**
 * How a downloaded song's lyrics differ from what the device keeps (`downloads.lyrics`):
 *
 * - `Changed`: keep `lyrics` at `rev`.
 * - `Removed`: keep none. The song has no lyrics now, or is gone or no longer yours to read.
 */
export const LyricsChange = Schema.TaggedUnion({
  Changed: { trackId: TrackId, rev: LyricsRevision, lyrics: OfflineLyrics },
  Removed: { trackId: TrackId },
});

export type LyricsChange = typeof LyricsChange.Type;

/**
 * What LRCLIB is known to hold for a track's lookup: `None` when it was never asked or had
 * nothing, `Pending` while a request is queued or running.
 */
export type LyricsLookup = Data.TaggedEnum<{
  None: {};
  Pending: {};
  Found: { readonly sets: ReadonlyArray<LyricSet> };
  Instrumental: {};
}>;

/** Constructors and matchers for `LyricsLookup`. */
export const LyricsLookup = Data.taggedEnum<LyricsLookup>();

type SyncedSet = typeof SyncedLyricSet.Type;

type PlainSet = typeof PlainLyricSet.Type;

const originRank = LyricOrigin.match({ Sidecar: () => 0, Embedded: () => 1, Lrclib: () => 2 });

const wordRank = (set: SyncedSet): number =>
  set.body.lines.some((line) => line.words !== null) ? 0 : 1;

const isSynced = (set: LyricSet): set is SyncedSet => LyricBody.guards.Synced(set.body);

const isPlain = (set: LyricSet): set is PlainSet => LyricBody.guards.Plain(set.body);

const bestSynced = (sets: ReadonlyArray<LyricSet>): SyncedSet | undefined =>
  sets
    .filter((set) => set.kind === "main")
    .filter(isSynced)
    .toSorted(
      (a, b) => originRank(a.origin) - originRank(b.origin) || wordRank(a) - wordRank(b),
    )[0];

const bestPlain = (sets: ReadonlyArray<LyricSet>): PlainSet | undefined =>
  sets
    .filter((set) => set.kind === "main")
    .filter(isPlain)
    .toSorted((a, b) => originRank(a.origin) - originRank(b.origin))[0];

/** Every set from the winner's source except the winner, losing main sets included. */
const extrasOf = (sets: ReadonlyArray<LyricSet>, main: LyricSet): ReadonlyArray<LyricSet> =>
  sets.filter((set) => set !== main);

/** Whether new LRCLIB lookups may run (the server's remote lyrics setting). */
export type RemoteLookups = "on" | "off";

/**
 * Picks the lyrics a client shows from the track's own lyric sets and its LRCLIB lookup. The
 * order is the song's synced lyrics, LRCLIB's synced lyrics, the song's plain lyrics, then
 * LRCLIB's plain lyrics; the song's own lyrics also beat an LRCLIB instrumental answer. Among the
 * song's sets of one kind, a file beside it beats a tag inside it, and word timing beats line
 * timing; between sets still equal, the first in `local` wins. Every other set from the winner's
 * source, a losing main set included, is kept in `extras`. With remote lookups off, a pending lookup will not run, so it counts as no answer;
 * answers LRCLIB already gave are still used.
 */
export const resolveLyrics = (
  local: ReadonlyArray<LyricSet>,
  lookup: LyricsLookup,
  options: { readonly remoteLookups: RemoteLookups },
): TrackLyrics => {
  const localSynced = bestSynced(local);

  if (localSynced !== undefined) {
    return TrackLyrics.cases.Synced.make({
      source: "file",
      main: localSynced,
      extras: extrasOf(local, localSynced),
    });
  }

  const remote = LyricsLookup.$match(lookup, {
    None: () => [],
    Pending: () => [],
    Found: ({ sets }) => sets,
    Instrumental: () => [],
  });

  const remoteSynced = bestSynced(remote);

  if (remoteSynced !== undefined) {
    return TrackLyrics.cases.Synced.make({
      source: "lrclib",
      main: remoteSynced,
      extras: extrasOf(remote, remoteSynced),
    });
  }

  const pending = LyricsLookup.$is("Pending")(lookup) && options.remoteLookups === "on";
  const localPlain = bestPlain(local);

  if (localPlain !== undefined) {
    if (pending) return TrackLyrics.cases.Pending.make({ fallback: localPlain });

    return TrackLyrics.cases.Plain.make({
      source: "file",
      main: localPlain,
      extras: extrasOf(local, localPlain),
    });
  }

  const remotePlain = bestPlain(remote);

  if (remotePlain !== undefined) {
    return TrackLyrics.cases.Plain.make({
      source: "lrclib",
      main: remotePlain,
      extras: extrasOf(remote, remotePlain),
    });
  }

  if (LyricsLookup.$is("Instrumental")(lookup)) return TrackLyrics.cases.Instrumental.make({});

  if (pending) return TrackLyrics.cases.Pending.make({ fallback: null });

  return TrackLyrics.cases.None.make({});
};

/** Identifies one LRCLIB lookup; tracks whose tags normalize alike share it. */
export const LyricsLookupKey = Schema.NonEmptyString.pipe(Schema.brand("LyricsLookupKey"));

export type LyricsLookupKey = typeof LyricsLookupKey.Type;

const SINGLE_QUOTES = /[‘’‚‛′ʼ]/gu;

const DOUBLE_QUOTES = /[“”„‟″]/gu;

/**
 * `(feat. X)`, `[ft X]`, or a trailing `feat. X` / `ft. X` / `featuring X`. Trailing, the dot is
 * required: without it `feat` and `ft` are as likely words, as in "A Feat of Clay".
 */
const FEATURING =
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]|\s+(?:feat\.|ft\.|featuring)\s.*$/gu;

/** A remaster label: `Remastered`, `2011 Remaster`, `Remastered 2011 Version`, `Digital Remaster`. */
const REMASTER_LABEL = String.raw`(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4})){0,2}`;

const QUALIFIER_SEPARATOR = String.raw`\s*[-–—/,;]\s*`;

/**
 * Remaster labels with the separator that set them apart, and the brackets they leave empty.
 * Other text beside one stays, so `Song (Live - 2011 Remaster)` keeps `(live)`.
 */
const REMASTER: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(String.raw`\s*[([]\s*${REMASTER_LABEL}\s*[)\]]`, "gu"), ""],
  [new RegExp(String.raw`([([])\s*${REMASTER_LABEL}${QUALIFIER_SEPARATOR}`, "gu"), "$1"],
  [
    new RegExp(
      String.raw`${QUALIFIER_SEPARATOR}${REMASTER_LABEL}(?=${QUALIFIER_SEPARATOR}|\s*[)\]]|\s*$)`,
      "gu",
    ),
    "",
  ],
];

const withoutRemaster = (text: string): string =>
  REMASTER.reduce(
    (current, [pattern, replacement]) => current.replaceAll(pattern, replacement),
    text,
  );

/**
 * A tag as lookup keys compare it: NFKC, case- and accent-folded, quotes straightened, featured
 * artists and remaster labels removed, whitespace collapsed.
 */
export const normalizeLyricsTag = (text: string): string =>
  withoutRemaster(
    foldSearchText(
      text.normalize("NFKC").replaceAll(SINGLE_QUOTES, "'").replaceAll(DOUBLE_QUOTES, '"'),
    ).replaceAll(FEATURING, ""),
  )
    .replaceAll("|", " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** The tags an LRCLIB lookup matches on. */
export interface LyricsQuery {
  readonly artist: string;
  readonly title: string;
  readonly album: string;
  readonly durationMs: number;
}

const UNKNOWN = normalizeLyricsTag(UNKNOWN_ARTIST);

/**
 * Whether LRCLIB can match a song with these tags: its title and artist are not blank once
 * normalized, its artist is not the one a scan names when the tags have none, and it lasts at
 * least half a second, so its length rounds to a whole second.
 */
export const canLookUp = (query: LyricsQuery): boolean => {
  const artist = normalizeLyricsTag(query.artist);

  return (
    normalizeLyricsTag(query.title) !== "" &&
    artist !== "" &&
    artist !== UNKNOWN &&
    Math.round(query.durationMs / 1000) > 0
  );
};

/**
 * The lookup key for a track's tags: artist, title, and album case- and accent-folded, with
 * featured artists and remaster labels removed, and the duration in whole seconds. Live,
 * acoustic, and edit labels stay, since those recordings have their own lyrics timing. Accents
 * fold only on Latin, Greek, and Cyrillic letters, so kana and Hangul keep their marks.
 */
export const lookupKeyOf = (query: LyricsQuery): LyricsLookupKey =>
  LyricsLookupKey.make(
    [
      "v1",
      normalizeLyricsTag(query.artist),
      normalizeLyricsTag(query.title),
      normalizeLyricsTag(query.album),
      String(Math.round(query.durationMs / 1000)),
    ].join("|"),
  );
