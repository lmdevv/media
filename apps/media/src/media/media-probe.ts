import { extname } from "node:path";

import { BITMAP_SUBTITLE_FORMATS, Container, DynamicRange } from "@media/contracts/media-playback";
import { DolbyVision, FieldOrder, VideoColour } from "@media/contracts/models/catalog";
import { Effect, Schema, type Types } from "effect";

import * as MediaTools from "./media-tools.ts";

/**
 * Which revision of this reader a probe comes from. A probe stored by an older one lacks what this
 * one reads (field order; the peak frame rate, where it kept the average; the colour, HDR static
 * metadata, HDR10+, and the Dolby Vision configuration), so a scan reads its file again even when
 * the file is unchanged.
 */
export const PROBE_REVISION = 3;

/** The main video stream of a file. */
export const VideoStream = Schema.Struct({
  /** ffmpeg stream index within the file. */
  index: Schema.Int,
  /** ffmpeg codec name, such as `h264`, `hevc`, or `av1`. */
  codec: Schema.String,
  /** Codec profile as ffprobe reports it, such as `High` or `Main 10`. */
  profile: Schema.optional(Schema.String),
  /** Codec level as ffprobe reports it: 41 for H.264 4.1, 153 for HEVC 5.1. */
  level: Schema.optional(Schema.Int),
  pixelFormat: Schema.optional(Schema.String),
  bitDepth: Schema.Int,
  width: Schema.Int,
  height: Schema.Int,
  /**
   * The most frames a second ffprobe reports for the stream (`peakFrameRateOf`), which a level an
   * encode states must hold.
   */
  frameRate: Schema.optional(Schema.Finite),
  dynamicRange: DynamicRange,
  /**
   * How the stream says its pictures are scanned: what the container says, else what the decoder
   * reads from the first pictures. Absent in a probe stored before field orders were read, which
   * the next scan replaces.
   */
  fieldOrder: Schema.optional(FieldOrder),
  /**
   * The stream's colour: transfer, primaries, matrix, range, chroma siting, and HDR10 static
   * metadata, from the container and the first picture. Absent in a probe stored before colours
   * were read, which the next scan replaces.
   */
  colour: Schema.optional(VideoColour),
  /**
   * HDR10+: the first picture carries SMPTE 2094-40 dynamic metadata over an HDR10 stream, which
   * `dynamicRange` names `hdr10`.
   */
  hdr10Plus: Schema.optional(Schema.Literal(true)),
  /** A Dolby Vision stream's profile, level, and base layer compatibility id. */
  dolbyVision: Schema.optional(DolbyVision),
});

/** The main video stream of a file. */
export interface VideoStream extends Schema.Schema.Type<typeof VideoStream> {}

/** One audio track. */
export const AudioTrack = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  profile: Schema.optional(Schema.String),
  channels: Schema.Int,
  channelLayout: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Int),
  /** ISO 639-2 code as tagged in the file, such as `eng`. */
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  default: Schema.Boolean,
  /** Where the track's last packet ends on the file's timeline, in seconds, when the file says. */
  endSeconds: Schema.optional(Schema.Finite),
});

/** One audio track. */
export interface AudioTrack extends Schema.Schema.Type<typeof AudioTrack> {}

const SubtitleKind = Schema.Literals(["text", "bitmap"]);

const EmbeddedSubtitle = Schema.Struct({
  index: Schema.Int,
  codec: Schema.String,
  kind: SubtitleKind,
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  default: Schema.Boolean,
  forced: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
});

interface EmbeddedSubtitle extends Schema.Schema.Type<typeof EmbeddedSubtitle> {}

const MediaChapter = Schema.Struct({
  startSeconds: Schema.Finite,
  endSeconds: Schema.Finite,
  title: Schema.optional(Schema.String),
});

interface MediaChapter extends Schema.Schema.Type<typeof MediaChapter> {}

/** What ffprobe found in a media file. */
export const MediaProbe = Schema.Struct({
  container: Container,
  /** ffprobe's `format_name`, such as `matroska,webm`. */
  formatName: Schema.String,
  /** Playable length in seconds; 0 when the container does not say. */
  durationSeconds: Schema.Finite,
  /** Timestamp of the first frame in seconds; usually 0. */
  startSeconds: Schema.Finite,
  bitRate: Schema.optional(Schema.Int),
  video: Schema.optional(VideoStream),
  audio: Schema.Array(AudioTrack),
  subtitles: Schema.Array(EmbeddedSubtitle),
  /** Chapters in start order, measured from the first frame; empty when the file has none. */
  chapters: Schema.Array(MediaChapter),
});

