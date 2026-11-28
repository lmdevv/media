/**
 * Cover images in tests: decoding with ffmpeg, a reference downscale by area averaging, EXIF
 * orientation applied by hand, PSNR, and covers of a kind made by splicing JPEG segments or PNG
 * chunks into a real file.
 */
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { ffmpeg } from "./music-songs.ts";

/** An image as 8-bit RGBA, row by row. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * The image in `file` as 8-bit RGBA, turned upright by its EXIF orientation, or as stored with
 * `stored`.
 */
export const decodeRgba = async (file: string, stored = false): Promise<Rgba> => {
  const pam = join(tmpdir(), `media-cover-${randomUUID()}.pam`);

  await ffmpeg([
    ...(stored ? ["-noautorotate"] : []),
    "-v",
    "error",
    "-i",
    file,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgba",
    "-c:v",
    "pam",
    "-f",
    "image2",
    "-update",
    "1",
    pam,
  ]);
  const bytes = new Uint8Array(await readFile(pam));

  await rm(pam);
  const end = Buffer.from(bytes).indexOf("ENDHDR\n") + "ENDHDR\n".length;
  const header = Buffer.from(bytes.subarray(0, end)).toString("latin1");
  const field = (name: string) => Number(new RegExp(`${name} (\\d+)`, "u").exec(header)?.[1]);

  return { width: field("WIDTH"), height: field("HEIGHT"), data: bytes.subarray(end) };
};

/**
 * Where each output pixel along one axis takes its input from when `from` pixels shrink to `to`:
 * every input pixel it covers, weighted by how much of it.
 */
const coverage = (from: number, to: number) =>
  Array.from({ length: to }, (_, index) => {
    const start = (index * from) / to;
    const end = ((index + 1) * from) / to;

    return Array.from({ length: Math.ceil(end) - Math.floor(start) }, (__, tap) => {
      const pixel = Math.floor(start) + tap;

      return { pixel, weight: Math.min(end, pixel + 1) - Math.max(start, pixel) };
    });
  });

/**
 * `image` shrunk to `width` by `height` by area averaging with premultiplied alpha: each output
 * pixel is the mean of the input it covers, the reference a resized copy is compared with.
 */
export const areaScale = (image: Rgba, width: number, height: number): Rgba => {
  const columns = coverage(image.width, width);
  const rows = coverage(image.height, height);

  const at = (x: number, y: number, channel: number) =>
    image.data[(y * image.width + x) * 4 + channel] ?? 0;

  const data = new Uint8Array(width * height * 4);

  rows.forEach((row, y) => {
    columns.forEach((column, x) => {
      const sum = [0, 0, 0, 0];
      let area = 0;

      for (const { pixel: sy, weight: wy } of row) {
        for (const { pixel: sx, weight: wx } of column) {
          const weight = wx * wy;
          const alpha = at(sx, sy, 3);

          sum[0] = (sum[0] ?? 0) + at(sx, sy, 0) * alpha * weight;
          sum[1] = (sum[1] ?? 0) + at(sx, sy, 1) * alpha * weight;
          sum[2] = (sum[2] ?? 0) + at(sx, sy, 2) * alpha * weight;
          sum[3] = (sum[3] ?? 0) + alpha * weight;
          area += weight;
        }
      }

      const alpha = (sum[3] ?? 0) / area;
      const target = (y * width + x) * 4;

      for (const channel of [0, 1, 2]) {
        data[target + channel] = alpha === 0 ? 0 : Math.round((sum[channel] ?? 0) / area / alpha);
      }

      data[target + 3] = Math.round(alpha);
    });
  });

  return { width, height, data };
};

/**
 * `stored` as EXIF `orientation` (1 to 8) says to show it: the stored pixel each shown pixel
 * comes from, per TIFF 6.0's Orientation tag.
 */
export const orient = (stored: Rgba, orientation: number): Rgba => {
  const { width: w, height: h } = stored;
  const turned = orientation >= 5;
  const width = turned ? h : w;
  const height = turned ? w : h;

  const source = (x: number, y: number): readonly [number, number] => {
    switch (orientation) {
      case 2:
        return [w - 1 - x, y];
      case 3:
        return [w - 1 - x, h - 1 - y];
      case 4:
        return [x, h - 1 - y];
      case 5:
        return [y, x];
      case 6:
        return [y, h - 1 - x];
      case 7:
        return [w - 1 - y, h - 1 - x];
      case 8:
        return [w - 1 - y, x];
      default:
        return [x, y];
    }
  };

  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [sx, sy] = source(x, y);

      data.set(stored.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * width + x) * 4);
    }
  }

  return { width, height, data };
};

const psnr = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  const squared = a.reduce((sum, value, index) => sum + (value - (b[index] ?? 0)) ** 2, 0);

  return squared === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / squared);
};

/** The colour channels of `image` drawn over a plain `background` level. */
const over = (image: Rgba, background: number): Array<number> =>
  Array.from({ length: (image.data.length / 4) * 3 }, (_, index) => {
    const pixel = Math.floor(index / 3) * 4;
    const alpha = (image.data[pixel + 3] ?? 0) / 255;

    return (image.data[pixel + (index % 3)] ?? 0) * alpha + background * (1 - alpha);
  });

/** PSNR in dB of `copy` against `reference` of the same size, drawn over white and over black, and of their alpha. */
export const fidelity = (copy: Rgba, reference: Rgba) => {
  const alphaOf = (image: Rgba) =>
    Array.from({ length: image.data.length / 4 }, (_, pixel) => image.data[pixel * 4 + 3] ?? 0);

  return {
    white: psnr(over(copy, 255), over(reference, 255)),
    black: psnr(over(copy, 0), over(reference, 0)),
    alpha: psnr(alphaOf(copy), alphaOf(reference)),
  };
};

