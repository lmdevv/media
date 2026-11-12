/**
 * Retained service logs and playback diagnostics as data.
 *
 * The media service writes every log line it prints, already redacted, to rotating NDJSON files
 * (`LogRecord`). Admins read them back through `POST /api/logs` (`LogQuery`), which answers with
 * NDJSON, one record per line, and keeps the connection open with `follow`. Players report what
 * they see (stalls, errors, segment loads, recoveries) in batches of `ClientDiagnosticEvent`
 * through `POST /api/playback/diagnostics`, authenticated by their playback token; the service
 * writes them into the same log. `PlaybackDiagnostics` is the timeline of one playback session
 * that the service assembles from those records. Apps report their own unexpected errors
 * (`ClientErrorReport`) through `POST /api/client-errors` with the account's Convex auth token.
 */
import { Schema } from "effect";

import { PlaybackSessionId, UserId } from "./ids";
import { PlaybackTokenInvalid, StreamId } from "./media-playback";
import { PlaybackMode } from "./models/playback";
import { RequestId } from "./request-id";
import { EpochMillis } from "./units";

/** Paths of the log and diagnostics routes, relative to the media service's base URL. */
export const DIAGNOSTICS_ROUTES = {
  logs: "/api/logs",
  clientEvents: "/api/playback/diagnostics",
  clientErrors: "/api/client-errors",
} as const;

/** A log level as a record carries it. */
export const LogLevel = Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]);

/** A log level as a record carries it. */
export type LogLevel = typeof LogLevel.Type;

/** Every level from least to most severe. */
export const LOG_LEVELS: ReadonlyArray<LogLevel> = LogLevel.literals;

/** Whether `level` is at least as severe as `minimum`. */
export const atLeast = (level: LogLevel, minimum: LogLevel): boolean =>
  LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);

/**
 * One retained log line: Effect's structured log format. `message` is the event name, such as
 * `MediaRoutes.slow_segment`; `annotations` carry its fields, such as `sessionId` and `streamId`.
 */
export const LogRecord = Schema.Struct({
  /** ISO 8601 time the line was logged. */
  timestamp: Schema.String,
  level: LogLevel,
  message: Schema.Json,
  annotations: Schema.Record(Schema.String, Schema.Json),
  spans: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  cause: Schema.optional(Schema.String),
  fiberId: Schema.optional(Schema.String),
});

/** One retained log line. */
export interface LogRecord extends Schema.Schema.Type<typeof LogRecord> {}

/** The most records one request returns before following. */
export const MAX_LOG_LIMIT = 5000;

/**
 * Which retained records to read. Every filter given must match. Without `follow` the answer is
 * the last `limit` matching records in time order; with it, the same and then each new matching
 * record as it is logged, until the client disconnects.
 */
export const LogQuery = Schema.Struct({
  /** Records at or after this instant. */
  since: Schema.optional(EpochMillis),
  /** Records before this instant; not allowed with `follow`. */
  until: Schema.optional(EpochMillis),
  /** The least severe level returned. */
  level: Schema.optional(LogLevel),
  sessionId: Schema.optional(PlaybackSessionId),
  streamId: Schema.optional(Schema.String),
  /** Only timed requests and segment loads that took at least this many milliseconds. */
  slowMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Case-insensitive text the record's JSON line contains. */
  grep: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LOG_LIMIT })),
  ),
  follow: Schema.optional(Schema.Boolean),
});

/** Which retained records to read. */
export interface LogQuery extends Schema.Schema.Type<typeof LogQuery> {}

/**
 * Response header that is `true` when earlier records may match too: `limit` was reached before
 * the oldest file. Narrow the query or raise the limit to see them.
 */
export const LOG_TRUNCATED_HEADER = "x-movies-log-truncated";

/**
 * Response header present when the media service cannot write or read its retained log: the ISO
 * 8601 time it began failing. Records logged since then went to its standard output only.
 */
export const LOG_UNAVAILABLE_SINCE_HEADER = "x-movies-log-unavailable-since";

const AgeMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 }));

const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** How a player plays the stream. */
export const PlayerEngine = Schema.Literals(["hls.js", "html-video", "avplayer"]);

/** How a player plays the stream. */
export type PlayerEngine = typeof PlayerEngine.Type;

/** What a player did to get playing again, or the recovery the SDK chose. */
export const RecoveryAction = Schema.Literals([
  "reload-playlist",
  "renegotiate",
  "renew-token",
  "new-session",
  "retry-later",
  "try-another-way",
  "media-error-recovery",
]);