/** What ffprobe found in a media file. */
export interface MediaProbe extends Schema.Schema.Type<typeof MediaProbe> {}

class MediaProbeInvalid extends Schema.TaggedError<
  MediaProbeInvalid,
  { readonly brand: unique symbol }
>()("MediaProbeInvalid", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Media probe invalid: ffprobe output did not describe a media file";
  }
}

const Disposition = Schema.Struct({
  default: Schema.optionalKey(Schema.Int),
  forced: Schema.optionalKey(Schema.Int),
  hearing_impaired: Schema.optionalKey(Schema.Int),
  attached_pic: Schema.optionalKey(Schema.Int),
});

const Tags = Schema.Struct({
  language: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  /** Matroska's per-track length, such as `00:21:43.008000000`. */
  DURATION: Schema.optionalKey(Schema.String),
});

/**
 * One item of a stream's or a frame's side data: its type, and the fields this reader takes from
 * the mastering display, content light level, and Dolby Vision configuration items.
 */
const SideData = Schema.Struct({
  side_data_type: Schema.optionalKey(Schema.String),
  min_luminance: Schema.optionalKey(Schema.String),
  max_luminance: Schema.optionalKey(Schema.String),
  max_content: Schema.optionalKey(Schema.Int),
  max_average: Schema.optionalKey(Schema.Int),
  dv_profile: Schema.optionalKey(Schema.Int),
  dv_level: Schema.optionalKey(Schema.Int),
  dv_bl_signal_compatibility_id: Schema.optionalKey(Schema.Int),
});

type SideData = typeof SideData.Type;

/** The first decoded picture of a stream, as `-read_intervals %+#1` reads it. */
const FfprobeFrame = Schema.Struct({
  stream_index: Schema.optionalKey(Schema.Int),
  color_transfer: Schema.optionalKey(Schema.String),
  color_primaries: Schema.optionalKey(Schema.String),
  color_space: Schema.optionalKey(Schema.String),
  color_range: Schema.optionalKey(Schema.String),
  side_data_list: Schema.optionalKey(Schema.Array(SideData)),
});

type FfprobeFrame = typeof FfprobeFrame.Type;

const FfprobeStream = Schema.Struct({
  index: Schema.Int,
  codec_type: Schema.optionalKey(Schema.String),
  codec_name: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Int),
  pix_fmt: Schema.optionalKey(Schema.String),
  bits_per_raw_sample: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Int),
  height: Schema.optionalKey(Schema.Int),
  avg_frame_rate: Schema.optionalKey(Schema.String),
  r_frame_rate: Schema.optionalKey(Schema.String),
  color_transfer: Schema.optionalKey(Schema.String),
  color_primaries: Schema.optionalKey(Schema.String),
  color_space: Schema.optionalKey(Schema.String),
  color_range: Schema.optionalKey(Schema.String),
  chroma_location: Schema.optionalKey(Schema.String),
  field_order: Schema.optionalKey(Schema.String),
  side_data_list: Schema.optionalKey(Schema.Array(SideData)),
  channels: Schema.optionalKey(Schema.Int),
  channel_layout: Schema.optionalKey(Schema.String),
  sample_rate: Schema.optionalKey(Schema.String),
  disposition: Schema.optionalKey(Disposition),
  tags: Schema.optionalKey(Tags),
  start_time: Schema.optionalKey(Schema.String),
  duration: Schema.optionalKey(Schema.String),
});

type FfprobeStream = typeof FfprobeStream.Type;

const FfprobeChapter = Schema.Struct({
  start_time: Schema.optionalKey(Schema.String),
  end_time: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Struct({ title: Schema.optionalKey(Schema.String) })),
});

type FfprobeChapter = typeof FfprobeChapter.Type;

const FfprobeOutput = Schema.Struct({
  format: Schema.Struct({
    format_name: Schema.String,
    duration: Schema.optionalKey(Schema.String),
    start_time: Schema.optionalKey(Schema.String),
    bit_rate: Schema.optionalKey(Schema.String),
  }),
  streams: Schema.Array(FfprobeStream),
  chapters: Schema.optionalKey(Schema.Array(FfprobeChapter)),
  frames: Schema.optionalKey(Schema.Array(FfprobeFrame)),
});

const decodeFfprobeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(FfprobeOutput));

const finiteOr = (text: string | undefined, fallback: number): number => {
  const value = text === undefined ? Number.NaN : Number(text);

  return Number.isFinite(value) ? value : fallback;
};

