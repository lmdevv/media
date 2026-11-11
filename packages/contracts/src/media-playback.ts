/**
 * The media service's playback API as data: routes, requests, responses, and the tagged errors it
 * answers with. `@media/contracts/media-api` builds the media service's HttpApi from these, and
 * clients decode the same schemas, so both sides share one definition. Only stable Effect modules
 * are used here, so browser bundles and the SDK can import it.
 *
 * Errors travel as JSON bodies encoded with their schema, such as
 * `{"_tag":"StreamGenerationGone","streamId":"…","generation":1,"currentGeneration":2}`, with the
 * status in each error's `httpApiStatus` annotation.
 */
import { Schema } from "effect";

import { PlaybackSessionId } from "./ids";
import { PlaybackMode } from "./models/playback";
import { PlaybackTokenInvalid } from "./playback-token";

/** Paths of the playback API, relative to the media service's base URL. */
export const MEDIA_ROUTES = {
  negotiate: "/api/playback/negotiate",
  seek: "/api/playback/seek",
  stop: "/api/playback/stop",
  prepareDownload: "/api/downloads/prepare",
  health: "/api/health",
  clientConfig: "/api/client-config",
} as const;

/**
 * Random identifier of one HLS stream that a media service process owns. It is never stored, so a
 * restarted service answers identifiers it handed out before with `StreamNotFound`.
 */
export const StreamId = Schema.String.check(Schema.isPattern(/^[\w-]{22}$/u)).pipe(
  Schema.brand("StreamId"),
);

/** Random identifier of one HLS stream. */
export type StreamId = typeof StreamId.Type;

/** Dynamic range of a video stream as negotiation sees it. */
export const DynamicRange = Schema.Literals(["sdr", "hdr10", "hlg", "dolby-vision"]);

/** Dynamic range of a video stream. */
export type DynamicRange = typeof DynamicRange.Type;

/** Container families negotiation distinguishes. */
export const Container = Schema.Literals(["mp4", "mov", "mkv", "webm", "avi", "ts", "other"]);

/** Container families negotiation distinguishes. */
export type Container = typeof Container.Type;

/** A video codec the client decodes, with optional limits. Names follow ffmpeg (`h264`, `hevc`, `av1`, `vp9`). */
const VideoCodecSupport = Schema.Struct({
  codec: Schema.String,
  /** Accepted ffprobe profile names, such as `High` or `Main 10`; absent accepts any profile. */
  profiles: Schema.optional(Schema.Array(Schema.String)),
  /** Highest level in ffprobe units (41 for H.264 4.1, 153 for HEVC 5.1); absent accepts any level. */
  maxLevel: Schema.optional(Schema.Int),
  /** Highest bit depth; 8 when absent. */
  maxBitDepth: Schema.optional(Schema.Int),
  /** HDR formats the client decodes and displays; SDR is always accepted. */
  dynamicRanges: Schema.optional(Schema.Array(DynamicRange)),
});

/** An audio codec the client decodes. Names follow ffmpeg (`aac`, `ac3`, `eac3`, `opus`, `flac`, `mp3`). */
const AudioCodecSupport = Schema.Struct({
  codec: Schema.String,
  /** Most channels the client plays; 8 when absent. */
  maxChannels: Schema.optional(Schema.Int),
});

/** What a client can play. Browser checks are hints; a failed direct path renegotiates. */
export const ClientCapabilities = Schema.Struct({
  /** Containers the client plays progressively over byte ranges. */
  containers: Schema.Array(Container),
  videoCodecs: Schema.Array(VideoCodecSupport),
  audioCodecs: Schema.Array(AudioCodecSupport),
  maxWidth: Schema.Int,
  maxHeight: Schema.Int,
  /** Plays HLS natively (Safari, TVs). */
  hls: Schema.Boolean,
  /** Has Media Source Extensions, so a script player (hls.js) can play fMP4 HLS. */
  mse: Schema.Boolean,
});

