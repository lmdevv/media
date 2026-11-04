import { extname } from "node:path";

import { BITMAP_SUBTITLE_FORMATS, Container, DynamicRange } from "@media/contracts/media-playback";
import { Effect, Schema } from "effect";

import * as MediaTools from "./media-tools.ts";

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
  frameRate: Schema.optional(Schema.Finite),
  dynamicRange: DynamicRange,
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

class MediaProbeInvalid extends Schema.TaggedError<MediaProbeInvalid>()("MediaProbeInvalid", {
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
  side_data_list: Schema.optionalKey(
    Schema.Array(Schema.Struct({ side_data_type: Schema.optionalKey(Schema.String) })),
  ),
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

const bitDepthOf = (stream: FfprobeStream): number => {
  const raw = finiteOr(stream.bits_per_raw_sample, 0);

  if (raw > 0) return raw;
  const match = /p(\d{2})(?:le|be)$/.exec(stream.pix_fmt ?? "");

  return match?.[1] === undefined ? 8 : Number(match[1]);
};

const dynamicRangeOf = (stream: FfprobeStream): DynamicRange => {
  const dolbyVision = (stream.side_data_list ?? []).some((data) =>
    (data.side_data_type ?? "").toLowerCase().includes("dovi"),
  );

  if (dolbyVision) return "dolby-vision";

  if (stream.color_transfer === "smpte2084") return "hdr10";

  return stream.color_transfer === "arib-std-b67" ? "hlg" : "sdr";
};

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

const toVideo = (stream: FfprobeStream): VideoStream | undefined => {
  const frameRate = frameRateOf(stream.avg_frame_rate) ?? frameRateOf(stream.r_frame_rate);

  if (stream.width === undefined || stream.height === undefined) return undefined;

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
    dynamicRange: dynamicRangeOf(stream),
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
 * Translates ffprobe's `-show_format -show_streams -show_chapters` JSON for the file at `path` into a
 * `MediaProbe`. Cover art stored as a video stream is ignored.
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
    .map(toVideo)
    .find((stream) => stream !== undefined);

  const bitRate = Math.trunc(finiteOr(output.format.bit_rate, 0));
  const durationSeconds = finiteOr(output.format.duration, 0);
  const startSeconds = finiteOr(output.format.start_time, 0);

  return {
    container: containerOf(output.format.format_name, path),
    formatName: output.format.format_name,
    durationSeconds,
    startSeconds,
    bitRate: bitRate > 0 ? bitRate : undefined,
    video,
    audio: ofType("audio").map(toAudio),
    subtitles: ofType("subtitle").map(toSubtitle),
    chapters: toChapters(output.chapters ?? [], startSeconds, durationSeconds),
  } satisfies MediaProbe;
});

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
    path,
  ]);

  return yield* parseFfprobeJson(json, path);
});