const frameRateOf = (rate: string | undefined): number | undefined => {
  const [numerator = "", denominator = "1"] = (rate ?? "").split("/");
  const value = Number(numerator) / Number(denominator);

  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/** A base rate this fast beside an average this slow counts a timestamp clock, not pictures. */
const CLOCK_RATE = { base: 210, average: 70 } as const;

/** No picture rate in use is faster; a base rate above it counts a timestamp clock at any average. */
const FASTEST_PICTURE_RATE = 240;

/**
 * The most frames a second ffprobe reports for `stream`: the larger of its average
 * (`avg_frame_rate`) and its base rate (`r_frame_rate`, the rate it finds the first pictures'
 * timestamps spaced at, which ffmpeg also gives the encoder). A variable-rate file averages under
 * its fast stretches: one with 4 s at 60 fps then 12 s at 15 fps averages 26.25, with a base rate
 * of 60. Neither reads a fast stretch that starts later (15 fps then 60 reads 15 and 26.25; in
 * Matroska the average repeats the base rate), so such a file is held to its slower rate. A
 * constant-rate stream reports the same rate twice. A base rate that counts a timestamp clock, as
 * 1000 or 2000 for jittered timestamps, leaves the average.
 */
const peakFrameRateOf = (stream: FfprobeStream): number | undefined => {
  const average = frameRateOf(stream.avg_frame_rate);
  const base = frameRateOf(stream.r_frame_rate);

  if (average === undefined || base === undefined) return average ?? base;

  const clock =
    base > FASTEST_PICTURE_RATE || (base > CLOCK_RATE.base && average < CLOCK_RATE.average);

  return clock ? average : Math.max(average, base);
};

const bitDepthOf = (stream: FfprobeStream): number => {
  const raw = finiteOr(stream.bits_per_raw_sample, 0);

  if (raw > 0) return raw;
  const match = /p(\d{2})(?:le|be)$/.exec(stream.pix_fmt ?? "");

  return match?.[1] === undefined ? 8 : Number(match[1]);
};

/** Side data items of `type`, matched as ffprobe names them, in any case. */
const ofKind = (items: ReadonlyArray<SideData>, type: string): SideData | undefined =>
  items.find((item) => (item.side_data_type ?? "").toLowerCase().includes(type));

const dynamicRangeOf = (stream: FfprobeStream, transfer: string | undefined): DynamicRange => {
  if (ofKind(stream.side_data_list ?? [], "dovi") !== undefined) return "dolby-vision";

  if (transfer === "smpte2084") return "hdr10";

  return transfer === "arib-std-b67" ? "hlg" : "sdr";
};

/** A rational ffprobe prints as `num/den`, or a plain number. */
const rationalOf = (text: string | undefined): number | undefined => {
  const [numerator = "", denominator = "1"] = (text ?? "").split("/");
  const value = Number(numerator) / Number(denominator);

  return Number.isFinite(value) ? value : undefined;
};

/** A colour property ffprobe states, without its words for none. */
const stated = (value: string | undefined): string | undefined =>
  value === undefined || value === "unknown" || value === "reserved" ? undefined : value;

const RANGES: ReadonlyMap<string, "limited" | "full"> = new Map([
  ["tv", "limited"],
  ["mpeg", "limited"],
  ["pc", "full"],
  ["jpeg", "full"],
]);

/**
 * The stream's colour, from the stream's own tags and side data and its first picture's, which
 * carry HEVC's mastering display and content light level SEI that MP4 keeps nowhere else. The
 * JPEG-range layouts (`yuvj420p`) are full range whatever the tag says.
 */
const colourOf = (stream: FfprobeStream, frame: FfprobeFrame | undefined): VideoColour => {
  const items = [...(stream.side_data_list ?? []), ...(frame?.side_data_list ?? [])];
  const mastering = ofKind(items, "mastering display");
  const light = ofKind(items, "content light level");
  const minLuminance = rationalOf(mastering?.min_luminance);
  const maxLuminance = rationalOf(mastering?.max_luminance);

  const range = (stream.pix_fmt ?? "").startsWith("yuvj")
    ? "full"
    : RANGES.get(stated(stream.color_range) ?? stated(frame?.color_range) ?? "");

  const transfer = stated(stream.color_transfer) ?? stated(frame?.color_transfer);
  const primaries = stated(stream.color_primaries) ?? stated(frame?.color_primaries);
  const matrix = stated(stream.color_space) ?? stated(frame?.color_space);
  const chromaLocation = stated(stream.chroma_location);
  const colour: Types.Mutable<VideoColour> = {};

  if (transfer !== undefined) colour.transfer = transfer;

  if (primaries !== undefined) colour.primaries = primaries;

  if (matrix !== undefined) colour.matrix = matrix;

  if (range !== undefined) colour.range = range;

  if (chromaLocation !== undefined) colour.chromaLocation = chromaLocation;

  if (minLuminance !== undefined && maxLuminance !== undefined && maxLuminance > 0) {
    colour.mastering = { minLuminance, maxLuminance };
  }

  if (light?.max_content !== undefined && light.max_average !== undefined) {
    colour.contentLight = { maxCll: light.max_content, maxFall: light.max_average };
  }

  return colour;
};

/** The Dolby Vision configuration record in the stream's side data. */
const dolbyVisionOf = (stream: FfprobeStream): DolbyVision | undefined => {
  const record = ofKind(stream.side_data_list ?? [], "dovi configuration");

  return record?.dv_profile === undefined
    ? undefined
    : {
        profile: record.dv_profile,
        level: record.dv_level ?? 0,
        compatibility: record.dv_bl_signal_compatibility_id ?? 0,
      };
};

/**
 * ffprobe's field order as data, the field coded first (`tb`: top coded, bottom shown) taken as
 * the field shown first. Whether a stream is interlaced is reliable; which field comes first is
 * not: ffmpeg's encoders mark top-field-first pictures `tb`, which Matroska keeps, and H.264's
 * parser reads a bottom-field-first stream in MP4 as `tt`. Deinterlacing reads each frame's own
 * flag, which its decoder takes from the picture.
 */
const FIELD_ORDERS: ReadonlyMap<string, FieldOrder> = new Map([
  ["progressive", "progressive"],
  ["tt", "tff"],
  ["tb", "tff"],
  ["bb", "bff"],
  ["bt", "bff"],
]);

const fieldOrderOf = (stream: FfprobeStream): FieldOrder =>
  FIELD_ORDERS.get(stream.field_order ?? "") ?? "unknown";

const containerOf = (formatName: string, path: string): Container => {
  const extension = extname(path).toLowerCase();

  if (formatName.includes("matroska")) return extension === ".webm" ? "webm" : "mkv";

  if (formatName.includes("mp4") || formatName.includes("mov")) {
    return extension === ".mov" ? "mov" : "mp4";
  }

  if (formatName === "avi") return "avi";

  return formatName === "mpegts" ? "ts" : "other";
};

const flag = (value: number | undefined): boolean => value === 1;

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === "" || trimmed === "unknown" ? undefined : trimmed;
};

