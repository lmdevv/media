/** Turns the bytes of a lyric file into text, whatever encoding its editor saved it in. */
import { Result } from "effect";

import { LyricsParseError, withinSizeLimit } from "./lyric-body.ts";

const BYTE_ORDER_MARKS = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xff, 0xfe], "utf-16le"],
  [[0xfe, 0xff], "utf-16be"],
] as const;

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

/**
 * UTF-16 saved without a byte order mark: ASCII-range text puts a zero in every other byte, low
 * byte first for little-endian. Null when the zeros fall on neither side.
 */
const utf16WithoutMark = (bytes: Uint8Array): "utf-16le" | "utf-16be" | null => {
  let even = 0;
  let odd = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;

    if (index % 2 === 0) even += 1;
    else odd += 1;
  }

  const half = bytes.length / 2;

  if (odd > half * 0.3 && even < half * 0.05) return "utf-16le";

  if (even > half * 0.3 && odd < half * 0.05) return "utf-16be";

  return null;
};

const decodeAs = (encoding: string, bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    // A fatal decoder throws a TypeError on the first invalid sequence.
    return null;
  }
};

const decodeBytes = (bytes: Uint8Array): Result.Result<string, LyricsParseError> => {
  const marked = BYTE_ORDER_MARKS.find(([mark]) => startsWith(bytes, mark))?.[1];
  const encoding = marked ?? utf16WithoutMark(bytes);

  const text =
    encoding === null
      ? (decodeAs("utf-8", bytes) ?? new TextDecoder("windows-1252").decode(bytes))
      : decodeAs(encoding, bytes);

  if (text === null || text.includes("\u0000")) {
    return Result.fail(new LyricsParseError({ reason: "not-text", detail: "binary data" }));
  }

  return Result.succeed(text);
};

/**
 * Decodes a lyric file's bytes: UTF-8 or UTF-16 by byte order mark, UTF-16 without one, then
 * UTF-8, then Windows-1252 (Latin-1) for older files that are not valid UTF-8. The mark is
 * dropped.
 *
 * @returns The text, or `LyricsParseError` when the file is too large or holds binary data.
 */
export const decodeLyricsText = (bytes: Uint8Array): Result.Result<string, LyricsParseError> =>
  Result.flatMap(withinSizeLimit(bytes, bytes.length, "bytes"), decodeBytes);