/** `jpeg` with a segment of `marker` holding `payload` right after its start of image. */
export const withSegment = (jpeg: Uint8Array, marker: number, payload: Uint8Array): Uint8Array => {
  const length = Buffer.alloc(2);

  length.writeUInt16BE(payload.length + 2);

  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, marker]),
    length,
    payload,
    jpeg.subarray(2),
  ]);
};

/** A JPEG segment of `marker` holding `payload`. */
export const jpegSegment = (marker: number, payload: Uint8Array): Uint8Array => {
  const length = Buffer.alloc(2);

  length.writeUInt16BE(payload.length + 2);

  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
};

/** `jpeg` with `bytes` before its end of image, after its last scan. */
export const beforeJpegEnd = (jpeg: Uint8Array, bytes: Uint8Array): Uint8Array =>
  Buffer.concat([jpeg.subarray(0, jpeg.length - 2), bytes, jpeg.subarray(jpeg.length - 2)]);

/** A progressive `jpeg` with `bytes` before its second scan. */
export const beforeSecondScan = (jpeg: Uint8Array, bytes: Uint8Array): Uint8Array => {
  const scan = Buffer.from([0xff, 0xda]);
  const second = Buffer.from(jpeg).indexOf(scan, Buffer.from(jpeg).indexOf(scan) + 2);

  return Buffer.concat([jpeg.subarray(0, second), bytes, jpeg.subarray(second)]);
};

/** An ICC_PROFILE APP2 payload holding all of `profile` in one segment. */
export const iccSegment = (profile: Uint8Array): Uint8Array =>
  Buffer.concat([Buffer.from("ICC_PROFILE\0", "latin1"), Buffer.from([1, 1]), profile]);

/** An APP1 payload of EXIF whose first IFD holds just `orientation`. */
export const exifOrientation = (orientation: number): Uint8Array => {
  const tiff = Buffer.alloc(26);

  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22);

  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
};

/** An APP14 payload of Adobe's segment with colour `transform` (0 RGB, 1 YCbCr, 2 YCCK). */
export const adobeSegment = (transform: number): Uint8Array =>
  Buffer.concat([Buffer.from("Adobe", "latin1"), Buffer.from([0, 100, 0, 0, 0, 0, transform])]);

/** The segments before a JPEG's image data, each as its marker and payload. */
const segmentsOf = (jpeg: Uint8Array) => {
  const segments: Array<{ readonly marker: number; readonly payload: Uint8Array }> = [];
  let offset = 2;

  while (offset + 4 <= jpeg.length && jpeg[offset + 1] !== 0xda) {
    const length = ((jpeg[offset + 2] ?? 0) << 8) + (jpeg[offset + 3] ?? 0);

    segments.push({
      marker: jpeg[offset + 1] ?? 0,
      payload: jpeg.subarray(offset + 4, offset + 2 + length),
    });
    offset += 2 + length;
  }

  return segments;
};

/** The ICC profile a JPEG carries, joined from its `ICC_PROFILE` segments. */
export const jpegProfile = (jpeg: Uint8Array): Buffer =>
  Buffer.concat(
    segmentsOf(jpeg)
      .filter(
        ({ marker, payload }) =>
          marker === 0xe2 &&
          Buffer.from(payload.subarray(0, 12)).toString("latin1") === "ICC_PROFILE\0",
      )
      .map(({ payload }) => Buffer.from(payload.subarray(14))),
  );

/** How many colour components a JPEG's frame has. */
export const jpegComponents = (jpeg: Uint8Array): number | undefined =>
  segmentsOf(jpeg).find(({ marker }) => marker >= 0xc0 && marker <= 0xc2)?.payload[5];

/** A PNG chunk of `type` holding `data`, with its CRC. */
export const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const chunk = Buffer.alloc(12 + data.length);

  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);

  return chunk;
};

/** `png` with `chunks` right after its header chunk. */
export const withChunks = (png: Uint8Array, chunks: ReadonlyArray<Uint8Array>): Uint8Array =>
  Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);

/** `png` with `chunks` after its image data, before its `IEND`. */
export const beforePngEnd = (png: Uint8Array, chunks: ReadonlyArray<Uint8Array>): Uint8Array =>
  Buffer.concat([png.subarray(0, png.length - 12), ...chunks, png.subarray(png.length - 12)]);

/** The types of a PNG's chunks, in order. */
export const pngChunkTypes = (png: Uint8Array): ReadonlyArray<string> => {
  const types: Array<string> = [];
  const view = Buffer.from(png);

  for (let offset = 8; offset + 8 <= png.length; offset += 12 + view.readUInt32BE(offset)) {
    types.push(view.toString("latin1", offset + 4, offset + 8));
  }

  return types;
};

/** Big-endian 32-bit words, as PNG chunks hold numbers. */
const words = (...values: ReadonlyArray<number>) => {
  const bytes = Buffer.alloc(4 * values.length);

  values.forEach((value, index) => bytes.writeUInt32BE(value, 4 * index));

  return bytes;
};

/** The chunks libpng writes for an sRGB image: `sRGB`, and `gAMA` and `cHRM` matching it. */
export const SRGB_CHUNKS: ReadonlyArray<Uint8Array> = [
  pngChunk("sRGB", Uint8Array.of(0)),
  pngChunk("gAMA", words(45455)),
  pngChunk("cHRM", words(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)),
];