/** What a client can play. */
export interface ClientCapabilities extends Schema.Schema.Type<typeof ClientCapabilities> {}

/** One subtitle track a client can choose. */
/**
 * Subtitle codecs that are pictures rather than text, by ffmpeg codec name, with the names
 * players usually give them. The media service marks these `bitmap` (they are burned in); the web
 * app shows the name next to the language.
 */
export const BITMAP_SUBTITLE_FORMATS = new Map([
  ["hdmv_pgs_subtitle", "PGS"],
  ["dvd_subtitle", "VobSub"],
  ["dvb_subtitle", "DVB"],
  ["xsub", "XSUB"],
]);

export const SubtitleTrack = Schema.Struct({
  /** Stable ID within the file: `e<stream index>` for embedded tracks, `x` and a hash of the file name for sidecar files. */
  id: Schema.String,
  source: Schema.Literals(["embedded", "sidecar"]),
  /** ffmpeg codec name or sidecar extension, such as `subrip`, `ass`, or `hdmv_pgs_subtitle`. */
  codec: Schema.String,
  kind: Schema.Literals(["text", "bitmap"]),
  language: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  forced: Schema.Boolean,
  default: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
});

/** One subtitle track a client can choose. */
export interface SubtitleTrack extends Schema.Schema.Type<typeof SubtitleTrack> {}

/**
 * A subtitle track with its WebVTT URL. Bitmap tracks (PGS, VobSub) have none: the client shows
 * one by negotiating again with `burnInSubtitle`, and the service draws it into the video.
 */
const NegotiatedSubtitle = Schema.Struct({
  ...SubtitleTrack.fields,
  /** WebVTT URL with the playback token; absent for bitmap tracks. */
  url: Schema.optional(Schema.String),
});

/**
 * The most a viewer wants to receive, such as 720p on a slow connection. A source above it is
 * transcoded down; without it the service sends the best the client can play.
 */
export const PlaybackQuality = Schema.Struct({
  /** Tallest picture, in lines, such as 1080, 720, or 480. */
  maxHeight: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  /** Highest bitrate in bits per second, for the whole stream. */
  maxBitrate: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

/** The most a viewer wants to receive. */
export interface PlaybackQuality extends Schema.Schema.Type<typeof PlaybackQuality> {}

/** A negotiation request. */
export const NegotiateRequest = Schema.Struct({
  /** The playback token Convex issued for this file and device session. */
  token: Schema.Redacted(Schema.String),
  capabilities: ClientCapabilities,
  /** ffmpeg stream index of the audio track to play; the default track when absent. */
  audioStreamIndex: Schema.optional(Schema.Int),
  /** Where playback starts, in seconds from the beginning. */
  startSeconds: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** A quality cap; the best the client can play when absent. */
  quality: Schema.optional(PlaybackQuality),
  /** ID of a bitmap subtitle track to draw into the video, which then always transcodes. */
  burnInSubtitle: Schema.optional(Schema.String),
});

/** A negotiation request. */
export interface NegotiateRequest extends Schema.Schema.Type<typeof NegotiateRequest> {}

/** The negotiated playback. */
export const NegotiateResponse = Schema.Struct({
  mode: PlaybackMode,
  /** The direct file URL (byte ranges) or the HLS playlist URL, with the playback token. */
  url: Schema.String,
  /** HLS only: the stream and generation the playlist belongs to. */
  streamId: Schema.optional(StreamId),
  generation: Schema.optional(Schema.Int),
  /** Where playback should start; HLS streams start producing here. */
  startSeconds: Schema.Finite,
  durationSeconds: Schema.Finite,
  /** The video as the device receives it, after any transcode. */
  video: Schema.Struct({
    codec: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
    dynamicRange: DynamicRange,
  }),
  audio: Schema.optional(
    Schema.Struct({ streamIndex: Schema.Int, codec: Schema.String, channels: Schema.Int }),
  ),
  subtitles: Schema.Array(NegotiatedSubtitle),
  /** The bitmap subtitle track drawn into the video, when one was asked for. */
  burnedInSubtitle: Schema.optional(Schema.String),
  /** Token expiry in milliseconds since the epoch; renew the token and renegotiate before it. */
  expiresAt: Schema.Finite,
});

/** The negotiated playback. */
export interface NegotiateResponse extends Schema.Schema.Type<typeof NegotiateResponse> {}

/** A request that moves an HLS stream to another position. */
export const SeekRequest = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  streamId: StreamId,
  positionSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Where the stream continues: the generation to load and its playlist. */
export const SeekResponse = Schema.Struct({
  streamId: StreamId,
  generation: Schema.Int,
  playlistUrl: Schema.String,
});

/** Where an HLS stream continues after a seek. */
export interface SeekResponse extends Schema.Schema.Type<typeof SeekResponse> {}

/** A request that ends an HLS stream and deletes its temporary output. */
export const StopRequest = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  streamId: StreamId,
});

