/**
 * Lyricsfile 1.0 (https://github.com/tranxuanthang/lyricsfile): YAML with timed lines, optional
 * word timing, and a separate plain text version. LRCLIB serves it too.
 */
import { type Lang, LyricBody, type LyricLine, parseLang } from "@music/commands/lyrics";
import { Array as Arr, Result, Schema } from "effect";
import { parseDocument } from "yaml";

import { LyricsParseError, plainBody, timedBody } from "./lyric-body.ts";

/** Aliases a document may expand; the format asks writers to use none. */
const MAX_ALIASES = 50;

const Ms = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Timing = {
  text: Schema.String,
  start_ms: Ms,
  end_ms: Schema.optionalKey(Schema.NullOr(Ms)),
};

const LyricsfileDocument = Schema.Struct({
  // An unquoted `version: 1.0` is the number 1 to YAML.
  version: Schema.Literals(["1.0", 1]),
  metadata: Schema.Struct({
    language: Schema.optionalKey(Schema.NullOr(Schema.String)),
    instrumental: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  }),
  lines: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          ...Timing,
          words: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct(Timing)))),
        }),
      ),
    ),
  ),
  plain: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeDocument = Schema.decodeUnknownResult(LyricsfileDocument);

/** What a Lyricsfile holds: the lyrics to show and the language its metadata names. */
export interface LyricsfileLyrics {
  readonly body: LyricBody;
  readonly lang: Lang | null;
}

const malformed = (detail: string) =>
  Result.fail(new LyricsParseError({ reason: "malformed", detail }));

/**
 * Reads a Lyricsfile. YAML loads safely: duplicate keys, custom tags, more than one document,
 * deep nesting, and alias expansion past a small bound are rejected rather than resolved. Timed
 * lines win over `plain` unless their stamps carry no timing; `offset_ms` is ignored, since the
 * format has not settled what it means. A file marked instrumental has no lyrics to read.
 */
export const parseLyricsfile = (
  text: string,
): Result.Result<LyricsfileLyrics, LyricsParseError> => {
  const document = parseDocument(text, {
    uniqueKeys: true,
    schema: "core",
    strict: true,
    stringKeys: true,
  });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    const [problem] = [...document.errors, ...document.warnings];

    return malformed(`YAML ${problem?.code ?? "error"}`);
  }

  let value: unknown;

  try {
    value = document.toJS({ maxAliasCount: MAX_ALIASES });
  } catch {
    // `toJS` throws a ReferenceError when aliases expand past the bound.
    return malformed("YAML aliases expand too far");
  }

  const decoded = decodeDocument(value);

  if (Result.isFailure(decoded)) return malformed("not a Lyricsfile 1.0 document");

  const { metadata, lines, plain } = decoded.success;
  const lang = parseLang(metadata.language ?? "");

  if (metadata.instrumental === true) {
    return Result.fail(new LyricsParseError({ reason: "empty", detail: "marked instrumental" }));
  }

  const timed = (lines ?? []).map((line): LyricLine => {
    const words = (line.words ?? []).map((word) => ({
      text: word.text,
      startMs: word.start_ms,
      endMs: word.end_ms ?? null,
    }));

    return {
      text: line.text,
      startMs: line.start_ms,
      endMs: line.end_ms ?? null,
      words: Arr.isReadonlyArrayNonEmpty(words) ? words : null,
      voice: null,
    };
  });

  const fromLines = timedBody(timed);

  const withLang = (body: Result.Result<LyricBody, LyricsParseError>) =>
    Result.map(body, (lyrics): LyricsfileLyrics => ({ body: lyrics, lang }));

  if (Result.isSuccess(fromLines) && LyricBody.guards.Synced(fromLines.success)) {
    return withLang(fromLines);
  }

  return withLang(
    plain === undefined || plain === null || plain.trim() === "" ? fromLines : plainBody(plain),
  );
};
