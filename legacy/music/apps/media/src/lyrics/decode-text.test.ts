import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { decodeLyricsText } from "./decode-text.ts";

const utf16 = (text: string, order: "le" | "be"): Uint8Array => {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(index * 2, text.charCodeAt(index), order === "le");
  }

  return bytes;
};

const withMark = (mark: ReadonlyArray<number>, bytes: Uint8Array): Uint8Array =>
  Uint8Array.from([...mark, ...bytes]);

const failureOf = (bytes: Uint8Array) =>
  Result.match(decodeLyricsText(bytes), {
    onSuccess: () => undefined,
    onFailure: (error) => error.reason,
  });

const LYRIC = "[00:01.00]Café, Straße\r\n[00:02.00]ここ";

describe("decodeLyricsText", () => {
  it("reads UTF-8 with or without a byte order mark, dropping the mark", () => {
    const bytes = new TextEncoder().encode(LYRIC);

    expect(Result.getOrThrow(decodeLyricsText(bytes))).toBe(LYRIC);
    expect(Result.getOrThrow(decodeLyricsText(withMark([0xef, 0xbb, 0xbf], bytes)))).toBe(LYRIC);
  });

  it("reads UTF-16 in either byte order, with a mark or without one", () => {
    expect(Result.getOrThrow(decodeLyricsText(withMark([0xff, 0xfe], utf16(LYRIC, "le"))))).toBe(
      LYRIC,
    );
    expect(Result.getOrThrow(decodeLyricsText(withMark([0xfe, 0xff], utf16(LYRIC, "be"))))).toBe(
      LYRIC,
    );
    expect(Result.getOrThrow(decodeLyricsText(utf16(LYRIC, "le")))).toBe(LYRIC);
    expect(Result.getOrThrow(decodeLyricsText(utf16(LYRIC, "be")))).toBe(LYRIC);
  });

  it("falls back to Windows-1252 for text that is not UTF-8", () => {
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94]);

    expect(Result.getOrThrow(decodeLyricsText(latin1))).toBe("Café “ok”");
  });

  it("refuses binary data and files past the size limit", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

    expect(failureOf(png)).toBe("not-text");
    expect(failureOf(new Uint8Array(256 * 1024 + 1).fill(0x61))).toBe("too-large");
  });
});
