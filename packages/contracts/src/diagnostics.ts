/**
 * Retained service logs and playback diagnostics as data.
 *
 * The media service writes every log line it prints, already redacted, to rotating NDJSON files
 * (`LogRecord`). Admins read them back through `POST /api/logs` (`LogQuery`), which answers with
 * NDJSON, one record per line, and keeps the connection open with `follow`. Players report what
 * they see (stalls, errors, segment loads, recoveries) in batches of `ClientDiagnosticEvent`
 * through `POST /api/playback/diagnostics`, authenticated by their playback token; the service
 * writes them into the same log. `PlaybackDiagnostics` is the timeline of one playback session
 * that the service assembles from those records. Web apps report their own unexpected errors
 * (`ClientErrorReport`) through `POST /api/client-errors` with the account's Convex auth token, and
 * the iOS apps report their launches, screen opens, and errors in batches of `AppEvent` through
 * `POST /api/app-events` the same way.
 */
import { Schema } from "effect";

import { MOVIES_ROUTES, MUSIC_ROUTES } from "./app-routes";
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
  appEvents: "/api/app-events",
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
export const LOG_TRUNCATED_HEADER = "x-media-log-truncated";

/**
 * Response header present when the media service cannot write or read its retained log: the ISO
 * 8601 time it began failing. Records logged since then went to its standard output only.
 */
export const LOG_UNAVAILABLE_SINCE_HEADER = "x-media-log-unavailable-since";

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
export class DiagnosticsRateLimited extends Schema.TaggedError<
  DiagnosticsRateLimited,
  { readonly brand: unique symbol }
>()("DiagnosticsRateLimited", { retryAfterSeconds: Schema.Int }, { httpApiStatus: 429 }) {
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

/** Which Lar app sent an app event. */
export const AppName = Schema.Literals(["movies", "music"]);

/** Which Lar app sent an app event. */
export type AppName = typeof AppName.Type;

/**
 * An app's release as it reports it: three numbers, and a pre-release of `alpha`, `beta`, or `rc`
 * with its number, such as `0.9.0` or `0.10.0-rc.1`. Nothing else, so no text can ride in it.
 */
export const AppRelease = Schema.String.check(
  Schema.isPattern(
    /^(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){2}(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d{0,3}))?$/u,
  ),
);

/**
 * Where the app's JavaScript came from: `embedded` in the app, as in a release build, or a
 * `dev-server` such as Metro, whose launches include fetching it. A frame's position is a position
 * in that bundle.
 */
export const BundleOrigin = Schema.Literals(["embedded", "dev-server"]);

/** Where the app's JavaScript came from. */
export type BundleOrigin = typeof BundleOrigin.Type;

/** The longest duration an app event carries; a slower launch or screen open is not reported. */
export const MAX_APP_TIMING_MS = 600_000;

const TimingMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_APP_TIMING_MS }));

/** Where the content a screen first showed came from: the server, or the downloads on the device. */
export const ContentSource = Schema.Literals(["network", "downloads"]);

/** Where the content a screen first showed came from. */
export type ContentSource = typeof ContentSource.Type;

/** A screen whose opening an app times: a movies title, a music album, or a music artist. */
export const TimedScreen = Schema.Literals(["title", "album", "artist"]);

/** A screen whose opening an app times. */
export type TimedScreen = typeof TimedScreen.Type;

/**
 * Whether an opened screen had its content when it mounted: `kept`, the SDK already held its
 * query, as after an earlier visit; or `fetched`, the screen asked for it and waited.
 */
export const OpenCache = Schema.Literals(["kept", "fetched"]);

/** Whether an opened screen had its content when it mounted. */
export type OpenCache = typeof OpenCache.Type;

