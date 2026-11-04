import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ByteRange, parseByteRange } from "./byte-range.ts";

const size = fc.integer({ min: 1, max: 1_000_000_000 });

const offset = fc.integer({ min: 0, max: 2_000_000_000 });

describe("parseByteRange", () => {
  it("serves the whole file without a usable Range header", () => {
    for (const header of [
      undefined,
      "",
      "bytes=",
      "bytes=-",
      "items=0-1",
      "bytes=0-1,4-5",
      "bytes=5-2",
    ]) {
      expect(parseByteRange(header, 100)).toEqual(ByteRange.Full());
    }
  });

  it("resolves explicit, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=0-0", 100)).toEqual(ByteRange.Partial({ start: 0, end: 0 }));
    expect(parseByteRange("bytes=10-", 100)).toEqual(ByteRange.Partial({ start: 10, end: 99 }));
    expect(parseByteRange("bytes=90-500", 100)).toEqual(ByteRange.Partial({ start: 90, end: 99 }));
    expect(parseByteRange("bytes=-30", 100)).toEqual(ByteRange.Partial({ start: 70, end: 99 }));
    expect(parseByteRange("bytes=-500", 100)).toEqual(ByteRange.Partial({ start: 0, end: 99 }));
  });

  it("rejects ranges that start past the end", () => {
    expect(parseByteRange("bytes=100-", 100)).toEqual(ByteRange.Unsatisfiable());
    expect(parseByteRange("bytes=-0", 100)).toEqual(ByteRange.Unsatisfiable());
    expect(parseByteRange("bytes=0-", 0)).toEqual(ByteRange.Unsatisfiable());
  });

  it("keeps every partial range inside the file", () => {
    fc.assert(
      fc.property(
        size,
        fc.oneof(fc.string(), fc.stringMatching(/^bytes=\d{0,12}-\d{0,12}$/)),
        (fileSize, header) => {
          const range = parseByteRange(header, fileSize);

          if (ByteRange.$is("Partial")(range)) {
            expect(range.start).toBeGreaterThanOrEqual(0);
            expect(range.start).toBeLessThanOrEqual(range.end);
            expect(range.end).toBeLessThan(fileSize);
          }
        },
      ),
    );
  });

  it("clamps a first-last range to the file or reports it unsatisfiable", () => {
    fc.assert(
      fc.property(size, offset, offset, (fileSize, first, length) => {
        const last = first + length;

        expect(parseByteRange(`bytes=${first}-${last}`, fileSize)).toEqual(
          first >= fileSize
            ? ByteRange.Unsatisfiable()
            : ByteRange.Partial({ start: first, end: Math.min(last, fileSize - 1) }),
        );
      }),
    );
  });

  it("serves the last n bytes for a suffix range", () => {
    fc.assert(
      fc.property(size, size, (fileSize, suffix) => {
        expect(parseByteRange(`bytes=-${suffix}`, fileSize)).toEqual(
          ByteRange.Partial({ start: Math.max(0, fileSize - suffix), end: fileSize - 1 }),
        );
      }),
    );
  });
});
