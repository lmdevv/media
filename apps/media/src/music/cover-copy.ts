import { crc32 } from "node:zlib";

import type { CoverFormat } from "../artwork/artwork-store.ts";

/**
 * The bytes of a stored cover the art route reads to tell its kind: enough for the headers of any
 * common cover, ICC profiles included.
 */
export const COVER_HEAD_BYTES = 1024 * 1024;

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

/**
 * A JPEG's kind, from every segment before its image data. Only the segments named here are
 * read: any other marker, a second frame header or EXIF segment, or a segment cut off by the head
 * makes the cover `unproven`.
 */
const jpegKind = (head: Uint8Array): CoverKind => {
  const view = viewOf(head);
  let offset = 2;
  let frame: Frame | undefined;
  let orientation: number | undefined;
  let profiled = false;
  let transform: number | undefined;

  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) return "unproven";
    const marker = head[offset + 1] ?? 0;

    // A fill byte before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    const end = offset + 2 + view.getUint16(offset + 2);

    if (end > head.length || end < offset + 4) return "unproven";
    const payload = head.subarray(offset + 4, end);

    switch (marker) {
      // Start of scan: every segment that describes the picture came before it.
      case 0xda: {
        if (frame === undefined || frame.precision !== 8 || frame.components.length !== 3) {
          return "unproven";
        }

        const ids = frame.components.map(({ id }) => id);

        // YCbCr: Adobe's segment says so with transform 1; without it, ids R, G, B mean RGB.
        const ycbcr =
          transform === undefined ? ids.some((id, index) => id !== R_G_B[index]) : transform === 1;

        const [luma = 0, blue = 0, red = 0] = frame.components.map(({ sampling }) => sampling);

        if (!ycbcr || !isCommonSampling(luma, blue, red)) return "unproven";

        if (orientation !== undefined && orientation !== 1) return "jpeg-oriented";

        return profiled ? "jpeg-profiled" : "jpeg";
      }

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

  return "unproven";
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks that describe nothing a viewer draws: text, time, density, and background and bit hints. */
const INERT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "tIME", "pHYs", "bKGD", "sBIT"]);

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

/**
 * A PNG's kind, from its header and every chunk before its image data, each whole and with its
 * CRC. Only the chunks named here are read: any other makes the cover `unproven`.
 */
const pngKind = (head: Uint8Array): CoverKind => {
  const view = viewOf(head);
  const seen = new Set<string>();
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= head.length) {
    const length = view.getUint32(offset);
    const type = ascii(head, offset + 4, 4);

    if (type === "IDAT") {
      // 8-bit, deflate, adaptive filtering, not interlaced, at least a pixel each way.
      const plain =
        seen.has("IHDR") &&
        view.getUint32(16) > 0 &&
        view.getUint32(20) > 0 &&
        head[24] === 8 &&
        [0, 0, 0].every((byte, index) => head[26 + index] === byte);

      // Gamma or primaries alone carry colour ffmpeg's copy would not be drawn with.
      const srgb = seen.has("sRGB") || (!seen.has("gAMA") && !seen.has("cHRM"));

      if (!plain || !srgb) return "unproven";

      return PNG_COLOUR_KINDS.get(head[25] ?? 0) ?? "unproven";
    }

    const end = offset + 12 + length;

    if (
      end > head.length ||
      crc32(head.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)
    ) {
      return "unproven";
    }

    const first = offset === PNG_SIGNATURE.length;

    const known =
      type === "IHDR"
        ? first && length === 13
        : !first &&
          (INERT_CHUNKS.has(type) || (COLOUR_CHUNKS.get(type) === length && !seen.has(type)));

    if (!known) return "unproven";
    seen.add(type);
    offset = end;
  }

  return "unproven";
};

/**
 * The kind of the cover whose file starts with `head`: one of `COPIED_KINDS` when its header shows
 * it whole, or `unproven`, served as stored.
 */
export const coverKind = (head: Uint8Array): CoverKind => {
  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte)) return pngKind(head);

  if (head[0] === 0xff && head[1] === 0xd8) return jpegKind(head);

  return "unproven";
};
