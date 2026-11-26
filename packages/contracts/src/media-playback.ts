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
import { EpochMillis } from "./units";

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
 * Why a playback ticket was refused. Never includes the ticket itself. The media service answers
 * it with status 401. `wrong_purpose` is a download ticket on a playback route, or a playback
 * ticket on a download route.
 */
export class PlaybackTokenInvalid extends Schema.TaggedError<
  PlaybackTokenInvalid,
  { readonly brand: unique symbol }
>()(
  "PlaybackTokenInvalid",
  {
    reason: Schema.Literals([
      "malformed",
      "bad_signature",
      "wrong_audience",
      "expired",
      "wrong_purpose",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

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

/** The video as the device receives it, after any transcode. */
export const DeliveredVideo = Schema.Struct({
  codec: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  dynamicRange: DynamicRange,
});

/** The video as the device receives it. */
export interface DeliveredVideo extends Schema.Schema.Type<typeof DeliveredVideo> {}

/**
 * One stage of a transcode's video chain, in the order frames pass through it. `op` and `domain`
 * are strings, so a later operation or GPU backend changes no contract.
 */
export const TranscodeStage = Schema.Struct({
  /**
   * What it does: `decode`, `scale`, `tonemap` (HDR to SDR), `burn-image` (a picture subtitle
   * drawn in), `encode`, or `move`, a copy of the frames between CPU and GPU memory.
   */
  op: Schema.String,
  /** Where it runs: `cpu`, or a GPU API such as `qsv` or `vaapi`. A move runs in its GPU's. */
  domain: Schema.String,
  /** The implementation, such as `decode.qsv`, `tonemap.cpu`, or `move.qsv>cpu`. */
  impl: Schema.String,
  /** A move's memories: where the frames were, and where they go. */
  move: Schema.optionalKey(Schema.Struct({ from: Schema.String, to: Schema.String })),
});

/** One stage of a transcode's video chain. */
export interface TranscodeStage extends Schema.Schema.Type<typeof TranscodeStage> {}

/**
 * Why a stream's video chain changed or the stream ended, as the media service's failure
 * classifier found it. A closed list, so no text from ffmpeg's log reaches a client; the readable
 * line stays in the server's log.
 *
 * - `reproduced`: a probe on a generated clip failed again at a stage the run used.
 * - `file-only`: the stages ran on generated frames; only this file fails there.
 * - `undecided`: the probes could not tell whether a stage the run used fails: they ran out of
 *   time, proved nothing (as when ffmpeg exited at once with no frames), or could not run.
 * - `unexplained`: a run on the CPU failed and its log named no part.
 * - `stopped`: a signal stopped ffmpeg.
 * - `not-started`: ffmpeg did not start.
 * - `disk-full`: the disk or its quota was full.
 * - `input`, `audio`, `mux`: reading the file, the audio, or writing the output failed.
 * - `capability-lost`: a stage the chain used stopped being verified before a new run (a change).
 * - `nothing-left`: no chain left can encode the file (a failure).
 * - `segment-not-cut`: ffmpeg did not cut where the segment plan starts a segment (a failure).
 * - `other`: a failure the classifier does not read, such as a remux's or a download's.
 */
export const TranscodeReason = Schema.Literals([
  "reproduced",
  "file-only",
  "undecided",
  "unexplained",
  "stopped",
  "not-started",
  "disk-full",
  "input",
  "audio",
  "mux",
  "capability-lost",
  "nothing-left",
  "segment-not-cut",
  "other",
]);

/** Why a stream's video chain changed or the stream ended. */
export type TranscodeReason = typeof TranscodeReason.Type;

/** A reason a newer media service gives, which this client's list lacks, kept as it came. */
const NewerTranscodeReason = Schema.String.pipe(Schema.brand("NewerTranscodeReason"));

/**
 * A reason as the wire carries it: one of `TranscodeReason`'s codes, or a code a newer media
 * service added, kept as it came, so a client still reads the rest of the answer and labels the
 * code as it labels `other`. Only `TranscodeReason`'s codes type-check where the service builds a
 * change or a failure; a plain string does not.
 */
export const TranscodeReasonCode = Schema.Union([TranscodeReason, NewerTranscodeReason]);

/** A reason as the wire carries it. */
export type TranscodeReasonCode = typeof TranscodeReasonCode.Type;

/** A change of a stream's video chain, after a failed run or a capability its chain lost. */
export const TranscodeChange = Schema.Struct({
  at: EpochMillis,
  /** The generation the changed chain first ran in. */
  generation: Schema.Int,
  /**
   * Why, as a code: `capability` (a probe reproduced a stage's failure), `source` (only this file
   * fails there), `undecided` (the probes could not tell), `not-video` (the failure was not the
   * video's), `unexplained` (a CPU run failed naming nothing), or `capability-lost` (a stage the
   * chain used stopped being verified). A string, so a new cause changes no contract.
   */
  cause: Schema.String,
  /** The implementations the stream keeps off from then on, such as `tonemap.qsv`. */
  excluded: Schema.Array(Schema.String),
  reason: TranscodeReasonCode,
});

/** A change of a stream's video chain. */
export interface TranscodeChange extends Schema.Schema.Type<typeof TranscodeChange> {}

/**
 * Where an HLS generation's video is made: its stages, none when the video is copied, and every
 * change of the chain up to that generation, oldest first. It carries no ffmpeg arguments, paths,
 * or log text: only codes and the implementation ids of the service's operation table.
 */
export const TranscodeSummary = Schema.Struct({
  stages: Schema.Array(TranscodeStage),
  changes: Schema.Array(TranscodeChange),
});

/** Where an HLS generation's video is made. */
export interface TranscodeSummary extends Schema.Schema.Type<typeof TranscodeSummary> {}

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
  video: DeliveredVideo,
  /** HLS only: where the generation's video is made. */
  transcode: Schema.optional(TranscodeSummary),
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

/**
 * Where the stream continues: the generation to load and its playlist, with how that generation
 * delivers the video, which a replacement after a failure may have changed. A player that reloads
 * after `StreamGenerationGone` seeks to where it is and gets the same.
 */
export const SeekResponse = Schema.Struct({
  streamId: StreamId,
  generation: Schema.Int,
  playlistUrl: Schema.String,
  mode: PlaybackMode,
  video: DeliveredVideo,
  transcode: TranscodeSummary,
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
  video: DeliveredVideo,
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
  /**
   * The version of Lar this server runs, as its package names it. Apps read it as a `Release`
   * (`./release`) and treat any other text as an unknown release.
   */
  release: Schema.String,
  /** Streams whose encoder runs; a paused stream whose encoder stopped is not counted. */
  activeStreams: Schema.Int,
  /**
   * Encoder runs whose ffmpeg has not exited yet, closed streams' runs included. A run that stays
   * here after its stream stopped is stuck, for example on a disk that stopped answering.
   */
  runsAwaitingExit: Schema.Int,
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
 * What an app needs to connect when someone types only this service's address: the release it
 * runs, and the Convex URL to sign in to, as clients reach it (`CONVEX_PUBLIC_URL`), absent when
 * none is configured.
 */
export const ClientConfigResponse = Schema.Struct({
  /** The version of Lar this server runs, as its package names it. */
  release: Schema.String,
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
export class UnsupportedPlayback extends Schema.TaggedError<
  UnsupportedPlayback,
  { readonly brand: unique symbol }
>()("UnsupportedPlayback", { reason: UnsupportedReason }, { httpApiStatus: 422 }) {
  override get message(): string {
    return `Unsupported playback: ${this.reason}`;
  }
}

/** The token's playback session ended. Start a new session with `playback.createSession`. */
export class PlaybackSessionEnded extends Schema.TaggedError<
  PlaybackSessionEnded,
  { readonly brand: unique symbol }
>()("PlaybackSessionEnded", { sessionId: PlaybackSessionId }, { httpApiStatus: 410 }) {
  override get message(): string {
    return "Playback session ended: start a new session";
  }
}

/** No stored file has this ID, it is marked missing, or it lies outside the approved folders. */
export class MediaFileNotFound extends Schema.TaggedError<
  MediaFileNotFound,
  { readonly brand: unique symbol }
>()("MediaFileNotFound", { fileId: Schema.String }, { httpApiStatus: 404 }) {
  override get message(): string {
    return `Media file not found: ${this.fileId}`;
  }
}

/** The media service cannot reach its file records right now. Retry shortly. */
export class FileResolverUnavailable extends Schema.TaggedError<
  FileResolverUnavailable,
  { readonly brand: unique symbol }
>()("FileResolverUnavailable", { cause: Schema.Defect() }, { httpApiStatus: 503 }) {
  override get message(): string {
    return "File resolver unavailable: the file store did not answer";
  }
}

/** The file's keyframes could not be read, so its HLS segments cannot be planned. */
export class KeyframeIndexFailed extends Schema.TaggedError<
  KeyframeIndexFailed,
  { readonly brand: unique symbol }
>()(
  "KeyframeIndexFailed",
  { fileId: Schema.String, cause: Schema.Defect() },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Keyframe index failed for file ${this.fileId}`;
  }
}

/** The stream ID is unknown, for example after a restart. Renegotiate to get a new one. */
export class StreamNotFound extends Schema.TaggedError<
  StreamNotFound,
  { readonly brand: unique symbol }
>()("StreamNotFound", { streamId: Schema.String }, { httpApiStatus: 404 }) {
  override get message(): string {
    return "Stream not found: renegotiate playback";
  }
}

/** The request names an old generation; load the current generation's playlist instead. */
export class StreamGenerationGone extends Schema.TaggedError<
  StreamGenerationGone,
  { readonly brand: unique symbol }
>()(
  "StreamGenerationGone",
  { streamId: Schema.String, generation: Schema.Int, currentGeneration: Schema.Int },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return `Stream generation gone: ${this.generation} was replaced by ${this.currentGeneration}`;
  }
}

/** The token belongs to another playback session or file. */
export class StreamAccessDenied extends Schema.TaggedError<
  StreamAccessDenied,
  { readonly brand: unique symbol }
>()("StreamAccessDenied", { streamId: Schema.String }, { httpApiStatus: 403 }) {
  override get message(): string {
    return "Stream access denied: the token does not match this stream";
  }
}

/** All transcode slots are busy. Retry later. */
export class TranscodeCapacityReached extends Schema.TaggedError<
  TranscodeCapacityReached,
  { readonly brand: unique symbol }
>()("TranscodeCapacityReached", { limit: Schema.Int }, { httpApiStatus: 503 }) {
  override get message(): string {
    return `Transcode capacity reached: ${this.limit} transcodes are running`;
  }
}

/** `TRANSCODE_DIR` is too full to start another stream. Retry later. */
export class InsufficientTranscodeSpace extends Schema.TaggedError<
  InsufficientTranscodeSpace,
  { readonly brand: unique symbol }
>()(
  "InsufficientTranscodeSpace",
  { freeBytes: Schema.Finite, requiredBytes: Schema.Finite },
  { httpApiStatus: 507 },
) {
  override get message(): string {
    return `Insufficient transcode space: ${this.freeBytes} bytes free, ${this.requiredBytes} required`;
  }
}

/** The segment index is outside the stream. */
export class SegmentNotFound extends Schema.TaggedError<
  SegmentNotFound,
  { readonly brand: unique symbol }
>()("SegmentNotFound", { index: Schema.Int }, { httpApiStatus: 404 }) {
  override get message(): string {
    return `Segment not found: ${this.index}`;
  }
}

/** The segment was not produced in time. Retry the request. */
export class SegmentNotReady extends Schema.TaggedError<
  SegmentNotReady,
  { readonly brand: unique symbol }
>()("SegmentNotReady", { index: Schema.Int }, { httpApiStatus: 503 }) {
  override get message(): string {
    return `Segment not ready: ${this.index}`;
  }
}

/** ffmpeg failed and no fallback applies; `reason` says why, as the failure classifier found it. */
export class TranscodeFailed extends Schema.TaggedError<
  TranscodeFailed,
  { readonly brand: unique symbol }
>()(
  "TranscodeFailed",
  { streamId: Schema.String, mode: Schema.String, reason: TranscodeReasonCode },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Transcode failed in ${this.mode}: ${this.reason}`;
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
