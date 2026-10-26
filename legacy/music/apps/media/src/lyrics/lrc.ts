/**
 * LRC lyrics, including enhanced LRC: `[mm:ss.xx]` line stamps, `<mm:ss.xx>` word stamps (A2),
 * `[offset:±ms]`, and singer prefixes (`v1:`, and Walaoke's `M:`, `F:`, `D:`).
 */
import { type Lang, LyricBody, type LyricLine, type LyricWord } from "@music/commands/lyrics";
import { Array as Arr, Result } from "effect";

import {
  consistentLine,
  LyricsParseError,
  MAX_LYRIC_LINES,
  mainSet,
  type ParsedLyricSet,
  plainBody,
  textLines,
  timedBody,
} from "./lyric-body.ts";

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, and `[mm:ss:xx]`; minutes may pass 59. */
const LINE_STAMP = /^\[(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?\]/u;

const WORD_STAMP = /<(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?>/gu;

const ID_TAG = /^\[([a-z#]+):(.*)\]$/iu;

const OFFSET = /^[+-]?\d+$/u;

const VOICE = /^(v\d+|[MFD]):\s*/u;

/** A line that starts with a stamp: what decides whether text is LRC. */
const STAMPED_LINE = /^\s*\[\d+:[0-5]?\d(?:[.:]\d{1,3})?\]/mu;

const stampMs = (minutes: string, seconds: string, fraction: string | undefined): number => {
  const fractionMs = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0"));

  return Number(minutes) * 60_000 + Number(seconds) * 1000 + fractionMs;
};

/** Whether text holds LRC stamps, as lyrics pasted into a plain lyrics tag often do. */
const looksLikeLrc = (text: string): boolean => STAMPED_LINE.test(text);

/** Most word stamps one line may carry; a line with more is not lyrics, so the set is not read. */
const MAX_LINE_WORDS = 500;

/** An A2 line's text split at its `<stamp>`s: text before the first, then each stamp's text. */
interface LineWords {
  readonly lead: string;
  readonly timed: Arr.NonEmptyReadonlyArray<{ readonly text: string; readonly atMs: number }>;
}

/**
 * Splits an A2 line at its word stamps, once per source line: a line stamped many times would
 * otherwise be split again for every repeat.
 *
 * @returns The line's words, null without word stamps, or `too-long` past `MAX_LINE_WORDS`.
 */
const lineWordsOf = (text: string): Result.Result<LineWords | null, LyricsParseError> => {
  const stamps: Array<RegExpExecArray> = [];

  for (const stamp of text.matchAll(WORD_STAMP)) {
    if (stamps.length === MAX_LINE_WORDS) {
      return Result.fail(
        new LyricsParseError({
          reason: "too-long",
          detail: `more than ${MAX_LINE_WORDS} word stamps on one line`,
        }),
      );
    }

    stamps.push(stamp);
  }

  const timed = stamps.map((stamp, index) => ({
    text: text.slice(stamp.index + stamp[0].length, stamps[index + 1]?.index ?? text.length),
    atMs: stampMs(stamp[1] ?? "0", stamp[2] ?? "0", stamp[3]),
  }));

  if (!Arr.isReadonlyArrayNonEmpty(timed)) return Result.succeed(null);

  return Result.succeed({ lead: text.slice(0, stamps[0]?.index), timed });
};

/**
 * The words of an A2 line. Each stamp starts the text after it and ends the word before it; text
 * before the first stamp starts with the line. A trailing stamp only ends the last word.
 */
const wordsOf = (
  { lead, timed }: LineWords,
  lineStartMs: number,
  shift: (ms: number) => number,
): Arr.NonEmptyReadonlyArray<LyricWord> | null => {
  const segments = [
    { text: lead, startMs: lineStartMs },
    ...timed.map(({ text, atMs }) => ({ text, startMs: shift(atMs) })),
  ];

  const words: Array<LyricWord> = [];

  for (const [index, segment] of segments.entries()) {
    const last = words.at(-1);

    if (segment.text.trim() === "") {
      // Space timed on its own belongs to the word before it; before the first word it is dropped.
      if (last !== undefined) {
        words[words.length - 1] = {
          text: last.text + segment.text,
          startMs: last.startMs,
          endMs: last.endMs,
        };
      }
    } else {
      words.push({
        text: segment.text,
        startMs: segment.startMs,
        endMs: segments[index + 1]?.startMs ?? null,
      });
    }
  }

  return Arr.isReadonlyArrayNonEmpty(words) ? words : null;
};

/** The lines with a repeat of the same text at the same time dropped. */
const distinctLines = (lines: ReadonlyArray<LyricLine>): ReadonlyArray<LyricLine> => {
  const seen = new Set<string>();

  return lines.filter((line) => {
    if (line.text === "") return true;
    const key = `${line.startMs}\u0000${line.text}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
};

/**
 * A file that times every line twice, the second a translation of the first, as files from some
 * players (NetEase) do: the lines split into the song's words and their translation, each kept
 * with its own timing. Null when any stamp holds one line or more than two.
 */
const pairedSets = (
  lines: ReadonlyArray<LyricLine>,
): {
  readonly main: ReadonlyArray<LyricLine>;
  readonly translation: ReadonlyArray<LyricLine>;
} | null => {
  const counts = new Map<number, number>();

  for (const line of lines) {
    if (line.text !== "") counts.set(line.startMs, (counts.get(line.startMs) ?? 0) + 1);
  }

  if (counts.size < 2 || [...counts.values()].some((count) => count !== 2)) return null;
  const main: Array<LyricLine> = [];
  const translation: Array<LyricLine> = [];
  const firsts = new Set<number>();

  for (const line of lines) {
    if (line.text === "") {
      main.push(line);
      translation.push(line);
    } else if (firsts.has(line.startMs)) {
      translation.push(line);
    } else {
      firsts.add(line.startMs);
      main.push(line);
    }
  }

  return { main, translation };
};

/**
 * Lines that share a start become one line, their texts one under the other: LRC has no end
 * stamps, so a second line at the same time could never show. Word timing is dropped from a
 * merged line, since it covered only one of its texts.
 */
const mergeSameStart = (lines: ReadonlyArray<LyricLine>): ReadonlyArray<LyricLine> => {
  const merged: Array<LyricLine> = [];

  for (const line of lines) {
    const last = merged.at(-1);

    if (
      last === undefined ||
      last.text === "" ||
      line.text === "" ||
      last.startMs !== line.startMs
    ) {
      merged.push(line);
      continue;
    }

    merged[merged.length - 1] = {
      text: `${last.text}\n${line.text}`,
      startMs: last.startMs,
      endMs: last.endMs ?? line.endMs,
      words: null,
      voice: last.voice === line.voice ? last.voice : null,
    };
  }

  return merged;
};

/** An empty stamped line ends the line before it, when that line has no end of its own. */
const withEndMarkers = (lines: ReadonlyArray<LyricLine>): ReadonlyArray<LyricLine> =>
  lines.flatMap((line, index): ReadonlyArray<LyricLine> => {
    const next = lines[index + 1];

    if (line.text === "") return [];

    if (next?.text !== "" || line.endMs !== null) return [line];

    return [
      {
        text: line.text,
        startMs: line.startMs,
        endMs: next.startMs,
        words: line.words,
        voice: line.voice,
      },
    ];
  });

/**
 * Reads LRC text. Lines with several stamps repeat at each, with any word timing on the repeat
 * its word stamps fall in; lines sort by time; `[offset:+n]` moves every stamp n ms earlier. An
 * empty stamped line ends the line before it. Text without any stamp reads as plain lyrics, and
 * stamps that are all the same carry no timing, so their lines read as plain lyrics too. ID tags
 * (`[ar:]`, `[ti:]`, `[by:]`) are not lyrics. Different lines at the same stamp stack into one,
 * except when every stamp holds exactly two: the second of each pair is then a translation,
 * returned as a second set with no language.
 *
 * @returns The main set in `lang`, then any translation, or `LyricsParseError`.
 */
export const parseLrc = (
  text: string,
  lang: Lang | null,
): Result.Result<Arr.NonEmptyReadonlyArray<ParsedLyricSet>, LyricsParseError> => {
  let offsetMs = 0;
  let voice: string | null = null;
  let lyricLines = 0;
  const untimed: Array<string> = [];

  const stamped: Array<{
    readonly at: number;
    readonly text: string;
    readonly words: LineWords | null;
    readonly voice: string | null;
  }> = [];

  for (const raw of textLines(text)) {
    let rest = raw.trim();
    const stamps: Array<number> = [];

    for (let match = LINE_STAMP.exec(rest); match !== null; match = LINE_STAMP.exec(rest)) {
      stamps.push(stampMs(match[1] ?? "0", match[2] ?? "0", match[3]));
      rest = rest.slice(match[0].length).trimStart();
    }

    if (stamps.length === 0) {
      const tag = ID_TAG.exec(rest);

      if (tag === null) {
        untimed.push(rest);
      } else if (tag[1]?.toLowerCase() === "offset" && OFFSET.test(tag[2]?.trim() ?? "")) {
        offsetMs = Number(tag[2]);
      }

      continue;
    }

    const prefix = VOICE.exec(rest);

    if (prefix !== null) {
      voice = prefix[1] ?? null;
      rest = rest.slice(prefix[0].length);
    }

    const lineWords = lineWordsOf(rest);

    if (Result.isFailure(lineWords)) return Result.fail(lineWords.failure);
    const lineText = rest.replaceAll(WORD_STAMP, "");

    // Checked before any words are built, so a line stamped thousands of times fails at once.
    if (lineText.trim() !== "") lyricLines += stamps.length;

    if (lyricLines > MAX_LYRIC_LINES) {
      return Result.fail(
        new LyricsParseError({ reason: "too-long", detail: `over ${MAX_LYRIC_LINES} lines` }),
      );
    }

    // Word stamps are absolute, so they fall in one repeat: the last to start at or before them.
    const firstWordMs = lineWords.success?.timed[0].atMs ?? -1;

    const carrier = stamps.indexOf(
      stamps.reduce((best, at) => (at <= firstWordMs && at > best ? at : best), -1),
    );

    for (const [index, at] of stamps.entries()) {
      stamped.push({
        at,
        text: lineText,
        words: index === carrier ? lineWords.success : null,
        voice,
      });
    }
  }

  if (stamped.length === 0) return Result.map(plainBody(untimed.join("\n")), mainSet(lang));

  const shift = (ms: number): number => Math.max(0, ms - offsetMs);

  const lines = distinctLines(
    stamped
      .map(({ at, text: lineText, words: lineWords, voice: lineVoice }): LyricLine => {
        const startMs = shift(at);
        const words = lineWords === null ? null : wordsOf(lineWords, startMs, shift);

        return consistentLine({
          startMs,
          text: lineText,
          words,
          endMs: words === null ? null : Arr.lastNonEmpty(words).endMs,
          voice: lineVoice,
        });
      })
      .toSorted((a, b) => a.startMs - b.startMs),
  );

  // Constant stamps are judged before lines merge: merged, they would leave one line, which has timing.
  return Result.flatMap(timedBody(lines), (whole) => {
    if (LyricBody.guards.Plain(whole)) return Result.succeed(mainSet(lang)(whole));
    const pairs = pairedSets(lines);

    if (pairs === null) {
      return Result.map(timedBody(withEndMarkers(mergeSameStart(lines))), mainSet(lang));
    }

    return Result.all([
      timedBody(withEndMarkers(pairs.main)),
      timedBody(withEndMarkers(pairs.translation)),
    ]).pipe(
      Result.map(([main, translation]): Arr.NonEmptyReadonlyArray<ParsedLyricSet> => [
        { kind: "main", lang, body: main },
        { kind: "translation", lang: null, body: translation },
      ]),
    );
  });
};

/**
 * Text that may be plain lyrics or LRC, as `.txt` files and plain lyrics tags hold.
 *
 * @returns The sets `parseLrc` reads when the text holds stamps, else one plain main set.
 */
export const parseLyricsText = (
  text: string,
  lang: Lang | null,
): Result.Result<Arr.NonEmptyReadonlyArray<ParsedLyricSet>, LyricsParseError> =>
  looksLikeLrc(text) ? parseLrc(text, lang) : Result.map(plainBody(text), mainSet(lang));