const toVideo = (
  stream: FfprobeStream,
  frame: FfprobeFrame | undefined,
): VideoStream | undefined => {
  const frameRate = peakFrameRateOf(stream);

  if (stream.width === undefined || stream.height === undefined) return undefined;
  const colour = colourOf(stream, frame);
  const dynamicRange = dynamicRangeOf(stream, colour.transfer);
  const dolbyVision = dolbyVisionOf(stream);

  const hdr10Plus =
    dynamicRange === "hdr10" && ofKind(frame?.side_data_list ?? [], "2094-40") !== undefined;

  return {
    index: stream.index,
    codec: stream.codec_name ?? "unknown",
    profile: nonBlank(stream.profile),
    level: stream.level === undefined || stream.level < 0 ? undefined : stream.level,
    pixelFormat: nonBlank(stream.pix_fmt),
    bitDepth: bitDepthOf(stream),
    width: stream.width,
    height: stream.height,
    frameRate,
    dynamicRange,
    fieldOrder: fieldOrderOf(stream),
    colour,
    hdr10Plus: hdr10Plus ? true : undefined,
    dolbyVision,
  };
};

const clockSeconds = (text: string | undefined): number => {
  const parts = (text ?? "").split(":").map(Number);

  return parts.length === 3 ? parts.reduce((total, part) => total * 60 + part, 0) : Number.NaN;
};

const endOf = (stream: FfprobeStream): number | undefined => {
  const duration = finiteOr(stream.duration, clockSeconds(stream.tags?.DURATION));
  const end = finiteOr(stream.start_time, Number.NaN) + duration;

  return Number.isFinite(end) ? end : undefined;
};

