import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { scrubLine } from "./transcode-diagnostics.ts";

const fold = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/** A folder or file name with what real ones hold: spaces, colons, brackets, dots. */
const segment = fc.stringMatching(/^[A-Za-z0-9 ():,.-]{1,16}$/u);

const path = fc
  .array(segment, { minLength: 1, maxLength: 6 })
  .map((parts) => `/${parts.join("/")}`);

/** What ffmpeg writes before a path, each ending where a path may start. */
const before = fc.constantFrom(
  "[h264_qsv @ 0x1] Error opening ",
  "[in#0 @ 0x2] Error opening input file ",
  "Input #0, matroska,webm, from ",
  "filename=",
  "(",
);

const after = fc.constantFrom(": Invalid data found when processing input", " failed", "");

describe("scrubLine", () => {
  it("removes a path in quotes and keeps what follows the quotes", () => {
    fc.assert(
      fc.property(before, path, after, fc.constantFrom("'", '"'), (start, file, end, quote) => {
        expect(scrubLine(`${start}${quote}${file}${quote}${end}`)).toBe(
          fold(`${start}<path>${end}`),
        );
      }),
    );
  });

  it("removes a bare path and everything after it, which a folder name could hold", () => {
    fc.assert(
      fc.property(before, path, after, (start, file, end) => {
        expect(scrubLine(`${start}${file}${end}`)).toBe(fold(`${start}<path>`));
      }),
    );
  });

  it("removes what is left of a path a cut left without its closing quote", () => {
    fc.assert(
      fc.property(before, path, (start, file) => {
        expect(scrubLine(`${start}'${file}`)).toBe(fold(`${start}'<path>`));
      }),
    );
  });

  it("keeps capability keys and ratios, and drops tokens, later lines, and control characters", () => {
    expect(scrubLine("[decode.qsv:h264/yuv420p10le] time_base 1/25 for move.cpu>qsv")).toBe(
      "[decode.qsv:h264/yuv420p10le] time_base 1/25 for move.cpu>qsv",
    );
    expect(scrubLine("request with token=v1.abc&ticket=t2 refused")).toBe(
      "request with token=<redacted>&ticket=<redacted> refused",
    );
    expect(scrubLine("  first\tline\u0007 \nsecond /media/secret.mkv")).toBe("first line");
    expect(scrubLine("x".repeat(500))).toHaveLength(200);
  });
});
