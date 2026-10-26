/**
 * Subtitle files used as lyrics: WebVTT and SubRip. Each cue is one line, timed from its start to
 * its end; a cue's text lines stay together, one under the other.
 */
import type { LyricBody, LyricLine, LyricWord } from "@music/commands/lyrics";
import { Array as Arr, Result } from "effect";

import { LyricsParseError, textLines, timedBody } from "./lyric-body.ts";

/** `hh:mm:ss.ttt` or `mm:ss.ttt`; SubRip writes a comma before the milliseconds. */
const CUE_TIME = /^(?:(\d+):)?([0-5]\d):([0-5]\d)[.,](\d{1,3})$/u;

const CUE_TIMING = /^\s*(\S+)\s+-->\s+(\S+)/u;

/** A WebVTT timestamp inside a cue, `<00:01.500>`, which starts the text after it. */
const INLINE_TIME = /<((?:\d+:)?[0-5]\d:[0-5]\d\.\d{3})>/gu;

const VOICE_TAG = /<v(?:\.[^\s>]*)?\s+([^>]+)>/u;

const TAG = /<[^>]*>/gu;

/** SubRip files often carry SSA override blocks such as `{\an8}`. */
const SSA_OVERRIDE = /\{\\[^}]*\}/gu;

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["lrm", "‎"],
  ["rlm", "‏"],
]);

const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu;

const MAX_CODE_POINT = 0x10_ffff;

const codePointOf = (decimal: string | undefined, hex: string | undefined): number | null => {
  if (decimal !== undefined) return Number(decimal);

  return hex === undefined ? null : Number.parseInt(hex, 16);
};

/** Numeric references past the last Unicode code point name no character, so they stay as written. */
const decodeEntities = (text: string): string =>
  text.replaceAll(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    const code = codePointOf(decimal, hex);

    if (code !== null) return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole;

    return ENTITIES.get(name?.toLowerCase() ?? "") ?? whole;
  });

const cueTimeMs = (value: string): number | null => {
  const match = CUE_TIME.exec(value);

  if (match === null) return null;
  const [, hours = "0", minutes = "0", seconds = "0", fraction = "0"] = match;

  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(fraction.padEnd(3, "0"))
  );
};

const cleanText = (text: string): string =>
  decodeEntities(text.replaceAll(TAG, "").replaceAll(SSA_OVERRIDE, ""));

/**
 * Words from WebVTT inline timestamps: text before the first one starts with the cue, and each
 * word ends where the next starts or, for the last, where the cue ends.
 */
const inlineWords = (
  payload: string,
  startMs: number,
  endMs: number,
): Arr.NonEmptyReadonlyArray<LyricWord> | null => {
  const stamps = [...payload.matchAll(INLINE_TIME)];

  if (stamps.length === 0) return null;
  const starts = [startMs, ...stamps.map((stamp) => cueTimeMs(stamp[1] ?? "") ?? startMs)];
  const texts = payload.split(INLINE_TIME).filter((_, index) => index % 2 === 0);

  const words = texts.flatMap((raw, index): ReadonlyArray<LyricWord> => {
    const text = cleanText(raw);
    const wordStart = starts[index] ?? startMs;

    return text === "" ? [] : [{ text, startMs: wordStart, endMs: starts[index + 1] ?? endMs }];
  });

  return Arr.isReadonlyArrayNonEmpty(words) ? words : null;
};

interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  readonly payload: ReadonlyArray<string>;
}

/** Splits text into blocks at blank lines and reads the cue of each block with a timing line. */
const cuesOf = (text: string): ReadonlyArray<Cue> => {
  const blocks: Array<Array<string>> = [[]];

  for (const line of textLines(text)) {
    if (line.trim() === "") blocks.push([]);
    else blocks.at(-1)?.push(line);
  }

  return blocks.flatMap((block): ReadonlyArray<Cue> => {
    const timingAt = block.findIndex((line) => line.includes("-->"));
    const timing = CUE_TIMING.exec(block[timingAt] ?? "");

    if (timingAt > 1 || timing === null) return [];
    const startMs = cueTimeMs(timing[1] ?? "");
    const endMs = cueTimeMs(timing[2] ?? "");

    if (startMs === null || endMs === null) return [];

    return [{ startMs, endMs, payload: block.slice(timingAt + 1) }];
  });
};

/**
 * Reads WebVTT. Cue settings, `NOTE`, `STYLE`, and `REGION` blocks are skipped; `<v Name>` names
 * the singer; markup is removed; inline timestamps give word timing.
 */
export const parseVtt = (text: string): Result.Result<LyricBody, LyricsParseError> => {
  if (!/^(?:﻿)?WEBVTT(?:[ \t]|$)/mu.test(textLines(text)[0] ?? "")) {
    return Result.fail(new LyricsParseError({ reason: "malformed", detail: "no WEBVTT header" }));
  }

  return timedBody(
    cuesOf(text).map((cue): LyricLine => {
      const payload = cue.payload.join("\n");

      return {
        text: cleanText(payload).trim(),
        startMs: cue.startMs,
        endMs: cue.endMs,
        words: inlineWords(payload, cue.startMs, cue.endMs),
        voice: VOICE_TAG.exec(payload)?.[1]?.trim() ?? null,
      };
    }),
  );
};

/** Reads SubRip. Markup such as `<i>` and `{\an8}` is removed. */
export const parseSrt = (text: string): Result.Result<LyricBody, LyricsParseError> =>
  timedBody(
    cuesOf(text).map((cue): LyricLine => ({
      text: cleanText(cue.payload.join("\n")).trim(),
      startMs: cue.startMs,
      endMs: cue.endMs,
      words: null,
      voice: null,
    })),
  );