/**
 * One timing's two ends, each a display refresh a frame mark over the content saw, in milliseconds
 * from the timing's start:
 *
 * - `readyMs`: the first refresh after the real content (not a placeholder) was committed and laid
 *   out, wherever it stood then: under the splash screen, or partway through a slide-in. Work that
 *   gets the content sooner, such as preloading, moves it.
 * - `atRestMs`: the first refresh that shows the content as it rests: in its place with any
 *   transition over, faded in, and uncovered. It is never earlier than `readyMs`, and a fixed-length
 *   transition sets its floor; it is the most a person can see.
 *
 * Each `…Hitched` says the refresh came after one or more the app missed: the frame before it was
 * heavy and can show a refresh or more after the time given, so a reader can drop or widen it.
 */
const frameTimingFields = {
  readyMs: TimingMs,
  readyHitched: Schema.Boolean,
  atRestMs: TimingMs,
  atRestHitched: Schema.Boolean,
} as const;

const readyFirst = Schema.makeFilter(
  (timing: { readonly readyMs: number; readonly atRestMs: number }) =>
    timing.readyMs <= timing.atRestMs,
  { title: "content ready no later than at rest" },
);

/** One timing's two ends: content ready and content at rest. */
export const FrameTimings = Schema.Struct(frameTimingFields).check(readyFirst);

/** One timing's two ends. */
export interface FrameTimings extends Schema.Schema.Type<typeof FrameTimings> {}

/** Home's content timing at launch, and where the content came from. */
const HomeContentTimings = Schema.Struct({ ...frameTimingFields, source: ContentSource }).check(
  readyFirst,
);

/** A route pattern of the movies app, or `unknown` before its first screen or for any other. */
export const MoviesRoute = Schema.Literals([...MOVIES_ROUTES, "unknown"]);

/** A route pattern of the music app, or `unknown`. */
export const MusicRoute = Schema.Literals([...MUSIC_ROUTES, "unknown"]);

/** A route pattern of either app, or `unknown`. */
export const AppRoute = Schema.Union([MoviesRoute, MusicRoute]);

/** A route pattern of either app, or `unknown`. */
export type AppRoute = typeof AppRoute.Type;

/** Each app's own route patterns, with `unknown`. */
export const APP_ROUTE: Readonly<Record<AppName, Schema.Schema<AppRoute>>> = {
  movies: MoviesRoute,
  music: MusicRoute,
};

/**
 * What kind of error was caught, from a list fixed in the code: one of JavaScript's own error
 * types; a tagged error of the SDK, the contracts, or Effect; `NotAnError` for a thrown value that
 * is no error; or `Other`. A type's name, never the error's.
 */
export const ErrorClass = Schema.Literals([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Unauthenticated",
  "Forbidden",
  "NotFound",
  "InvalidArgs",
  "Conflict",
  "Expired",
  "RateLimited",
  "Internal",
  "TransportError",
  "ProtocolError",
  "TokenStorageError",
  "SignInWaiting",
  "DeviceSignInRefused",
  "PlaybackTokenInvalid",
  "PlaybackSessionEnded",
  "UnsupportedPlayback",
  "MediaFileNotFound",
  "StreamNotFound",
  "StreamGenerationGone",
  "StreamAccessDenied",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
  "TranscodeFailed",
  "DiagnosticsRateLimited",
  "SchemaError",
  "NoSuchElementError",
  "TimeoutError",
  "UnknownError",
  "IllegalArgumentError",
  "ExceededCapacityError",
  "NotAnError",
  "Other",
]);

/** What kind of error was caught. */
export type ErrorClass = typeof ErrorClass.Type;

/** The most stack frames an error report carries. */
export const MAX_ERROR_FRAMES = 8;

/**
 * Which code a stack frame runs in: the app's JavaScript `bundle`, `native` code, or `other`
 * JavaScript, such as code a debugger evaluated or the engine's own.
 */
export const FrameSource = Schema.Literals(["bundle", "native", "other"]);

/** Which code a stack frame runs in. */
export type FrameSource = typeof FrameSource.Type;

/** The largest line or column a stack frame carries. */
export const MAX_FRAME_POSITION = 100_000_000;

const Position = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_FRAME_POSITION }));

/**
 * One frame of an error's stack, as numbers: which code it runs in and the line and column there,
 * 0 when the stack gives none. A `bundle` frame's position turns back into a source file, line, and
 * function with the source map of the bundle the batch names (`release`, `bundle`).
 */
