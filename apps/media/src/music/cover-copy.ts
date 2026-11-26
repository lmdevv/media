import type { CoverFormat } from "../artwork/artwork-store.ts";

/**
 * The bytes of a stored cover the art route reads to choose its copy: enough for the headers of
 * any common cover, ICC profiles included.
 */
export const COVER_HEAD_BYTES = 1024 * 1024;

/**
 * How the art route serves a resized cover: as a copy in `CoverFormat`, or as the stored
 * original, for a cover a copy could not show the same.
 */
export type CoverCopy = CoverFormat | "original";

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG's copy. ffmpeg keeps an ICC profile but drops the other colour chunks, EXIF, and all but
 * the first frame, so a PNG with any of those is served as it is. A PNG with an alpha channel or
 * a transparent colour gets a PNG copy, and any other a JPEG one.
 */
const pngCopy = (head: Uint8Array): CoverCopy => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const chunks = new Set<string>();
  let colorType = -1;
  let offset = PNG_SIGNATURE.length;

  // Every chunk this reads comes before the image data.
  while (offset + 8 <= head.length) {
    const type = ascii(head, offset + 4, 4);

    if (type === "IDAT") break;

    if (type === "IHDR" && offset + 18 <= head.length) colorType = view.getUint8(offset + 17);
    chunks.add(type);
    offset += 12 + view.getUint32(offset);
  }

  if (offset + 8 > head.length || colorType === -1) return "original";

  const unkept = ["acTL", "eXIf", "cICP"].some((type) => chunks.has(type));
  const tagged = chunks.has("sRGB") || chunks.has("iCCP");

  if (unkept || (!tagged && (chunks.has("gAMA") || chunks.has("cHRM")))) return "original";

  return colorType === 4 || colorType === 6 || chunks.has("tRNS") ? "png" : "jpeg";
};

/**
 * A JPEG's copy. ffmpeg applies EXIF orientation and keeps an ICC profile, but a CMYK JPEG's
 * profile cannot describe the copy, so one is served as it is.
 */
const jpegCopy = (head: Uint8Array): CoverCopy => {
  let offset = 2;

  while (offset + 4 <= head.length) {
    if (head[offset] !== 0xff) return "original";
    const marker = head[offset + 1] ?? 0;

    // Fill bytes, then markers without a length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // The image data starts before any frame header: not a JPEG ffmpeg reads.
    if (marker === 0xda) return "original";
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

    if (frame) {
      const components = head[offset + 9];

      if (components === undefined) return "original";

      return components === 1 || components === 3 ? "jpeg" : "original";
    }

    offset += 2 + ((head[offset + 2] ?? 0) << 8) + (head[offset + 3] ?? 0);
  }

  return "original";
};

/**
 * A WebP's copy. An animated WebP, or one with EXIF, is served as it is. One with alpha gets a
 * PNG copy, and any other a JPEG one.
 */
const webpCopy = (head: Uint8Array): CoverCopy => {
  const chunk = ascii(head, 12, 4);

  if (chunk === "VP8 ") return "jpeg";

  if (chunk === "VP8L" && head.length >= 25) {
    // The alpha bit follows the 14-bit width and height, after the one-byte signature.
    return ((head[24] ?? 0) & 0x10) === 0 ? "jpeg" : "png";
  }

  if (chunk === "VP8X" && head.length >= 21) {
    const flags = head[20] ?? 0;
    const animated = (flags & 0x02) !== 0;
    const exif = (flags & 0x08) !== 0;

    if (animated || exif) return "original";

    return (flags & 0x10) === 0 ? "jpeg" : "png";
  }

  return "original";
};

/**
 * The copy of a cover whose file starts with `head`, so a resized cover looks the same as its
 * original over any background. A GIF, which may be animated, and anything unrecognised are
 * served as they are.
 */
export const coverCopy = (head: Uint8Array): CoverCopy => {
  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte)) return pngCopy(head);

  if (head[0] === 0xff && head[1] === 0xd8) return jpegCopy(head);

  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return webpCopy(head);

  return "original";
};
