/** HTTP `Range` header handling for single byte ranges (RFC 9110 section 14). */
import { Data } from "effect";

/** What to send for a request against a file of a known size. `end` is inclusive. */
export type ByteRange = Data.TaggedEnum<{
  Full: {};
  Partial: { readonly start: number; readonly end: number };
  Unsatisfiable: {};
}>;

/** Constructors and matchers for `ByteRange`. */
export const ByteRange = Data.taggedEnum<ByteRange>();

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolves a `Range` header against a file size. Absent, malformed, or multi-range headers get
 * the full file, which RFC 9110 allows. `end` is clamped to the last byte.
 */
export const parseByteRange = (header: string | undefined, size: number): ByteRange => {
  if (header === undefined) return ByteRange.Full();
  const match = SINGLE_RANGE.exec(header.trim());

  if (match === null) return ByteRange.Full();
  const [, first = "", last = ""] = match;

  if (first === "" && last === "") return ByteRange.Full();

  if (first === "") {
    const suffix = Number(last);

    if (suffix === 0 || size === 0) return ByteRange.Unsatisfiable();

    return ByteRange.Partial({ start: Math.max(0, size - suffix), end: size - 1 });
  }

  const start = Number(first);

  if (last !== "" && Number(last) < start) return ByteRange.Full();

  if (start >= size) return ByteRange.Unsatisfiable();

  return ByteRange.Partial({
    start,
    end: last === "" ? size - 1 : Math.min(Number(last), size - 1),
  });
};
