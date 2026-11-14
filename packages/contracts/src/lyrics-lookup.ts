/**
 * How a song is looked up on LRCLIB, shared by the core, which decides which songs to look up and
 * which answer is current, and the server, which matches LRCLIB's search results. Ported from old
 * music's `normalizeLyricsTag`, `canLookUp`, and `lookupKeyOf`; plain TypeScript, so the core's
 * Convex functions import it too.
 */
import { foldSearchText } from "./search-text";

/** The artist a scan names when a file's tags name none, which LRCLIB cannot match. */
const UNKNOWN_ARTIST = "Unknown Artist";

const SINGLE_QUOTES = /[‘’‚‛′ʼ]/gu;

const DOUBLE_QUOTES = /[“”„‟″]/gu;

const FEATURING =
  /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]|\s+(?:feat\.|ft\.|featuring)\s.*$/gu;

const REMASTER_LABEL = String.raw`(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4})){0,2}`;

const QUALIFIER_SEPARATOR = String.raw`\s*[-–—/,;]\s*`;

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
export const lookupKeyOf = (query: LyricsQuery): string =>
  [
    "v1",
    normalizeLyricsTag(query.artist),
    normalizeLyricsTag(query.title),
    normalizeLyricsTag(query.album),
    String(Math.round(query.durationMs / 1000)),
  ].join("|");
