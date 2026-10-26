/**
 * Lyrics embedded in a song's tags, read from `music-metadata`'s native tags: its common
 * `lyrics` loses which frame they came from, flattens LRC into lines without word timing, and
 * does not map Vorbis `SYNCEDLYRICS`. The common field is read only for other tag formats.
 */
import {
  type EmbeddedLyricsTag,
  type Lang,
  type LyricBody,
  type LyricLine,
  LyricOrigin,
  type LyricSet,
  parseLang,
} from "@music/commands/lyrics";
import { Array as Arr, Option, Result, Schema } from "effect";
import {
  type IAudioMetadata,
  type ILyricsTag,
  type ITag,
  LyricsContentType,
  TimestampFormat,
} from "music-metadata";

import {
  type LyricsParseError,
  mainSet,
  type ParsedLyricSet,
  plainBody,
  timedBody,
  withinSizeLimit,
} from "./lyric-body.ts";
import { parseLyricsText } from "./lrc.ts";

const UnsyncedLyrics = Schema.Struct({
  language: Schema.optionalKey(Schema.String),
  text: Schema.String,
});

const syncedFields = {
  language: Schema.optionalKey(Schema.String),
  contentType: Schema.Finite,
  timeStampFormat: Schema.Finite,
  syncText: Schema.Array(Schema.Struct({ text: Schema.String, timestamp: Schema.Finite })),
};

const SyncedLyrics = Schema.Struct(syncedFields);

/** `music-metadata`'s common lyrics: synchronized text, plain text, or both. */
const CommonLyrics = Schema.Struct({ ...syncedFields, text: Schema.optionalKey(Schema.String) });

const decodeUnsynced = Schema.decodeUnknownOption(UnsyncedLyrics);

const decodeSynced = Schema.decodeUnknownOption(SyncedLyrics);

const decodeCommon = Schema.decodeUnknownOption(CommonLyrics);

const decodeText = Schema.decodeUnknownOption(Schema.String);

const VORBIS_FIELDS: ReadonlyMap<string, EmbeddedLyricsTag> = new Map([
  ["LYRICS", "vorbis:LYRICS"],
  ["UNSYNCEDLYRICS", "vorbis:UNSYNCEDLYRICS"],
  ["SYNCEDLYRICS", "vorbis:SYNCEDLYRICS"],
]);

/** `TXXX` frames some taggers (and ffmpeg) use instead of `USLT`: `LYRICS`, `lyrics-eng`. */
const ID3_USER_LYRICS = /^TXXX:(?:UN)?(?:SYNCED)?LYRICS(?:-([a-z]{3}))?$/iu;

type SyncedLyrics = typeof SyncedLyrics.Type;

type SyltEntry = SyncedLyrics["syncText"][number];

/**
 * Whether `SYLT` content is words sung or spoken: ID3's lyrics and text transcription types,
 * not chords, events, trivia, or links.
 */
const isLyricContent = (contentType: number): boolean =>
  contentType === LyricsContentType.lyrics || contentType === LyricsContentType.text;

/**
 * `SYLT` text, which taggers write one entry per line or one per syllable, a new line then
 * starting with a line break. Syllables become the words of their line; their end is unknown.
 */
const syltLines = (entries: ReadonlyArray<SyltEntry>): ReadonlyArray<LyricLine> => {
  const perSyllable = entries.slice(1).some((entry) => /^[\r\n]/u.test(entry.text));
  const groups: Array<Array<SyltEntry>> = [];

  for (const entry of entries) {
    const last = groups.at(-1);

    if (last === undefined || !perSyllable || /^[\r\n]/u.test(entry.text)) groups.push([entry]);
    else last.push(entry);
  }

  return groups.flatMap((group): ReadonlyArray<LyricLine> => {
    const [first] = group;

    if (first === undefined) return [];

    const words = group.map((entry) => ({
      text: entry.text.replace(/^[\r\n]+/u, ""),
      startMs: entry.timestamp,
      endMs: null,
    }));

    return [
      {
        text: words
          .map((word) => word.text)
          .join("")
          .trim(),
        startMs: first.timestamp,
        endMs: null,
        words: group.length > 1 && Arr.isReadonlyArrayNonEmpty(words) ? words : null,
        voice: null,
      },
    ];
  });
};

const syltBody = (sylt: SyncedLyrics): Result.Result<LyricBody, LyricsParseError> => {
  const lines = syltLines(sylt.syncText);

  // MPEG frame numbers need the frame rate to become time, so they read as plain text.
  return sylt.timeStampFormat === TimestampFormat.milliseconds
    ? timedBody(lines)
    : plainBody(lines.map((line) => line.text).join("\n"));
};

