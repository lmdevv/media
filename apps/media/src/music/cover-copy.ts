import { crc32 } from "node:zlib";

import { Context, Duration, Effect } from "effect";

import type { CoverFormat } from "../artwork/artwork-store.ts";
import type { FileError } from "./music-files.ts";

/**
 * The kinds of cover the art route resizes, each with the format of its copy. A kind is here only
 * with a route test that takes a real file of the kind through ffmpeg and compares the copy with
 * the original shrunk by area averaging (`cover-art.test.ts`). Every other cover is served as
 * stored, which always looks right.
 */
export const COPIED_KINDS = {
  /** An 8-bit YCbCr JPEG, baseline or progressive, without an ICC profile or EXIF orientation. */
  jpeg: "jpeg",
  /** The same with one RGB ICC profile, which ffmpeg writes into the copy byte for byte. */
  "jpeg-profiled": "jpeg",
  /** Either of those with an EXIF orientation, which ffmpeg applies to the copy's pixels. */
  "jpeg-oriented": "jpeg",
  /**
   * An 8-bit RGBA PNG, not interlaced, untagged or sRGB, copied as a PNG scaled with
   * premultiplied alpha, which keeps its `sRGB`, `gAMA`, and `cHRM` chunks.
   */
  "png-alpha": "png",
  /**
   * An 8-bit RGB PNG with no transparent colour, not interlaced, untagged or sRGB, copied as a
   * JPEG, which a viewer draws as sRGB.
   */
  "png-opaque": "jpeg",
} as const satisfies Record<string, CoverFormat>;

/** A kind of cover the art route resizes. */
type CopiedKind = keyof typeof COPIED_KINDS;

/** What a cover's header shows: a kind the art route resizes, or `unproven`, served as stored. */
export type CoverKind = CopiedKind | "unproven";

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const startsWith = (bytes: Uint8Array, text: string): boolean =>
  bytes.length >= text.length && ascii(bytes, 0, text.length) === text;

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The orientation an EXIF payload's first IFD gives (TIFF 6.0 tag 274), 1 when it gives none, or
 * undefined when the payload is not one this reads whole.
 */
const exifOrientation = (tiff: Uint8Array): number | undefined => {
  const little = startsWith(tiff, "II");

  if (tiff.length < 8 || (!little && !startsWith(tiff, "MM"))) return undefined;
  const view = viewOf(tiff);

  if (view.getUint16(2, little) !== 42) return undefined;
  const ifd = view.getUint32(4, little);

  if (ifd + 2 > tiff.length) return undefined;
  const count = view.getUint16(ifd, little);

  if (ifd + 2 + count * 12 > tiff.length) return undefined;

  const entry = Array.from({ length: count }, (_, index) => ifd + 2 + index * 12).find(
    (at) => view.getUint16(at, little) === 0x0112,
  );

  if (entry === undefined) return 1;

  // One SHORT, held in the entry itself.
  if (view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) {
    return undefined;
  }

  const orientation = view.getUint16(entry + 8, little);

  return orientation >= 1 && orientation <= 8 ? orientation : undefined;
};

/** True for an APP2 ICC payload holding a whole RGB profile in one segment. */
const isWholeRgbProfile = (payload: Uint8Array): boolean => {
  const profile = payload.subarray(14);

  return (
    startsWith(payload, "ICC_PROFILE\0") &&
    payload[12] === 1 &&
    payload[13] === 1 &&
    profile.length >= 128 &&
    viewOf(profile).getUint32(0) === profile.length &&
    ascii(profile, 16, 4) === "RGB "
  );
};

/** A JPEG frame header (ITU T.81 B.2.2): its sample precision and each component's id and sampling. */
interface Frame {
  readonly precision: number;
  readonly components: ReadonlyArray<{ readonly id: number; readonly sampling: number }>;
}

const frameOf = (payload: Uint8Array): Frame | undefined => {
  const count = payload[5] ?? 0;
  const view = viewOf(payload);

  if (payload.length < 6 || payload.length !== 6 + 3 * count) return undefined;

  if (view.getUint16(1) === 0 || view.getUint16(3) === 0) return undefined;

  return {
    precision: payload[0] ?? 0,
    components: Array.from({ length: count }, (_, index) => ({
      id: payload[6 + 3 * index] ?? 0,
      sampling: payload[7 + 3 * index] ?? 0,
    })),
  };
};

/**
 * True for 4:4:4, 4:2:2, 4:4:0, or 4:2:0: both chroma components sampled alike, and luma once or
 * twice as often each way. Each byte holds a component's horizontal and vertical factors.
 */
const isCommonSampling = (luma: number, blue: number, red: number): boolean => {
  const ratio = (shift: number) => ((luma >> shift) & 0xf) / ((blue >> shift) & 0xf);

  return blue === red && [ratio(4), ratio(0)].every((each) => each === 1 || each === 2);
};