/** What a player did to get playing again. */
export type RecoveryAction = typeof RecoveryAction.Type;

const WaitEndedBy = Schema.Literals(["playing", "paused", "closed"]);

/**
 * Milliseconds from the viewer's play intent to each startup stage the player saw. A stage the
 * player cannot observe, or did not reach, is absent: AVPlayer reports no segment loads, and
 * direct play loads no playlist or segments.
 */
export const StartupStages = Schema.Struct({
  /** The service answered the negotiation with a stream. */
  negotiatedMs: Schema.optional(Count),
  /** The player loaded the stream's playlist. */
  manifestLoadedMs: Schema.optional(Count),
  /** The player loaded the stream's first media segment. */
  firstFragmentMs: Schema.optional(Count),
  /** The player showed the stream's first frame. */
  firstFrameMs: Schema.optional(Count),
});

/** Milliseconds from the viewer's play intent to each startup stage the player saw. */
export interface StartupStages extends Schema.Schema.Type<typeof StartupStages> {}

/** The audio rendition a stream plays, as the player receives it. */
export const AudioRendition = Schema.Struct({
  /** ffmpeg codec name, such as `aac` or `eac3`. */
  codec: Schema.String.check(Schema.isBetweenLength(1, 32)),
  channels: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  /** The track's language tag, absent when the file names none. */
  language: Schema.optional(Schema.String.check(Schema.isBetweenLength(1, 16))),
});

/** The audio rendition a stream plays. */
export interface AudioRendition extends Schema.Schema.Type<typeof AudioRendition> {}

/** The largest drift sample the service accepts, in milliseconds either way. */
export const MAX_DRIFT_MS = 60_000;

/** The most drift samples one `DriftSampled` report summarizes. */
export const DRIFT_WINDOW_SAMPLES = 6;

const DriftMs = Schema.Int.check(
  Schema.isBetween({ minimum: -MAX_DRIFT_MS, maximum: MAX_DRIFT_MS }),
);

/** How many drift samples there were, their median, and the one furthest from zero. */
export interface DriftSummary {
  readonly samples: number;
  readonly medianMs: number;
  readonly worstMs: number;
}

/** The summary of drift samples `values`, in milliseconds; the median is rounded. */
export const summarizeDrift = (values: readonly [number, ...Array<number>]): DriftSummary => {
  const sorted = values.toSorted((left, right) => left - right);

  const centre = sorted.slice(
    Math.floor((sorted.length - 1) / 2),
    Math.floor(sorted.length / 2) + 1,
  );

  return {
    samples: values.length,
    medianMs: Math.round(centre.reduce((total, ms) => total + ms, 0) / centre.length),
    worstMs: values.reduce((worst, ms) => (Math.abs(ms) > Math.abs(worst) ? ms : worst)),
  };
};

/** Something a player saw. */
export const PlayerObservation = Schema.TaggedUnion({
  /** A stream was attached to the player, with its audio rendition when the player knows it. */
  Attached: { mode: PlaybackMode, engine: PlayerEngine, audio: Schema.optional(AudioRendition) },
  /**
   * The player waited `durationMs` for the playback session's stream to play for the first time,
   * then it played, the viewer paused, or the player closed. Never a stall. `stages` splits the
   * time from the viewer's play intent, from players that measure it.
   */
  StartupEnded: {
    positionSeconds: Seconds,
    durationMs: Count,
    endedBy: WaitEndedBy,
    stages: Schema.optional(StartupStages),
  },
  /**
   * Playback stopped to wait for data while the viewer wanted it to play, after the playback
   * session had played.
   */
  BufferingStarted: { positionSeconds: Seconds, bufferedAheadSeconds: Seconds },
  /** Playback went on after a stall, the viewer paused instead, or the player closed during it. */
  BufferingEnded: {
    positionSeconds: Seconds,
    bufferedAheadSeconds: Seconds,
    durationMs: Count,
    endedBy: WaitEndedBy,
  },
  /** A media, decoder, or network error the player reported. */
  PlayerError: {
    source: Schema.Literals(["html-video", "hls.js", "avplayer"]),
    kind: Schema.String.check(Schema.isBetweenLength(1, 64)),
    detail: Schema.String.check(Schema.isMaxLength(300)),
    fatal: Schema.Boolean,
    status: Schema.optional(Schema.Int),
  },
  /** Frames the decoder dropped since the previous report, out of those it decoded. */
  DroppedFrames: { dropped: Count, decoded: Count },
  /**
   * hls.js finished loading one segment. `index` counts the loads of the playback session from 0,
   * from players that count them.
   */
  FragmentLoaded: {
    segment: Count,
    durationMs: Count,
    firstByteMs: Count,
    bytes: Count,
    index: Schema.optional(Count),
  },
  /**
   * The player recovered, or tried to, from a failure. `renew-token` is a routine renewal of the
   * playback token before or after it expired.
   */
  Recovery: { action: RecoveryAction, reason: Schema.String.check(Schema.isMaxLength(120)) },
  /**
   * Audio/video drift over one window of samples while playing (`DRIFT_WINDOW_SAMPLES` at most).
   * A sample is how far the media time of the video frame being shown is ahead of the media clock
   * at the moment it shows, in milliseconds. Browsers drive the media clock from the audio output,
   * so a negative value means the picture trails the sound. Players without frame presentation
   * times (AVPlayer through expo-video) send none.
   */
  DriftSampled: {
    samples: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DRIFT_WINDOW_SAMPLES })),
    medianMs: DriftMs,
    /** The sample furthest from zero, with its sign. */
    worstMs: DriftMs,
  },
});

