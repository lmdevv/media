/**
 * The levels of HEVC and AV1 an encode is held to, as data. A level limits the coded picture, its
 * sides, the luma samples a second (the picture times the frame rate), the bitrate, and for HEVC
 * the decoder's buffer; for AV1 also the pictures a second. Levels go by ffprobe's units, which is
 * how clients declare the highest level they decode: HEVC's `general_level_idc` (30 times the
 * level) and AV1's `seq_level_idx`. H.264 has no table: its encodes keep what the client's size
 * allows. Values are the Main tier's, from the HEVC specification's Table A.8 and the AV1
 * specification's Annex A.3; HEVC's bitrate and buffer use the VCL factor, the stricter one.
 */
import type { OutputCodec } from "./video-ops.ts";

/** What one level allows. */
export interface Level {
  /** The level in ffprobe's units. */
  readonly idc: number;
  /** The level times ten, as encoders that take a level by name read it: 41 for 4.1. */
  readonly tenths: number;
  /** Luma samples in one coded picture. */
  readonly maxPicture: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Luma samples a second. */
  readonly maxSampleRate: number;
  /** Bits a second. */
  readonly maxBitrate: number;
  /** Bits the decoder buffers; none where the level sets no buffer. */
  readonly maxBuffer: number | undefined;
  /** Pictures a second; none where the sample rate alone limits them. */
  readonly maxFrameRate: number | undefined;
}

/** An HEVC level: its sides are each at most the square root of eight pictures' samples. */
const hevc = (
  idc: number,
  maxPicture: number,
  maxSampleRate: number,
  maxBitrate: number,
  maxBuffer: number,
): Level => {
  const side = Math.floor(Math.sqrt(maxPicture * 8));

  return {
    idc,
    tenths: idc / 3,
    maxPicture,
    maxWidth: side,
    maxHeight: side,
    maxSampleRate,
    maxBitrate,
    maxBuffer,
    maxFrameRate: undefined,
  };
};

/** An AV1 level: `megabits` is the Main tier's bitrate, `headers` its frame headers a second. */
const av1 = (
  idc: number,
  tenths: number,
  maxPicture: number,
  [maxWidth, maxHeight]: readonly [number, number],
  maxSampleRate: number,
  megabits: number,
  headers: number,
): Level => ({
  idc,
  tenths,
  maxPicture,
  maxWidth,
  maxHeight,
  maxSampleRate,
  maxBitrate: megabits * 1_000_000,
  maxBuffer: undefined,
  maxFrameRate: headers,
});

const HEVC_LEVELS: ReadonlyArray<Level> = [
  hevc(30, 36_864, 552_960, 128_000, 350_000),
  hevc(60, 122_880, 3_686_400, 1_500_000, 1_500_000),
  hevc(63, 245_760, 7_372_800, 3_000_000, 3_000_000),
  hevc(90, 552_960, 16_588_800, 6_000_000, 6_000_000),
  hevc(93, 983_040, 33_177_600, 10_000_000, 10_000_000),
  hevc(120, 2_228_224, 66_846_720, 12_000_000, 12_000_000),
  hevc(123, 2_228_224, 133_693_440, 20_000_000, 20_000_000),
  hevc(150, 8_912_896, 267_386_880, 25_000_000, 25_000_000),
  hevc(153, 8_912_896, 534_773_760, 40_000_000, 40_000_000),
  hevc(156, 8_912_896, 1_069_547_520, 60_000_000, 60_000_000),
  hevc(180, 35_651_584, 1_069_547_520, 60_000_000, 60_000_000),
  hevc(183, 35_651_584, 2_139_095_040, 120_000_000, 120_000_000),
  hevc(186, 35_651_584, 4_278_190_080, 240_000_000, 240_000_000),
];

/** AV1's defined levels; the indices between them (2.2, 2.3, 3.2, 3.3, 4.2, 4.3) are reserved. */
const AV1_LEVELS: ReadonlyArray<Level> = [
  av1(0, 20, 147_456, [2048, 1152], 4_423_680, 1.5, 150),
  av1(1, 21, 278_784, [2816, 1584], 8_363_520, 3, 150),
  av1(4, 30, 665_856, [4352, 2448], 19_975_680, 6, 150),
  av1(5, 31, 1_065_024, [5504, 3096], 31_950_720, 10, 150),
  av1(8, 40, 2_359_296, [6144, 3456], 70_778_880, 12, 300),
  av1(9, 41, 2_359_296, [6144, 3456], 141_557_760, 20, 300),
  av1(12, 50, 8_912_896, [8192, 4352], 267_386_880, 30, 300),
  av1(13, 51, 8_912_896, [8192, 4352], 534_773_760, 40, 300),
  av1(14, 52, 8_912_896, [8192, 4352], 1_069_547_520, 60, 300),
  av1(15, 53, 8_912_896, [8192, 4352], 1_069_547_520, 60, 300),
  av1(16, 60, 35_651_584, [16_384, 8704], 1_069_547_520, 60, 300),
  av1(17, 61, 35_651_584, [16_384, 8704], 2_139_095_040, 100, 300),
  av1(18, 62, 35_651_584, [16_384, 8704], 4_278_190_080, 160, 300),
  av1(19, 63, 35_651_584, [16_384, 8704], 4_278_190_080, 160, 300),
];

