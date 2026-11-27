import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { coverKind } from "./cover-copy.ts";
import {
  adobeSegment,
  exifOrientation,
  pngChunk,
  SRGB_CHUNKS,
  withChunks,
  withSegment,
} from "./testing/cover-images.ts";
import { PNG } from "./testing/music-fixtures.ts";

const COVERS = join(import.meta.dirname, "..", "testing", "fixtures", "covers");

const cover = (name: string) => new Uint8Array(readFileSync(join(COVERS, name)));

const photo = cover("photo.jpg");

const soft = cover("soft-alpha.png");

/** Where a JPEG's image data starts: its first start-of-scan segment ends here. */
const scanEnd = (jpeg: Uint8Array) => {
  const at = Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xda]));

  return at + 2 + ((jpeg[at + 2] ?? 0) << 8) + (jpeg[at + 3] ?? 0);
};

describe("coverKind", () => {
  it("names each kind a copy is proven for", () => {
    expect(coverKind(photo)).toBe("jpeg");
    expect(coverKind(cover("progressive.jpg"))).toBe("jpeg");
    expect(coverKind(withSegment(photo, 0xee, adobeSegment(1)))).toBe("jpeg");
    expect(coverKind(cover("adobe-rgb.jpg"))).toBe("jpeg-profiled");
    expect(coverKind(cover("profiled.jpg"))).toBe("jpeg-profiled");
    expect(coverKind(cover("rotated.jpg"))).toBe("jpeg-oriented");
    expect(coverKind(withSegment(photo, 0xe1, exifOrientation(1)))).toBe("jpeg");
    expect(coverKind(withSegment(cover("adobe-rgb.jpg"), 0xe1, exifOrientation(8)))).toBe(
      "jpeg-oriented",
    );
    expect(coverKind(soft)).toBe("png-alpha");
    expect(coverKind(withChunks(soft, SRGB_CHUNKS))).toBe("png-alpha");
    expect(coverKind(cover("transparent.png"))).toBe("png-alpha");
    expect(coverKind(PNG)).toBe("png-alpha");
    expect(coverKind(cover("photo.png"))).toBe("png-opaque");
    expect(coverKind(withChunks(cover("photo.png"), SRGB_CHUNKS))).toBe("png-opaque");
  });

  it("names every other cover unproven", () => {
    const unproven = [
      cover("gray.jpg"),
      cover("gray-profiled.jpg"),
      cover("cmyk.jpg"),
      cover("palette.png"),
      cover("gamma.png"),
      cover("animated.png"),
      cover("animated.gif"),
      cover("animated.webp"),
      cover("alpha.webp"),
      withSegment(photo, 0xee, adobeSegment(0)),
      withSegment(photo, 0xe2, Buffer.from("MPF\0II*\0", "latin1")),
      withSegment(photo, 0xe3, Buffer.from("Meta", "latin1")),
      withSegment(withSegment(photo, 0xe1, exifOrientation(6)), 0xe1, exifOrientation(6)),
      withSegment(photo, 0xe1, exifOrientation(9)),
      withChunks(soft, SRGB_CHUNKS.slice(1)),
      withChunks(cover("photo.png"), [pngChunk("tRNS", Uint8Array.of(0, 255, 0, 0, 0, 255))]),
      withChunks(soft, [pngChunk("iCCP", Buffer.from("x\0\0", "latin1"))]),
      withChunks(soft, [pngChunk("eXIf", exifOrientation(6).subarray(6))]),
      withChunks(soft, [pngChunk("sRGB", Uint8Array.of(0)), pngChunk("sRGB", Uint8Array.of(0))]),
      new Uint8Array([0x42, 0x4d, 0, 0]),
      new Uint8Array(),
    ];

    expect(unproven.map(coverKind)).toEqual(unproven.map(() => "unproven"));
  });

  it("names a cover unproven when its head ends anywhere before its image data", () => {
    const jpegs = [photo, cover("adobe-rgb.jpg"), cover("rotated.jpg")];
    const idat = Buffer.from(soft).indexOf("IDAT") - 4;

    for (const jpeg of jpegs) {
      const cuts = Array.from({ length: scanEnd(jpeg) }, (_, length) => jpeg.subarray(0, length));

      expect(cuts.map(coverKind).filter((kind) => kind !== "unproven")).toEqual([]);
    }

    const cuts = Array.from({ length: idat + 8 }, (_, length) => soft.subarray(0, length));

    expect(cuts.map(coverKind).filter((kind) => kind !== "unproven")).toEqual([]);
  });

  it("names a PNG unproven when any byte of a chunk before its image data is changed", () => {
    const tagged = withChunks(soft, SRGB_CHUNKS);
    const idat = Buffer.from(tagged).indexOf("IDAT") - 4;

    const changed = Array.from({ length: idat - 8 }, (_, index) => {
      const bytes = Uint8Array.from(tagged);

      bytes[8 + index] = (bytes[8 + index] ?? 0) ^ 0x01;

      return bytes;
    });

    expect(changed.map(coverKind).filter((kind) => kind === "png-alpha")).toEqual([]);
  });
});
