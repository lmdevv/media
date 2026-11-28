import { join } from "node:path";

import { Duration, Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { coverKind, MAX_COVER_BYTES, READ_BLOCK } from "./cover-copy.ts";
import * as Files from "./music-files.ts";
import {
  adobeSegment,
  beforeJpegEnd,
  beforePngEnd,
  beforeSecondScan,
  exifOrientation,
  iccSegment,
  jpegProfile,
  jpegSegment,
  pngChunk,
  SRGB_CHUNKS,
  withChunks,
  withSegment,
} from "./testing/cover-images.ts";
import { PNG } from "./testing/music-fixtures.ts";

const COVERS = join(import.meta.dirname, "..", "testing", "fixtures", "covers");

const NAMES = [
  "photo.jpg",
  "progressive.jpg",
  "adobe-rgb.jpg",
  "profiled.jpg",
  "rotated.jpg",
  "soft-alpha.png",
  "transparent.png",
  "photo.png",
  "gray.jpg",
  "gray-profiled.jpg",
  "cmyk.jpg",
  "palette.png",
  "gamma.png",
  "animated.png",
  "animated.gif",
  "animated.webp",
  "alpha.webp",
  "exif-after-data.png",
  "fine-text.jpg",
] as const;

const fixtures = new Map<string, Uint8Array>();

/** The fixture cover named `name`, read before the tests run. */
const cover = (name: (typeof NAMES)[number]) => fixtures.get(name) ?? new Uint8Array();

let photo: Uint8Array = new Uint8Array();

let soft: Uint8Array = new Uint8Array();

let photoPng: Uint8Array = new Uint8Array();

beforeAll(async () => {
  const files = await Effect.runPromise(
    Effect.forEach(NAMES, (name) => Files.readWholeFile(join(COVERS, name))),
  );

  NAMES.forEach((name, index) => fixtures.set(name, files[index] ?? new Uint8Array()));
  photo = cover("photo.jpg");
  soft = cover("soft-alpha.png");
  photoPng = cover("photo.png");
});

/** The kind of the cover whose whole file is `bytes`. */
const kindOf = (bytes: Uint8Array) =>
  Effect.runSync(
    coverKind(bytes.length, (offset, length) =>
      Effect.succeed(bytes.subarray(offset, offset + length)),
    ),
  );

const exif = (orientation: number) => exifOrientation(orientation);

describe("coverKind", () => {
  it("names each kind a copy is proven for", () => {
    expect(kindOf(photo)).toBe("jpeg");
    expect(kindOf(cover("progressive.jpg"))).toBe("jpeg");
    expect(kindOf(withSegment(photo, 0xee, adobeSegment(1)))).toBe("jpeg");
    expect(kindOf(cover("adobe-rgb.jpg"))).toBe("jpeg-profiled");
    expect(kindOf(cover("profiled.jpg"))).toBe("jpeg-profiled");
    expect(kindOf(cover("rotated.jpg"))).toBe("jpeg-oriented");
    expect(kindOf(withSegment(photo, 0xe1, exif(1)))).toBe("jpeg");
    expect(kindOf(withSegment(cover("adobe-rgb.jpg"), 0xe1, exif(8)))).toBe("jpeg-oriented");
    expect(kindOf(soft)).toBe("png-alpha");
    expect(kindOf(withChunks(soft, SRGB_CHUNKS))).toBe("png-alpha");
    expect(kindOf(cover("transparent.png"))).toBe("png-alpha");
    expect(kindOf(photoPng)).toBe("png-opaque");
    expect(kindOf(withChunks(photoPng, SRGB_CHUNKS))).toBe("png-opaque");
  });

  it("keeps a kind past text, comments, and tables after the image data", () => {
    const text = pngChunk("tEXt", Buffer.from("Comment\0after the data", "latin1"));
    const comment = jpegSegment(0xfe, Buffer.from("after the scan", "latin1"));

    expect(kindOf(beforePngEnd(photoPng, [text]))).toBe("png-opaque");
    expect(kindOf(beforePngEnd(soft, [text]))).toBe("png-alpha");
    expect(kindOf(beforeJpegEnd(photo, comment))).toBe("jpeg");
    expect(kindOf(beforeSecondScan(cover("progressive.jpg"), comment))).toBe("jpeg");
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
      withSegment(withSegment(photo, 0xe1, exif(6)), 0xe1, exif(6)),
      withSegment(photo, 0xe1, exif(9)),
      withChunks(soft, SRGB_CHUNKS.slice(1)),
      withChunks(photoPng, [pngChunk("tRNS", Uint8Array.of(0, 255, 0, 0, 0, 255))]),
      withChunks(soft, [pngChunk("iCCP", Buffer.from("x\0\0", "latin1"))]),
      withChunks(soft, [pngChunk("eXIf", exif(6).subarray(6))]),
      withChunks(soft, [pngChunk("sRGB", Uint8Array.of(0)), pngChunk("sRGB", Uint8Array.of(0))]),
      // A 1x1 PNG whose image data runs past the length its chunk states.
      PNG,
      new Uint8Array([0x42, 0x4d, 0, 0]),
      new Uint8Array(),
    ];

    expect(unproven.map(kindOf)).toEqual(unproven.map(() => "unproven"));
  });

  it("names a cover unproven when anything after its image data can change the picture", () => {
    const profile = jpegProfile(cover("adobe-rgb.jpg"));
    const turned = jpegSegment(0xe1, exif(6));
    const profiled = jpegSegment(0xe2, iccSegment(profile));

    const trailing = [
      // The third verifier's 800x400 RGB PNG with an orientation after its image data.
      cover("exif-after-data.png"),
      beforePngEnd(photoPng, [pngChunk("eXIf", exif(6).subarray(6))]),
      beforePngEnd(soft, [pngChunk("eXIf", exif(6).subarray(6))]),
      beforePngEnd(photoPng, [pngChunk("iCCP", Buffer.from("x\0\0", "latin1"))]),
      beforePngEnd(soft, [pngChunk("sRGB", Uint8Array.of(0))]),
      Buffer.concat([photoPng, Buffer.from("after the end", "latin1")]),
      beforeJpegEnd(photo, turned),
      beforeJpegEnd(photo, profiled),
      beforeJpegEnd(cover("adobe-rgb.jpg"), turned),
      beforeJpegEnd(cover("rotated.jpg"), profiled),
      beforeSecondScan(cover("progressive.jpg"), turned),
      Buffer.concat([photo, Buffer.from("after the end", "latin1")]),
      Buffer.concat([photo, withSegment(photo, 0xe1, exif(6))]),
    ];

    expect(trailing.map(kindOf)).toEqual(trailing.map(() => "unproven"));
  });

  it("names a cover unproven when its file ends anywhere before its end", () => {
    for (const file of [photo, cover("progressive.jpg"), cover("rotated.jpg"), soft, photoPng]) {
      // Every length through the headers, then every 211th, and the last few bytes.
      const lengths = Array.from({ length: file.length }, (_, length) => length).filter(
        (length) => length < 1024 || length % 211 === 0 || length > file.length - 16,
      );

      expect(lengths.filter((length) => kindOf(file.subarray(0, length)) !== "unproven")).toEqual(
        [],
      );
    }
  });

  it("names a PNG unproven when any byte of a chunk before its image data is changed", () => {
    const tagged = withChunks(soft, SRGB_CHUNKS);
    const idat = Buffer.from(tagged).indexOf("IDAT") - 4;

    const changed = Array.from({ length: idat - 8 }, (_, index) => {
      const bytes = Uint8Array.from(tagged);

      bytes[8 + index] = (bytes[8 + index] ?? 0) ^ 0x01;

      return bytes;
    });

    expect(changed.map(kindOf).filter((kind) => kind === "png-alpha")).toEqual([]);
  });
});