type FoundSets = Result.Result<Arr.NonEmptyReadonlyArray<ParsedLyricSet>, LyricsParseError>;

const syltSets = (sylt: SyncedLyrics, lang: Lang | null): FoundSets => {
  const size = sylt.syncText.reduce((total, entry) => total + entry.text.length, 0);

  return Result.flatMap(withinSizeLimit(sylt, size, "characters"), (checked) =>
    Result.map(syltBody(checked), mainSet(lang)),
  );
};

const textSets = (text: string, lang: Lang | null): FoundSets =>
  Result.flatMap(withinSizeLimit(text, text.length, "characters"), (checked) =>
    parseLyricsText(checked, lang),
  );

interface Found {
  readonly tag: EmbeddedLyricsTag;
  readonly sets: FoundSets;
}

const textFound = (
  tag: EmbeddedLyricsTag,
  native: ITag,
  lang: Lang | null = null,
): ReadonlyArray<Found> =>
  Option.match(decodeText(native.value), {
    onNone: () => [],
    onSome: (text) => [{ tag, sets: textSets(text, lang) }],
  });

const id3Found = (native: ITag): ReadonlyArray<Found> => {
  const { id } = native;

  if (id === "USLT" || id === "ULT") {
    return Option.match(decodeUnsynced(native.value), {
      onNone: () => [],
      onSome: (uslt) => [
        { tag: "id3:USLT", sets: textSets(uslt.text, parseLang(uslt.language ?? "")) },
      ],
    });
  }

  if (id === "SYLT" || id === "SLT") {
    return Option.match(decodeSynced(native.value), {
      onNone: () => [],
      onSome: (sylt) =>
        isLyricContent(sylt.contentType)
          ? [{ tag: "id3:SYLT", sets: syltSets(sylt, parseLang(sylt.language ?? "")) }]
          : [],
    });
  }

  const user = ID3_USER_LYRICS.exec(id);

  return user === null ? [] : textFound("other", native, parseLang(user[1] ?? ""));
};

const nativeFound = (format: string, native: ITag): ReadonlyArray<Found> => {
  if (format.startsWith("ID3v2")) return id3Found(native);

  const vorbis = format === "vorbis" ? VORBIS_FIELDS.get(native.id.toUpperCase()) : undefined;

  if (vorbis !== undefined) return textFound(vorbis, native);

  return format === "iTunes" && native.id === "©lyr" ? textFound("mp4:lyr", native) : [];
};

const commonFound = (tag: ILyricsTag): ReadonlyArray<Found> =>
  Option.match(decodeCommon(tag), {
    onNone: () => [],
    onSome: (lyrics) => {
      if (!isLyricContent(lyrics.contentType)) return [];
      const lang = parseLang(lyrics.language ?? "");

      return [
        {
          tag: "other",
          sets:
            lyrics.syncText.length > 0 &&
            (lyrics.timeStampFormat === TimestampFormat.milliseconds || lyrics.text === undefined)
              ? syltSets(lyrics, lang)
              : textSets(lyrics.text ?? "", lang),
        },
      ];
    },
  });

/**
 * The lyric sets in a song's tags: ID3 `USLT` and `SYLT` (and lyrics in `TXXX` frames), Vorbis
 * `LYRICS`, `UNSYNCEDLYRICS`, and `SYNCEDLYRICS`, and MP4 `©lyr`; other tag formats through
 * `music-metadata`'s common lyrics. Plain lyrics fields that hold LRC read as timed lyrics.
 * `SYLT` timed in MPEG frames reads as plain text, and `SYLT` holding chords, events, or trivia
 * is not lyrics. Every set is `main`, except a translation paired under the lines of LRC text;
 * repeats of the same lyrics in several fields are kept once. A tag that holds no readable
 * lyrics, or is larger than a lyric file may be, is skipped.
 */
export const embeddedLyrics = (
  metadata: Pick<IAudioMetadata, "common" | "native">,
): ReadonlyArray<LyricSet> => {
  const native = Object.entries(metadata.native).flatMap(([format, tags]) =>
    tags.flatMap((tag) => nativeFound(format, tag)),
  );

  const found = native.length > 0 ? native : (metadata.common.lyrics ?? []).flatMap(commonFound);
  const seen = new Set<string>();

  return found.flatMap(({ tag, sets }): ReadonlyArray<LyricSet> => {
    if (Result.isFailure(sets)) return [];

    return sets.success.flatMap((set): ReadonlyArray<LyricSet> => {
      const key = JSON.stringify(set.body);

      if (seen.has(key)) return [];
      seen.add(key);

      return [{ ...set, origin: LyricOrigin.cases.Embedded.make({ tag }) }];
    });
  });
};
