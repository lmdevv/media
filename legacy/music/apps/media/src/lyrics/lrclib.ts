/** Reads an LRCLIB lyrics record (https://lrclib.net/docs) through the same parsers as files. */
import { LrclibRecordId, LyricBody, LyricOrigin, type LyricSet } from "@music/commands/lyrics";
import { Array as Arr, Data, Result, Schema } from "effect";

import {
  LyricsParseError,
  mainSet,
  type ParsedLyricSet,
  plainBody,
  withinSizeLimit,
} from "./lyric-body.ts";
import { parseLrc } from "./lrc.ts";
import { parseLyricsfile } from "./lyricsfile.ts";

const LrclibRecord = Schema.Struct({
  id: LrclibRecordId,
  instrumental: Schema.Boolean,
  plainLyrics: Schema.NullOr(Schema.String),
  syncedLyrics: Schema.NullOr(Schema.String),
  // Newer than the rest of the record: an LRCLIB that predates it leaves the key out.
  lyricsfile: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeRecord = Schema.decodeResult(Schema.fromJsonString(LrclibRecord));

/**
 * What one LRCLIB record holds: lyrics, an instrumental answer, or neither (the record exists
 * but has no lyrics, which counts as a miss).
 */
export type LrclibLyrics = Data.TaggedEnum<{
  Found: { readonly recordId: LrclibRecordId; readonly sets: Arr.NonEmptyReadonlyArray<LyricSet> };
  Instrumental: { readonly recordId: LrclibRecordId };
  Empty: { readonly recordId: LrclibRecordId };
}>;

/** Constructors and matchers for `LrclibLyrics`. */
export const LrclibLyrics = Data.taggedEnum<LrclibLyrics>();

type Candidate = Arr.NonEmptyReadonlyArray<ParsedLyricSet>;

/** One of the record's lyric versions, read; null when the record leaves it blank. */
const candidate = (
  text: string | null | undefined,
  parse: (text: string) => Result.Result<Candidate, LyricsParseError>,
): Result.Result<Candidate, LyricsParseError> | null =>
  text === undefined || text === null || text.trim() === "" ? null : parse(text);

const readRecord = (json: string): Result.Result<LrclibLyrics, LyricsParseError> =>
  Result.match(decodeRecord(json), {
    onFailure: () =>
      Result.fail(new LyricsParseError({ reason: "malformed", detail: "not an LRCLIB record" })),
    onSuccess: (record) => {
      const recordId = record.id;

      if (record.instrumental) {
        return Result.succeed(LrclibLyrics.Instrumental({ recordId }));
      }

      const read = [
        candidate(record.lyricsfile, (text) =>
          Result.map(parseLyricsfile(text), (file) => mainSet(file.lang)(file.body)),
        ),
        candidate(record.syncedLyrics, (text) => parseLrc(text, null)),
        candidate(record.plainLyrics, (text) => Result.map(plainBody(text), mainSet(null))),
      ].filter((version) => version !== null);

      const versions = read.flatMap((version) =>
        Result.isSuccess(version) ? [version.success] : [],
      );

      const best =
        versions.find((version) => LyricBody.guards.Synced(version[0].body)) ?? versions[0];

      if (best !== undefined) {
        return Result.succeed(
          LrclibLyrics.Found({
            recordId,
            sets: Arr.map(best, (set): LyricSet => ({
              ...set,
              origin: LyricOrigin.cases.Lrclib.make({ recordId }),
            })),
          }),
        );
      }

      // Text without lyrics (only ID tags, or a Lyricsfile marked instrumental) is a miss. Text
      // that cannot be read is a failure, so a caller never caches it as one.
      const [unreadable] = read.flatMap((version) =>
        Result.isFailure(version) && version.failure.reason !== "empty" ? [version.failure] : [],
      );

      return unreadable === undefined
        ? Result.succeed(LrclibLyrics.Empty({ recordId }))
        : Result.fail(unreadable);
    },
  });

/**
 * Parses the JSON body of LRCLIB's `/api/get` (or one `/api/search` result). Of the record's
 * versions, the first with line timing wins, Lyricsfile (which can carry word timing) before
 * `syncedLyrics`; then `plainLyrics`. An `instrumental` record has no lyrics, whatever its text
 * fields say.
 *
 * @returns The record's lyrics, or `LyricsParseError` when the body is not an LRCLIB record, is
 * larger than a lyric file may be, or holds lyric text none of which can be read.
 */
export const parseLrclibRecord = (json: string): Result.Result<LrclibLyrics, LyricsParseError> =>
  Result.flatMap(withinSizeLimit(json, json.length, "characters"), readRecord);