/**
 * A `StopRequest` as a JSON string, the body of a stop sent as `text/plain`. A page going away
 * sends its stop this way: it needs no CORS preflight, which a browser does not send from
 * `pagehide`.
 */
export const StopRequestText = Schema.fromJsonString(Schema.toCodecJson(StopRequest));

/**
 * How large a download may be: `standard` caps it at 720p and 4 Mb/s, `high` at 1080p and
 * 10 Mb/s (the players' 720p and 1080p presets). A source within the cap downloads as it is.
 */
export const DownloadQuality = Schema.Literals(["standard", "high"]);

/** How large a download may be. */
export type DownloadQuality = typeof DownloadQuality.Type;

/** A request to make a download session's file ready to fetch. Repeat it to follow progress. */
export const PrepareDownloadRequest = Schema.Struct({
  /** The playback token of the download session (`downloads.start`). */
  token: Schema.Redacted(Schema.String),
  capabilities: ClientCapabilities,
  quality: DownloadQuality,
  /** ffmpeg stream index of the audio track to keep; the default track when absent. */
  audioStreamIndex: Schema.optional(Schema.Int),
});

/** A request to make a download ready. */
export interface PrepareDownloadRequest extends Schema.Schema.Type<typeof PrepareDownloadRequest> {}

/** A text subtitle track to fetch beside a download, as WebVTT. */
const DownloadSubtitle = Schema.Struct({
  ...SubtitleTrack.fields,
  /** WebVTT URL with the playback token. */
  url: Schema.String,
});

/**
 * The media service is still writing the download's MP4: ask again in a few seconds. `progress`
 * runs from 0 to 1; `estimatedBytes` is an upper bound on the finished size.
 */
export const DownloadPreparing = Schema.TaggedStruct("Preparing", {
  progress: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  estimatedBytes: Schema.Finite,
});

/**
 * The download is ready at `url` (with the playback token), which answers byte ranges so a
 * transfer resumes. `direct` is the original file; the other modes are an MP4 the service wrote.
 */
export const DownloadReady = Schema.TaggedStruct("Ready", {
  mode: PlaybackMode,
  url: Schema.String,
  sizeBytes: Schema.Finite,
  /** `mp4` or `mov`. */
  container: Container,
  durationSeconds: Schema.Finite,
  video: Schema.Struct({
    codec: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
    dynamicRange: DynamicRange,
  }),
  audio: Schema.optional(
    Schema.Struct({ streamIndex: Schema.Int, codec: Schema.String, channels: Schema.Int }),
  ),
  /** Text tracks only: picture subtitles cannot be kept beside a file. */
  subtitles: Schema.Array(DownloadSubtitle),
  /** Token expiry in milliseconds since the epoch; renew the token (`playback.renewToken`) before it. */
  expiresAt: Schema.Finite,
});

/** Where a download stands on the media service. */
export const PrepareDownloadResponse = Schema.Union([DownloadPreparing, DownloadReady]);

