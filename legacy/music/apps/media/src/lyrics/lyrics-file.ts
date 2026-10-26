/** Reads one lyric file's text in any supported format into the lyric sets it holds. */
import type { Lang, LyricsFormat } from "@music/commands/lyrics";
import { type Array as Arr, Match, Result } from "effect";

import { type LyricsParseError, mainSet, type ParsedLyricSet } from "./lyric-body.ts";
import { parseLrc, parseLyricsText } from "./lrc.ts";
import { parseLyricsfile } from "./lyricsfile.ts";
import { parseSrt, parseVtt } from "./subtitles.ts";
import { parseTtml } from "./ttml.ts";

/**
 * Parses a lyric file's decoded text. `lang` is the language its name carries (`Song.de.lrc`),
 * or null; a language inside the file applies when the name has none. Every set is returned as
 * the source describes it; whether a whole file is a translation depends on the song's other
 * lyrics, which `localLyricSets` decides. The size limit applies to the file's bytes, in
 * `decodeLyricsText`.
 *
 * @returns The file's sets, main first, or `LyricsParseError` when it holds no readable lyrics.
 */
export const parseLyricsFile = (
  format: LyricsFormat,
  text: string,
  lang: Lang | null,
): Result.Result<Arr.NonEmptyReadonlyArray<ParsedLyricSet>, LyricsParseError> => {
  return Match.value(format).pipe(
    Match.whenOr("lrc", "elrc", () => parseLrc(text, lang)),
    Match.when("txt", () => parseLyricsText(text, lang)),
    Match.when("vtt", () => Result.map(parseVtt(text), mainSet(lang))),
    Match.when("srt", () => Result.map(parseSrt(text), mainSet(lang))),
    Match.when("ttml", () => parseTtml(text, lang)),
    Match.when("lyricsfile", () =>
      Result.map(parseLyricsfile(text), (file) => mainSet(lang ?? file.lang)(file.body)),
    ),
    Match.exhaustive,
  );
};