/** Something a player saw. */
export type PlayerObservation = typeof PlayerObservation.Type;

/** An observation as a batch carries it: how long before the batch, and in which stream. */
export const ClientDiagnosticEvent = Schema.Struct({
  ageMs: AgeMs,
  /** The HLS stream playing, absent for direct play. */
  streamId: Schema.optional(StreamId),
  observation: PlayerObservation,
});

/** An observation as a batch carries it. */
export interface ClientDiagnosticEvent extends Schema.Schema.Type<typeof ClientDiagnosticEvent> {}

/** The most events one batch may carry. */
export const MAX_CLIENT_EVENTS = 100;

/** The platform a player runs on. */
export const ClientPlatform = Schema.Literals(["web", "ios"]);

/** The platform a player runs on. */
export type ClientPlatform = typeof ClientPlatform.Type;

/** A batch of a player's events for the session its playback token names. */
export const ClientDiagnosticsRequest = Schema.Struct({
  /** The session's playback token; a session that has ended still accepts its last events. */
  token: Schema.Redacted(Schema.String),
  platform: ClientPlatform,
  events: Schema.Array(ClientDiagnosticEvent).check(Schema.isBetweenLength(1, MAX_CLIENT_EVENTS)),
});

/** A batch of a player's events. */
export interface ClientDiagnosticsRequest extends Schema.Schema.Type<
  typeof ClientDiagnosticsRequest
> {}