/** Where a download stands on the media service. */
export type PrepareDownloadResponse = typeof PrepareDownloadResponse.Type;

/** Service health. */
export const HealthResponse = Schema.Struct({
  status: Schema.Literal("ok"),
  /** Streams whose encoder runs; a paused stream whose encoder stopped is not counted. */
  activeStreams: Schema.Int,
  /**
   * Encoder runs whose ffmpeg has not exited yet, closed streams' runs included. A run that stays
   * here after its stream stopped is stuck, for example on a disk that stopped answering. Servers
   * from before it leave it out, so clients that check an older server still read its health.
   */
  runsAwaitingExit: Schema.optionalKey(Schema.Int),
  hardwareAcceleration: Schema.Literals(["qsv", "vaapi", "none"]),
  /**
   * `connected` while the service is signed in to Convex and Convex answered it within about a
   * minute; `connecting` while it signs in, or while Convex is not answering; `standalone` when it
   * runs without Convex.
   */
  backend: Schema.Literals(["connected", "connecting", "standalone"]),
});

/** Service health. */
export interface HealthResponse extends Schema.Schema.Type<typeof HealthResponse> {}

/**
 * What an app needs to connect when someone types only this service's address: the Convex URL
 * to sign in to, as clients reach it (`CONVEX_PUBLIC_URL`). Absent when none is configured.
 */
export const ClientConfigResponse = Schema.Struct({
  /** The core's public Convex URL, which clients sign in to. */
  convexUrl: Schema.optional(Schema.String),
  /** The movies web client's address, `${MEDIA_BASE_URL}/movies`, for links apps build. */
  moviesUrl: Schema.optional(Schema.String),
});

/** What an app needs to connect from this service's address. */
export interface ClientConfigResponse extends Schema.Schema.Type<typeof ClientConfigResponse> {}

/** Why no rung of the playback ladder fits the client. */
export const UnsupportedReason = Schema.Literals([
  "no-video-stream",
  "audio-track-not-found",
  "no-adaptive-streaming",
  "no-transcode-target",
  "hdr-tone-mapping-requires-hardware",
  "unknown-duration",
  "subtitle-not-burnable",
]);

/** Why no rung of the playback ladder fits the client. */
export type UnsupportedReason = typeof UnsupportedReason.Type;

/** The client cannot play this file in any mode the service offers. Do not retry. */
export class UnsupportedPlayback extends Schema.TaggedError<UnsupportedPlayback>()(
  "UnsupportedPlayback",
  { reason: UnsupportedReason },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    return `Unsupported playback: ${this.reason}`;
  }
}

/** The token's playback session ended. Start a new session with `playback.createSession`. */
export class PlaybackSessionEnded extends Schema.TaggedError<PlaybackSessionEnded>()(
  "PlaybackSessionEnded",
  { sessionId: PlaybackSessionId },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return "Playback session ended: start a new session";
  }
}

/** No stored file has this ID, it is marked missing, or it lies outside the approved folders. */
export class MediaFileNotFound extends Schema.TaggedError<MediaFileNotFound>()(
  "MediaFileNotFound",
  { fileId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Media file not found: ${this.fileId}`;
  }
}

/** The media service cannot reach its file records right now. Retry shortly. */
export class FileResolverUnavailable extends Schema.TaggedError<FileResolverUnavailable>()(
  "FileResolverUnavailable",
  { cause: Schema.Defect() },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return "File resolver unavailable: the file store did not answer";
  }
}

/** The file's keyframes could not be read, so its HLS segments cannot be planned. */
export class KeyframeIndexFailed extends Schema.TaggedError<KeyframeIndexFailed>()(
  "KeyframeIndexFailed",
  { fileId: Schema.String, cause: Schema.Defect() },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Keyframe index failed for file ${this.fileId}`;
  }
}

