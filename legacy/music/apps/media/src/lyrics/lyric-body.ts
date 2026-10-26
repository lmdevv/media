/** What every lyric parser ends with: size limits, line order, and stamps that carry no timing. */
import {
  type Lang,
  LyricBody,
  type LyricKind,
  LyricLine,
  type LyricWord,
} from "@music/commands/lyrics";
import { Array as Arr, Data, Result, Schema } from "effect";

/** Largest lyric source read, in bytes of a file or characters of a tag or LRCLIB record. */
const MAX_LYRICS_SIZE = 256 * 1024;

/** Most lines one lyric set keeps; a longer source is not read. */
export const MAX_LYRIC_LINES = 2000;

/** Lyrics could not be read from a file, a tag, or an LRCLIB record. */
export class LyricsParseError extends Data.TaggedError("LyricsParseError")<{
  /**
   * `too-large`: past `MAX_LYRICS_SIZE`. `too-long`: more than 2,000 lines in one set, or more
   * than 500 word stamps on one LRC line.
   * `not-text`: binary data. `empty`: no lyric text at all. `malformed`: the format's structure
   * is broken, or a time is too large to represent.
   */
  readonly reason: "too-large" | "too-long" | "not-text" | "empty" | "malformed";
  readonly detail: string;
}> {
  override get message(): string {
    return `Lyrics could not be read (${this.reason}): ${this.detail}`;
  }
}

/**
 * `source` when its size is within `MAX_LYRICS_SIZE`. Lyrics enter as a file's bytes, a tag's
 * text, or an LRCLIB record, and each entry checks once, before parsing.
 */
export const withinSizeLimit = <A>(
  source: A,
  size: number,
  unit: "bytes" | "characters",
): Result.Result<A, LyricsParseError> =>
  size > MAX_LYRICS_SIZE
    ? Result.fail(new LyricsParseError({ reason: "too-large", detail: `${size} ${unit}` }))
    : Result.succeed(source);

/** A lyric set as a source holds it, before the reader adds where it came from. */
export interface ParsedLyricSet {
  readonly kind: LyricKind;
  readonly lang: Lang | null;
  readonly body: LyricBody;
}

/** A source's only set: its main lyrics, in `lang`. */
export const mainSet =
  (lang: Lang | null) =>
  (body: LyricBody): Arr.NonEmptyReadonlyArray<ParsedLyricSet> => [{ kind: "main", lang, body }];

/** Splits text on any line ending: CRLF, CR, or LF. */
export const textLines = (text: string): ReadonlyArray<string> => text.split(/\r\n|\r|\n/u);

/**
 * Untimed lyrics: line endings unified, trailing spaces and runs of blank lines trimmed. Text
 * that only says "instrumental" stays text; only LRCLIB's own flag marks a song instrumental.
 */
export const plainBody = (text: string): Result.Result<LyricBody, LyricsParseError> => {
  const lines = textLines(text).map((line) => line.trimEnd());

  if (lines.length > MAX_LYRIC_LINES) {
    return Result.fail(
      new LyricsParseError({ reason: "too-long", detail: `${lines.length} lines` }),
    );
  }

  const joined = lines
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

  if (joined === "") {
    return Result.fail(new LyricsParseError({ reason: "empty", detail: "no lyric text" }));
  }

  return Result.succeed(LyricBody.cases.Plain.make({ text: joined }));
};

/**
 * A word list kept only when its stamps fit the line: starts in order and inside the line's
 * interval. The first word's leading and the last word's trailing spaces are trimmed, as the
 * line's text is, so the words spell the line.
 */
const wordsWithin = (
  words: Arr.NonEmptyReadonlyArray<LyricWord>,
  line: { readonly startMs: number; readonly endMs: number | null },
): Arr.NonEmptyReadonlyArray<LyricWord> | null => {
  const fits = words.every(
    (word, index) =>
      word.startMs >= line.startMs &&
      (line.endMs === null || word.startMs <= line.endMs) &&
      word.startMs >= (words[index - 1]?.startMs ?? line.startMs),
  );

  if (!fits) return null;
  const last = words.length - 1;

  const trimmed = words.flatMap((word, index): ReadonlyArray<LyricWord> => {
    const leading = index === 0 ? word.text.trimStart() : word.text;
    const text = index === last ? leading.trimEnd() : leading;

    if (text === "") return [];
    const endMs = word.endMs !== null && word.endMs >= word.startMs ? word.endMs : null;

    return [{ text, startMs: word.startMs, endMs }];
  });

  return Arr.isReadonlyArrayNonEmpty(trimmed) ? trimmed : null;
};

/**
 * A line without timing it cannot have: an end before its start, and words that run backwards
 * or fall outside the line. What is removed is never replaced by a guess.
 */
export const consistentLine = (line: LyricLine): LyricLine => {
  const endMs = line.endMs !== null && line.endMs >= line.startMs ? line.endMs : null;

  return {
    text: line.text.trim(),
    startMs: line.startMs,
    endMs,
    words: line.words === null ? null : wordsWithin(line.words, { startMs: line.startMs, endMs }),
    voice: line.voice,
  };
};

const isLyricLine = Schema.is(LyricLine);

const carriesTiming = (line: LyricLine): boolean =>
  line.words !== null || (line.endMs !== null && line.endMs > line.startMs);

/**
 * Timed lyrics from lines in any order, sorted by start (keeping source order for equal starts),
 * each made consistent by `consistentLine`. When two or more lines all start at the same time and
 * none has word timing or an end of its own, the stamps carry no timing, as when a tagger writes
 * `[00:00.00]` before each line, so the lines become plain text. Every timed format ends here,
 * so a stamp whose digits overflow fails here as `malformed` whichever format spelled it.
 */
export const timedBody = (
  lines: ReadonlyArray<LyricLine>,
): Result.Result<LyricBody, LyricsParseError> => {
  const kept = lines.flatMap((line) => {
    const consistent = consistentLine(line);

    return consistent.text === "" ? [] : [consistent];
  });

  if (!kept.every(isLyricLine)) {
    return Result.fail(
      new LyricsParseError({ reason: "malformed", detail: "a timestamp too large to represent" }),
    );
  }

  if (kept.length > MAX_LYRIC_LINES) {
    return Result.fail(
      new LyricsParseError({ reason: "too-long", detail: `${kept.length} lines` }),
    );
  }

  const sorted = kept.toSorted((a, b) => a.startMs - b.startMs);

  if (!Arr.isReadonlyArrayNonEmpty(sorted)) {
    return Result.fail(new LyricsParseError({ reason: "empty", detail: "no timed lines" }));
  }

  const first = sorted[0].startMs;

  if (
    sorted.length > 1 &&
    sorted.every((line) => line.startMs === first) &&
    !sorted.some(carriesTiming)
  ) {
    return plainBody(sorted.map((line) => line.text).join("\n"));
  }

  return Result.succeed(LyricBody.cases.Synced.make({ lines: sorted }));
};