/** The session sent more events than the service keeps. Drop the batch. */
export class DiagnosticsRateLimited extends Schema.TaggedError<DiagnosticsRateLimited>()(
  "DiagnosticsRateLimited",
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {
  override get message(): string {
    return `Diagnostics rate limited: retry after ${this.retryAfterSeconds} s`;
  }
}

/** Failures of `POST /api/playback/diagnostics`. */
export const ClientDiagnosticsErrors = [PlaybackTokenInvalid, DiagnosticsRateLimited] as const;

/** The longest each text field of a `ClientErrorReport` may be; apps cut longer values to fit. */
export const CLIENT_ERROR_LIMITS = {
  appVersion: 64,
  route: 256,
  name: 128,
  message: 1000,
  stack: 4000,
  sessionId: 128,
} as const;

const Text = (maxLength: number) => Schema.String.check(Schema.isBetweenLength(1, maxLength));

/** Where an app caught an error. */
export const ClientErrorKind = Schema.Literals([
  "route",
  "render",
  "uncaught",
  "unhandled-rejection",
]);

/** Where an app caught an error. */
export type ClientErrorKind = typeof ClientErrorKind.Type;

/** An unexpected error an app caught, for the retained log. */
export const ClientErrorReport = Schema.Struct({
  platform: ClientPlatform,
  appVersion: Text(CLIENT_ERROR_LIMITS.appVersion),
  kind: ClientErrorKind,
  /** The path or screen the app showed, such as `/titles/abc`. */
  route: Text(CLIENT_ERROR_LIMITS.route),
  name: Text(CLIENT_ERROR_LIMITS.name),
  message: Schema.String.check(Schema.isMaxLength(CLIENT_ERROR_LIMITS.message)),
  stack: Schema.optionalKey(Text(CLIENT_ERROR_LIMITS.stack)),
  /** The media service request that failed, when the error is an SDK error that names one. */
  requestId: Schema.optionalKey(RequestId),
  /** The playback session playing then, when the app knows it. */
  sessionId: Schema.optionalKey(
    PlaybackSessionId.check(Schema.isMaxLength(CLIENT_ERROR_LIMITS.sessionId)),
  ),
});

/** An unexpected error an app caught. */
export interface ClientErrorReport extends Schema.Schema.Type<typeof ClientErrorReport> {}

/** What a timeline entry records. */
export const TimelineKind = Schema.Literals([
  "stream-started",
  "stream-moved",
  "stream-ended",
  "mode-changed",
  "encoder-failed",
  "slow-segment",
  "request-failed",
  "player-attached",
  "startup",
  "buffering-started",
  "buffering-ended",
  "player-error",
  "dropped-frames",
  "slow-fragment",
  "recovery",
]);

/** What a timeline entry records. */
export type TimelineKind = typeof TimelineKind.Type;

/** One thing that happened to a playback session, from the service's or the player's side. */
export const TimelineEntry = Schema.Struct({
  at: EpochMillis,
  source: Schema.Literals(["server", "player"]),
  kind: TimelineKind,
  level: LogLevel,
  streamId: Schema.NullOr(Schema.String),
  /** One line for people. */
  summary: Schema.String,
  /** The record's fields, such as the latency split of a slow segment. */
  details: Schema.Record(Schema.String, Schema.Json),
});

/** One thing that happened to a playback session. */
export interface TimelineEntry extends Schema.Schema.Type<typeof TimelineEntry> {}

/** Totals over a session's timeline. */
export const DiagnosticsCounts = Schema.Struct({
  streams: Count,
  stalls: Count,
  stalledMs: Count,
  slowSegments: Count,
  failedRequests: Count,
  playerErrors: Count,
  recoveries: Count,
  slowFragments: Count,
  droppedFrames: Count,
});

/** Totals over a session's timeline. */
export interface DiagnosticsCounts extends Schema.Schema.Type<typeof DiagnosticsCounts> {}

/** Drift the player did not or could not measure, and why; never guessed. */
export const DriftNotMeasured = Schema.Struct({
  status: Schema.Literal("not-measured"),
  reason: Schema.String,
});

/**
 * Drift from the player's `DriftSampled` reports: the video frame shown against the media clock,
 * in milliseconds, negative when the picture trails the sound. `medianMs` is the median of the
 * reports' medians.
 */
export const DriftMeasured = Schema.Struct({
  status: Schema.Literal("measured"),
  method: Schema.Literal("video-frame-vs-media-clock"),
  samples: Count,
  medianMs: Schema.Int,
  /** The sample furthest from zero, with its sign. */
  worstMs: Schema.Int,
});

/** Audio/video drift of a playback session. */
export const Drift = Schema.Union([DriftNotMeasured, DriftMeasured]);

/** Audio/video drift of a playback session. */
export type Drift = typeof Drift.Type;

/**
 * The timeline of one playback session from the retained logs. `missing` names evidence the logs
 * do not hold, so an empty part of the timeline is never mistaken for a clean one.
 */
export const PlaybackDiagnostics = Schema.Struct({
  sessionId: PlaybackSessionId,
  firstSeenAt: EpochMillis,
  lastSeenAt: EpochMillis,
  platform: Schema.NullOr(ClientPlatform),
  counts: DiagnosticsCounts,
  /**
   * Audio/video drift. `measured` only for callers that ask for it (`measuredDrift`); clients
   * before it decode `not-measured` only.
   */
  drift: Drift,
  missing: Schema.Array(Schema.String),
  /** More records matched than one timeline holds; the earliest were left out. */
  truncated: Schema.Boolean,
  entries: Schema.Array(TimelineEntry),
});

/** The timeline of one playback session. */
export interface PlaybackDiagnostics extends Schema.Schema.Type<typeof PlaybackDiagnostics> {}

/** A playback session the retained logs mention, to find its ID. */
export const DiagnosedSession = Schema.Struct({
  sessionId: PlaybackSessionId,
  userId: Schema.NullOr(UserId),
  firstSeenAt: EpochMillis,
  lastSeenAt: EpochMillis,
  platform: Schema.NullOr(ClientPlatform),
  /** Records at `WARN` or above. */
  warnings: Count,
});

/** A playback session the retained logs mention. */
export interface DiagnosedSession extends Schema.Schema.Type<typeof DiagnosedSession> {}