/** The stream ID is unknown, for example after a restart. Renegotiate to get a new one. */
export class StreamNotFound extends Schema.TaggedError<StreamNotFound>()(
  "StreamNotFound",
  { streamId: Schema.String },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "Stream not found: renegotiate playback";
  }
}

/** The request names an old generation; load the current generation's playlist instead. */
export class StreamGenerationGone extends Schema.TaggedError<StreamGenerationGone>()(
  "StreamGenerationGone",
  { streamId: Schema.String, generation: Schema.Int, currentGeneration: Schema.Int },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return `Stream generation gone: ${this.generation} was replaced by ${this.currentGeneration}`;
  }
}

/** The token belongs to another playback session or file. */
export class StreamAccessDenied extends Schema.TaggedError<StreamAccessDenied>()(
  "StreamAccessDenied",
  { streamId: Schema.String },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Stream access denied: the token does not match this stream";
  }
}

/** All transcode slots are busy. Retry later. */
export class TranscodeCapacityReached extends Schema.TaggedError<TranscodeCapacityReached>()(
  "TranscodeCapacityReached",
  { limit: Schema.Int },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Transcode capacity reached: ${this.limit} transcodes are running`;
  }
}

/** `TRANSCODE_DIR` is too full to start another stream. Retry later. */
export class InsufficientTranscodeSpace extends Schema.TaggedError<InsufficientTranscodeSpace>()(
  "InsufficientTranscodeSpace",
  { freeBytes: Schema.Finite, requiredBytes: Schema.Finite },
  { httpApiStatus: 507 },
) {
  override get message(): string {
    return `Insufficient transcode space: ${this.freeBytes} bytes free, ${this.requiredBytes} required`;
  }
}

/** The segment index is outside the stream. */
export class SegmentNotFound extends Schema.TaggedError<SegmentNotFound>()(
  "SegmentNotFound",
  { index: Schema.Int },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Segment not found: ${this.index}`;
  }
}

/** The segment was not produced in time. Retry the request. */
export class SegmentNotReady extends Schema.TaggedError<SegmentNotReady>()(
  "SegmentNotReady",
  { index: Schema.Int },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Segment not ready: ${this.index}`;
  }
}

/** ffmpeg failed and no fallback applies. */
export class TranscodeFailed extends Schema.TaggedError<TranscodeFailed>()(
  "TranscodeFailed",
  { streamId: Schema.String, mode: Schema.String, detail: Schema.String },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Transcode failed in ${this.mode}: ${this.detail}`;
  }
}

/** Failures of `POST /api/playback/negotiate`. */
export const NegotiateErrors = [
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  MediaFileNotFound,
  FileResolverUnavailable,
  UnsupportedPlayback,
  TranscodeCapacityReached,
  InsufficientTranscodeSpace,
  TranscodeFailed,
  KeyframeIndexFailed,
  StreamNotFound,
] as const;

/** Failures of `POST /api/playback/seek`. */
export const SeekErrors = [
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  StreamNotFound,
  StreamAccessDenied,
  StreamGenerationGone,
  SegmentNotFound,
  SegmentNotReady,
  TranscodeFailed,
  UnsupportedPlayback,
] as const;

/** Failures of `POST /api/playback/stop`. */
export const StopErrors = [
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  StreamNotFound,
  StreamAccessDenied,
] as const;

/** Failures of `POST /api/downloads/prepare`. */
export const PrepareDownloadErrors = [
  PlaybackTokenInvalid,
  PlaybackSessionEnded,
  MediaFileNotFound,
  FileResolverUnavailable,
  UnsupportedPlayback,
  InsufficientTranscodeSpace,
  TranscodeFailed,
] as const;

/** Every failure the playback API answers with, for decoding error bodies. */
export const PlaybackApiError = Schema.Union([
  ...NegotiateErrors,
  StreamAccessDenied,
  StreamGenerationGone,
  SegmentNotFound,
  SegmentNotReady,
]);

/** Every failure the playback API answers with. */
export type PlaybackApiError = typeof PlaybackApiError.Type;