/** The kind of `bytes`, told as a file `size` bytes long, and each read made telling it. */
const readsOf = async (bytes: Uint8Array, size = bytes.length) => {
  const reads: Array<{ readonly offset: number; readonly asked: number; readonly got: number }> =
    [];

  const kind = await Effect.runPromise(
    coverKind(size, (offset, length) =>
      Effect.sync(() => {
        const got = bytes.subarray(offset, offset + length);

        reads.push({ offset, asked: length, got: got.length });

        return got;
      }),
    ),
  );

  return { kind, reads };
};

const total = (values: ReadonlyArray<number>) => values.reduce((sum, value) => sum + value, 0);

describe("telling a cover's kind", () => {
  it("reads the fifth review's 667,016-byte JPEG once, in order, a block at a time", async () => {
    const fine = cover("fine-text.jpg");
    const { kind, reads } = await readsOf(fine);

    expect([fine.length, kind]).toEqual([667_016, "jpeg"]);
    expect({
      reads: reads.length,
      asked: total(reads.map(({ asked }) => asked)) <= fine.length + READ_BLOCK,
      got: total(reads.map(({ got }) => got)),
    }).toEqual({ reads: Math.ceil(fine.length / READ_BLOCK), asked: true, got: fine.length });
  });

  it("reads every cover forward, each byte at most once", async () => {
    const told = await Promise.all(
      NAMES.map(async (name) => ({ name, reads: (await readsOf(cover(name))).reads })),
    );

    const backward = told.flatMap(({ name, reads }) =>
      reads
        .filter((read, index) => {
          const last = reads[index - 1];

          return last !== undefined && read.offset < last.offset + last.got;
        })
        .map(() => name),
    );

    expect(backward).toEqual([]);
    expect(
      told
        .filter(({ name, reads }) => total(reads.map(({ got }) => got)) > cover(name).length)
        .map(({ name }) => name),
    ).toEqual([]);
  });

  it("names a cover over 16 MiB unproven without reading it", async () => {
    const { kind, reads } = await readsOf(photo, MAX_COVER_BYTES + 1);

    expect([MAX_COVER_BYTES, kind, reads.length]).toEqual([16 * 1024 * 1024, "unproven", 0]);
  });

  it(
    "names a cover undecided when telling its kind outlasts two seconds",
    { timeout: 15_000 },
    async () => {
      const fine = cover("fine-text.jpg");
      const started = performance.now();

      const kinds = await Effect.runPromise(
        Effect.all(
          [
            // A read that never answers, and reads that answer slowly.
            coverKind(photo.length, () => Effect.never),
            coverKind(fine.length, (offset, length) =>
              Effect.sleep(Duration.millis(500)).pipe(
                Effect.as(fine.subarray(offset, offset + length)),
              ),
            ),
          ],
          { concurrency: 2 },
        ),
      );

      const elapsed = performance.now() - started;

      expect(kinds).toEqual(["undecided", "undecided"]);
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(4_000);
    },
  );
});