const R_G_B = [0x52, 0x47, 0x42];

/** Reads up to `length` bytes of a cover from `offset`, fewer past its end. */
export type ReadCover = (offset: number, length: number) => Effect.Effect<Uint8Array, FileError>;

/** How many bytes telling a cover's kind reads at a time, at least. */
export const READ_BLOCK = 64 * 1024;

/**
 * The largest cover the art route reads to tell its kind, 16 MiB. Covers that taggers embed and
 * stores sell, 3000x3000 JPEGs among them, take a few megabytes; this bounds one pass to 256 block
 * reads and the largest segment or chunk it holds whole. A larger file is `unproven` without being
 * read, and served as stored, which always looks right.
 */
export const MAX_COVER_BYTES = 16 * 1024 * 1024;

/**
 * How long telling a cover's kind may take. One pass over `MAX_COVER_BYTES` from a local disk takes
 * tens of milliseconds; a walk still going after this is `undecided`. The time is the server's
 * clock from the walk's start, so it also counts time the server spent on other work.
 */
export const ClassifyWithin = Context.Reference<Duration.Duration>(
  "@media/server/CoverCopy/ClassifyWithin",
  { defaultValue: () => Duration.seconds(2) },
);

/** A cover read in one forward pass. */
interface Forward {
  /** Up to `length` bytes from `offset`, which is at or past every offset asked before. */
  readonly at: ReadCover;
  /** The bytes from `offset` to the end of the block in hand, reading the next block if none are. */
  readonly rest: (offset: number) => Effect.Effect<Uint8Array, FileError>;
}

/**
 * `read` in one forward pass: each read starts where the last one ended, or further on past a
 * skipped range, so a walk reads each byte of the file at most once, in order. It holds one block,
 * or two across a block's end, or one segment or chunk it checks whole.
 */
const forward = (size: number, read: ReadCover): Forward => {
  let start = 0;
  let block: Uint8Array = new Uint8Array(0);

  const fill = Effect.fnUntraced(function* (
    offset: number,
    length: number,
  ): Effect.fn.Return<void, FileError> {
    if (offset + length <= start + block.length) return;

    if (offset >= start + block.length) {
      start = offset;
      block = new Uint8Array(0);
    } else {
      block = block.subarray(offset - start);
      start = offset;
    }

    while (start + block.length < Math.min(offset + length, size)) {
      const from = start + block.length;
      const more = yield* read(from, Math.max(READ_BLOCK, offset + length - from));

      if (more.length === 0) return;
      const joined = new Uint8Array(block.length + more.length);

      joined.set(block);
      joined.set(more, block.length);
      block = joined;
    }
  });

  return {
    at: (offset, length) =>
      Effect.map(fill(offset, length), () =>
        block.subarray(offset - start, Math.min(offset - start + length, block.length)),
      ),
    rest: (offset) =>
      Effect.map(fill(offset, offset < start + block.length ? 0 : 1), () =>
        block.subarray(offset - start),
      ),
  };
};

/** The kind a JPEG's frame and segments before its first scan describe. */
interface JpegHeader {
  readonly frame: Frame;
  readonly orientation: number | undefined;
  readonly profiled: boolean;
  readonly transform: number | undefined;
}

const jpegHeaderKind = ({ frame, orientation, profiled, transform }: JpegHeader): CoverKind => {
  if (frame.precision !== 8 || frame.components.length !== 3) return "unproven";

  const ids = frame.components.map(({ id }) => id);

  // YCbCr: Adobe's segment says so with transform 1; without it, ids R, G, B mean RGB.
  const ycbcr =
    transform === undefined ? ids.some((id, index) => id !== R_G_B[index]) : transform === 1;

  const [luma = 0, blue = 0, red = 0] = frame.components.map(({ sampling }) => sampling);

  if (!ycbcr || !isCommonSampling(luma, blue, red)) return "unproven";

  if (orientation !== undefined && orientation !== 1) return "jpeg-oriented";

  return profiled ? "jpeg-profiled" : "jpeg";
};

/** Tables, a restart interval, and a comment: segments that may sit between scans. */
const BETWEEN_SCANS = new Set([0xc4, 0xdb, 0xdd, 0xfe]);

/**
 * Where the marker after `from` in a JPEG's coded data starts, past stuffed and restart bytes, or
 * undefined at the end of the file without one.
 */