export const ErrorFrame = Schema.Struct({ source: FrameSource, line: Position, column: Position });

/** One frame of an error's stack. */
export interface ErrorFrame extends Schema.Schema.Type<typeof ErrorFrame> {}

/**
 * Something an app reports about itself. Every field is a number or a member of a set fixed in the
 * code; no string the running app reads, from the person, the library, the server, or an error,
 * reaches the server, which refuses any other value or field.
 *
 * Each timing is named for the pixels it ends on, and runs on the device's monotonic clock.
 */
export const AppEvent = Schema.TaggedUnion({
  /**
   * A cold launch that landed on Home. Every time runs from the process start the kernel records,
   * an instant before the app's first frame that no screen shows. `firstScreen` times Home's
   * screen, loading or not: ready once React committed it, at rest once the splash screen is gone.
   * `homeContent` times Home's real content (its rows and titles, not their artwork), and is
   * missing when Home drew none within a minute.
   */
  Launched: {
    firstScreen: FrameTimings,
    homeContent: Schema.optionalKey(HomeContentTimings),
  },
  /**
   * A press opened a timed screen. `content` runs from the touch that ended the press: ready once
   * the screen's real content is committed and laid out, which a preload can bring forward to the
   * push's first frame; at rest once the push has ended with it in place.
   */
  ScreenOpened: { screen: TimedScreen, cache: OpenCache, content: FrameTimings },
  /**
   * An unexpected error the app caught on the screen of route pattern `route`. A `fatal` error
   * ended the app; it was saved on the device and sent at the next launch.
   */
  ErrorCaught: {
    kind: ClientErrorKind,
    fatal: Schema.Boolean,
    route: AppRoute,
    errorClass: ErrorClass,
    frames: Schema.Array(ErrorFrame).check(Schema.isMaxLength(MAX_ERROR_FRAMES)),
    /** The media service request that failed, when the error is an SDK error that names one. */
    requestId: Schema.optionalKey(RequestId),
  },
});

/** Something an app reports about itself. */
export type AppEvent = typeof AppEvent.Type;

/** The longest an app event waits on the device; a crash report waits for the next launch. */
export const MAX_APP_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An app event as a batch carries it: how long before the batch it happened. */
export const QueuedAppEvent = Schema.Struct({
  ageMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_APP_EVENT_AGE_MS })),
  event: AppEvent,
});

/** An app event as a batch carries it. */
export interface QueuedAppEvent extends Schema.Schema.Type<typeof QueuedAppEvent> {}

/** The most events one batch of app events may carry. */
export const MAX_APP_EVENTS = 50;

/**
 * The most bytes a batch of app events may take as JSON. The largest batch the schema accepts fits
 * well inside it; the service stops reading a body at this size.
 */
export const MAX_APP_EVENTS_BYTES = 96 * 1024;

/** Whether every error report in `request` names one of its own app's route patterns. */
const routesAreTheApps = (request: {
  readonly app: AppName;
  readonly events: ReadonlyArray<{ readonly event: AppEvent }>;
}): boolean =>
  request.events.every(
    ({ event }) =>
      !AppEvent.guards.ErrorCaught(event) || Schema.is(APP_ROUTE[request.app])(event.route),
  );

/** A batch of an app's events, sent as the signed-in person to `POST /api/app-events`. */
export const AppEventsRequest = Schema.Struct({
  platform: ClientPlatform,
  app: AppName,
  release: AppRelease,
  bundle: BundleOrigin,
  /** The app runs development JavaScript, whose timings run several times slower than a release's. */
  development: Schema.Boolean,
  events: Schema.Array(QueuedAppEvent).check(Schema.isBetweenLength(1, MAX_APP_EVENTS)),
}).check(Schema.makeFilter(routesAreTheApps, { title: "each error names its own app's route" }));

/** A batch of an app's events. */
export interface AppEventsRequest extends Schema.Schema.Type<typeof AppEventsRequest> {}

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
  /** Audio/video drift. */
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