/** Each codec's levels, lowest first. */
const LEVELS: Readonly<Partial<Record<OutputCodec, ReadonlyArray<Level>>>> = {
  hevc: HEVC_LEVELS,
  av1: AV1_LEVELS,
};

/**
 * The block a coded picture's sides are whole multiples of, which levels count: HEVC codes its
 * picture in 8x8 blocks and crops the rest (libx265, `hevc_qsv`, and `hevc_vaapi` all code 536x228
 * as 536x232); AV1 codes the picture's own size.
 */
const CODED_BLOCK: Readonly<Partial<Record<OutputCodec, number>>> = { hevc: 8, av1: 1 };

/** The frame rate a source whose rate ffprobe could not read is held to. */
const UNKNOWN_FRAME_RATE = 60;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The highest level of `codec` at or under `declared`; none when no level is that low. */
const levelAtMost = (codec: OutputCodec, declared: number): Level | undefined =>
  (LEVELS[codec] ?? []).findLast((level) => level.idc <= declared);

/** The highest level of `codec` the table lists, in ffprobe's units; none without a table. */
export const highestLevel = (codec: OutputCodec): number | undefined => LEVELS[codec]?.at(-1)?.idc;

/** The level in ffprobe's units `idc` of `codec`, as listed. */
export const levelOf = (codec: OutputCodec, idc: number): Level | undefined =>
  (LEVELS[codec] ?? []).find((level) => level.idc === idc);

const codedSamples = (codec: OutputCodec, size: Size): number => {
  const block = CODED_BLOCK[codec] ?? 1;
  const coded = (side: number) => Math.ceil(side / block) * block;

  return coded(size.width) * coded(size.height);
};

/** Whether `level` holds pictures of `size` at `frameRate`, before the bitrate. */
const holdsPicture = (codec: OutputCodec, level: Level, size: Size, frameRate: number): boolean => {
  const samples = codedSamples(codec, size);

  return (
    size.width <= level.maxWidth &&
    size.height <= level.maxHeight &&
    samples <= level.maxPicture &&
    samples * frameRate <= level.maxSampleRate &&
    (level.maxFrameRate === undefined || frameRate <= level.maxFrameRate)
  );
};

/**
 * The highest bitrate `level` holds. Every encode row buffers twice its bitrate (`-bufsize`), and
 * Quick Sync raises the level it writes to fit that buffer, so the buffer must fit too.
 */
const bitrateCap = (level: Level): number =>
  Math.min(
    level.maxBitrate,
    level.maxBuffer === undefined ? Number.POSITIVE_INFINITY : level.maxBuffer / 2,
  );

/** What a declared level allows an encode, found by `fitLevel`. */
export interface LevelFit {
  /** The picture, `size` itself or smaller at its aspect. */
  readonly size: Size;
  /** The highest bitrate the level holds; none when nothing was declared. */
  readonly maxBitrate: number | undefined;
}

/**
 * The largest picture, at most `size` and at its aspect in even sides, that the level `declared`
 * for `codec` holds at the source's `frameRate`, and the bitrate the level holds; `size` alone when
 * nothing was declared or the codec has no table. Undefined when the level holds that frame rate
 * at no size.
 */
export const fitLevel = (
  codec: OutputCodec,
  declared: number | undefined,
  size: Size,
  frameRate: number | undefined,
): LevelFit | undefined => {
  if (declared === undefined || LEVELS[codec] === undefined) {
    return { size, maxBitrate: undefined };
  }

  const level = levelAtMost(codec, declared);

  if (level === undefined) return undefined;
  const rate = frameRate ?? UNKNOWN_FRAME_RATE;
  const pictures = Math.min(level.maxPicture, level.maxSampleRate / rate);

  const scale = Math.min(
    1,
    level.maxWidth / size.width,
    level.maxHeight / size.height,
    Math.sqrt(pictures / (size.width * size.height)),
  );

  // Rounding the sides up to whole blocks can push the coded picture over: step down two rows at
  // a time until it fits.
  for (let height = Math.floor((size.height * scale) / 2) * 2; height >= 2; height -= 2) {
    const width = Math.max(2, Math.floor((size.width * (height / size.height)) / 2) * 2);
    const fitted = { width, height };

    if (holdsPicture(codec, level, fitted, rate)) {
      return { size: fitted, maxBitrate: bitrateCap(level) };
    }
  }

  return undefined;
};

/**
 * The lowest level of `codec` that holds an encode of `size` at `frameRate` and `bitrate`, in
 * ffprobe's units: what the encode states, as encoders disagree on the level they would write.
 * None when nothing was declared, so the encoder states its own.
 */
export const statedLevel = (
  codec: OutputCodec,
  declared: number | undefined,
  size: Size,
  frameRate: number | undefined,
  bitrate: number,
): number | undefined =>
  declared === undefined
    ? undefined
    : (LEVELS[codec] ?? []).find(
        (level) =>
          holdsPicture(codec, level, size, frameRate ?? UNKNOWN_FRAME_RATE) &&
          bitrate <= bitrateCap(level),
      )?.idc;