const nextMarker = Effect.fnUntraced(function* (
  cover: Forward,
  from: number,
): Effect.fn.Return<number | undefined, FileError> {
  let position = from;

  for (;;) {
    const bytes = yield* cover.rest(position);

    if (bytes.length === 0) return undefined;
    const found = bytes.indexOf(0xff);

    if (found === -1) {
      position += bytes.length;
      continue;
    }

    const pair = yield* cover.at(position + found, 2);

    if (pair.length < 2) return undefined;
    const next = pair[1] ?? 0;

    // A stuffed 0xFF, a restart marker, or a fill byte belongs to the coded data.
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
      position += found + 1;
      continue;
    }

    return position + found;
  }
});

/**
 * A JPEG's kind, from every segment in the file. Before the first scan only the segments named here
 * are read; between scans only tables, a restart interval, a comment, and further scans; and the
 * end of image must end the file. ffmpeg reads an orientation or a profile anywhere before the end
 * while viewers stop at the first scan, so any other marker, a second frame header or EXIF
 * segment, or a segment cut off by the file's end makes the cover `unproven`.
 */
const jpegKind = Effect.fnUntraced(function* (
  size: number,
  cover: Forward,
): Effect.fn.Return<CoverKind, FileError> {
  const { at } = cover;
  let offset = 2;
  let frame: Frame | undefined;
  let orientation: number | undefined;
  let profiled = false;
  let transform: number | undefined;
  let kind: CoverKind | undefined;

  while (kind === undefined) {
    const head = yield* at(offset, 4);

    if (head[0] !== 0xff) return "unproven";
    const marker = head[1] ?? 0;

    // A fill byte before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    const end = offset + 2 + ((head[2] ?? 0) << 8) + (head[3] ?? 0);

    if (head.length < 4 || end > size || end < offset + 4) return "unproven";
    const payload = yield* at(offset + 4, end - offset - 4);

    switch (marker) {
      // Start of scan: every segment a viewer draws the picture from came before it.
      case 0xda:
        if (frame === undefined) return "unproven";
        kind = jpegHeaderKind({ frame, orientation, profiled, transform });

        if (kind === "unproven") return kind;
        break;

      // Baseline, extended sequential, and progressive frames, Huffman coded.
      case 0xc0:
      case 0xc1:
      case 0xc2:
        if (frame !== undefined) return "unproven";

        frame = frameOf(payload);

        if (frame === undefined) return "unproven";
        break;
      // Huffman and quantization tables, restart interval, comment.
      case 0xc4:
      case 0xdb:
      case 0xdd:
      case 0xfe:
        break;
      case 0xe0:
        if (!startsWith(payload, "JFIF\0") && !startsWith(payload, "JFXX\0")) return "unproven";
        break;
      case 0xe1:
        if (startsWith(payload, "Exif\0\0")) {
          if (orientation !== undefined) return "unproven";
          orientation = exifOrientation(payload.subarray(6));

          if (orientation === undefined) return "unproven";
        } else if (!startsWith(payload, "http://ns.adobe.com/xap/1.0/\0")) {
          return "unproven";
        }

        break;
      case 0xe2:
        if (profiled || !isWholeRgbProfile(payload)) return "unproven";
        profiled = true;
        break;
      // Photoshop's export settings and resources, which no viewer draws from.
      case 0xec:
      case 0xed:
        if (!startsWith(payload, "Ducky") && !startsWith(payload, "Photoshop 3.0\0")) {
          return "unproven";
        }

        break;
      case 0xee:
        if (transform !== undefined || payload.length < 12 || !startsWith(payload, "Adobe")) {
          return "unproven";
        }

        transform = payload[11];
        break;
      default:
        return "unproven";
    }

    offset = end;
  }

  // The coded data, and only tables, a comment, or another scan until the end of image.
  for (;;) {
    const marked = yield* nextMarker(cover, offset);

    if (marked === undefined) return "unproven";
    const head = yield* at(marked, 4);
    const marker = head[1] ?? 0;

    if (marker === 0xd9) return marked + 2 === size ? kind : "unproven";

    if (marker !== 0xda && !BETWEEN_SCANS.has(marker)) return "unproven";
    const end = marked + 2 + ((head[2] ?? 0) << 8) + (head[3] ?? 0);

    if (head.length < 4 || end > size || end < marked + 4) return "unproven";
    offset = end;
  }
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks a viewer draws nothing from that may come only before the image data. */
const BEFORE_DATA_CHUNKS = new Set(["pHYs", "bKGD", "sBIT"]);

/** Text and time, which a viewer draws nothing from, before or after the image data. */
const TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "tIME"]);

/** RGBA, and RGB, which carries no transparent colour since `tRNS` is not among the chunks read. */
const PNG_COLOUR_KINDS = new Map<number, CoverKind>([
  [6, "png-alpha"],
  [2, "png-opaque"],
]);

/** The colour chunks read beside sRGB, each at most once, by the length of its data. */
const COLOUR_CHUNKS = new Map([
  ["sRGB", 1],
  ["gAMA", 4],
  ["cHRM", 32],
]);