const toAudio = (stream: FfprobeStream): AudioTrack => {
  const sampleRate = finiteOr(stream.sample_rate, 0);

  return {
    index: stream.index,
    codec: stream.codec_name ?? "unknown",
    profile: nonBlank(stream.profile),
    channels: stream.channels ?? 2,
    channelLayout: nonBlank(stream.channel_layout),
    sampleRate: sampleRate > 0 ? sampleRate : undefined,
    language: nonBlank(stream.tags?.language),
    title: nonBlank(stream.tags?.title),
    default: flag(stream.disposition?.default),
    endSeconds: endOf(stream),
  };
};

const toSubtitle = (stream: FfprobeStream): EmbeddedSubtitle => {
  const codec = stream.codec_name ?? "unknown";

  return {
    index: stream.index,
    codec,
    kind: BITMAP_SUBTITLE_FORMATS.has(codec) ? "bitmap" : "text",
    language: nonBlank(stream.tags?.language),
    title: nonBlank(stream.tags?.title),
    default: flag(stream.disposition?.default),
    forced: flag(stream.disposition?.forced),
    hearingImpaired: flag(stream.disposition?.hearing_impaired),
  };
};

/**
 * Chapters as players use them: measured from the first frame, inside the file's length, in start
 * order, and without empty ones (some muxers write a zero-length marker at the end).
 */
const toChapters = (
  chapters: ReadonlyArray<FfprobeChapter>,
  startSeconds: number,
  durationSeconds: number,
): ReadonlyArray<MediaChapter> =>
  chapters
    .flatMap((chapter) => {
      const start = finiteOr(chapter.start_time, Number.NaN) - startSeconds;
      const end = finiteOr(chapter.end_time, Number.NaN) - startSeconds;
      const limit = durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;

      if (!Number.isFinite(start) || !Number.isFinite(end)) return [];

      const startSecondsInFile = Math.min(limit, Math.max(0, start));
      const endSecondsInFile = Math.min(limit, Math.max(startSecondsInFile, end));

      return endSecondsInFile > startSecondsInFile
        ? [
            {
              startSeconds: startSecondsInFile,
              endSeconds: endSecondsInFile,
              title: nonBlank(chapter.tags?.title),
            },
          ]
        : [];
    })
    .toSorted((left, right) => left.startSeconds - right.startSeconds);

/**
 * Translates ffprobe's `-show_format -show_streams -show_chapters` JSON for the file at `path`, with
 * its first pictures' colour and side data (`FRAME_ENTRIES`), into a `MediaProbe`. Cover art stored
 * as a video stream is ignored.
 */
export const parseFfprobeJson = Effect.fn("MediaProbe.parse")(function* (
  json: string,
  path: string,
) {
  const output = yield* decodeFfprobeOutput(json).pipe(
    Effect.mapError((cause) => new MediaProbeInvalid({ cause })),
  );

  const ofType = (type: string) => output.streams.filter((stream) => stream.codec_type === type);

  const video = ofType("video")
    .filter((stream) => !flag(stream.disposition?.attached_pic))
    .map((stream) =>
      toVideo(
        stream,
        output.frames?.find((frame) => frame.stream_index === stream.index),
      ),
    )
    .find((stream) => stream !== undefined);

  const bitRate = Math.trunc(finiteOr(output.format.bit_rate, 0));
  const durationSeconds = finiteOr(output.format.duration, 0);
  const startSeconds = finiteOr(output.format.start_time, 0);

  const probe: MediaProbe = {
    container: containerOf(output.format.format_name, path),
    formatName: output.format.format_name,
    durationSeconds,
    startSeconds,
    bitRate: bitRate > 0 ? bitRate : undefined,
    video,
    audio: ofType("audio").map(toAudio),
    subtitles: ofType("subtitle").map(toSubtitle),
    chapters: toChapters(output.chapters ?? [], startSeconds, durationSeconds),
  };

  return probe;
});

/**
 * What the probe reads from each stream's first decoded picture (`-read_intervals %+#1`): its colour
 * tags, and the types and values of the side data the colour needs, since HEVC carries mastering
 * display, content light level, and HDR10+ metadata in SEI messages that MP4 keeps nowhere else.
 */
const FRAME_ENTRIES = [
  "frame=stream_index,color_range,color_space,color_primaries,color_transfer",
  "frame_side_data=side_data_type,min_luminance,max_luminance,max_content,max_average",
].join(":");

/** Probes the file at `path` with ffprobe. */
export const probeFile = Effect.fn("MediaProbe.probeFile")(function* (path: string) {
  const tools = yield* MediaTools.Service;

  const json = yield* tools.ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    FRAME_ENTRIES,
    path,
  ]);

  return yield* parseFfprobeJson(json, path);
});