/** True when a chunk of `length` at `offset`, read whole, matches its CRC. */
const crcMatches = Effect.fnUntraced(function* (
  at: ReadCover,
  offset: number,
  length: number,
): Effect.fn.Return<boolean, FileError> {
  const chunk = yield* at(offset, 12 + length);

  return (
    chunk.length === 12 + length &&
    crc32(chunk.subarray(4, 8 + length)) === viewOf(chunk).getUint32(8 + length)
  );
});

/**
 * A PNG's kind, from every chunk in the file, walked by their lengths to `IEND`, which must end the
 * file. Only the chunks named here are read, each in its place: the header first, colour chunks
 * (with their CRC) and other inert chunks before the image data, which is one run of `IDAT`, and
 * text after it. Any other chunk, wherever it sits, or a chunk cut off by the file's end makes the
 * cover `unproven`: ffmpeg 9 turns a picture by an `eXIf` chunk even after the image data.
 */
const pngKind = Effect.fnUntraced(function* (
  size: number,
  at: ReadCover,
): Effect.fn.Return<CoverKind, FileError> {
  const seen = new Set<string>();
  let header: Uint8Array | undefined;
  let data: "before" | "in" | "after" = "before";
  let offset = PNG_SIGNATURE.length;

  for (;;) {
    const head = yield* at(offset, 8);

    if (head.length < 8) return "unproven";
    const length = viewOf(head).getUint32(0);
    const type = ascii(head, 4, 4);
    const end = offset + 12 + length;

    if (end > size) return "unproven";

    if (header === undefined) {
      if (type !== "IHDR" || length !== 13 || !(yield* crcMatches(at, offset, length))) {
        return "unproven";
      }

      header = yield* at(offset + 8, 13);
    } else if (type === "IDAT") {
      if (data === "after") return "unproven";
      data = "in";
    } else if (type === "IEND") {
      if (data === "before" || length !== 0 || end !== size) return "unproven";

      // 8-bit, deflate, adaptive filtering, not interlaced, at least a pixel each way.
      const view = viewOf(header);

      const plain =
        view.getUint32(0) > 0 &&
        view.getUint32(4) > 0 &&
        header[8] === 8 &&
        [0, 0, 0].every((byte, index) => header?.[10 + index] === byte);

      // Gamma or primaries alone carry colour ffmpeg's copy would not be drawn with.
      const srgb = seen.has("sRGB") || (!seen.has("gAMA") && !seen.has("cHRM"));

      return plain && srgb ? (PNG_COLOUR_KINDS.get(header[9] ?? 0) ?? "unproven") : "unproven";
    } else {
      const colour = COLOUR_CHUNKS.get(type);

      const known =
        TEXT_CHUNKS.has(type) ||
        (data === "before" && BEFORE_DATA_CHUNKS.has(type)) ||
        (data === "before" &&
          colour === length &&
          !seen.has(type) &&
          (yield* crcMatches(at, offset, length)));

      if (!known) return "unproven";

      if (data === "in") data = "after";
    }

    seen.add(type);
    offset = end;
  }
});

/**
 * What telling a cover's kind gives: its kind, or `undecided` when the walk took longer than
 * `ClassifyWithin`, served as stored this time and told again on a later request.
 */
export type Classified = CoverKind | "undecided";

const walk = Effect.fnUntraced(function* (
  size: number,
  read: ReadCover,
): Effect.fn.Return<CoverKind, FileError> {
  const cover = forward(size, read);
  const head = yield* cover.at(0, 8);

  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte)) {
    return yield* pngKind(size, cover.at);
  }

  if (head[0] === 0xff && head[1] === 0xd8) return yield* jpegKind(size, cover);

  return "unproven";
});

/**
 * The kind of the cover `read` gives, `size` bytes long: one of `COPIED_KINDS` when one forward pass
 * over the whole file shows it as one, or `unproven`, served as stored. A cover over
 * `MAX_COVER_BYTES` is `unproven` unread; a pass longer than `within` (`ClassifyWithin`) is
 * `undecided`.
 *
 * The pass reads at most `size` bytes, in order, each at most once, in about `size / READ_BLOCK`
 * reads, plus one for each range of a PNG it skips, and scans them once: its cost grows with the
 * file's size alone.
 */
export const coverKind = (
  size: number,
  read: ReadCover,
  within: Duration.Duration,
): Effect.Effect<Classified, FileError> =>
  size > MAX_COVER_BYTES
    ? Effect.succeed("unproven")
    : walk(size, read).pipe(
        Effect.timeoutOrElse({
          duration: within,
          orElse: () => Effect.succeed("undecided" as const),
        }),
      );
