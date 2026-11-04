import {
  atLeast,
  type ClientPlatform,
  type DiagnosedSession,
  type DiagnosticsCounts,
  type Drift,
  type DriftSummary,
  type LogRecord,
  type PlaybackDiagnostics,
  type TimelineEntry,
  type TimelineKind,
  summarizeDrift,
} from "@media/contracts/diagnostics";
import { PlaybackSessionId, UserId } from "@media/contracts/ids";
import { EpochMillis } from "@media/contracts/units";
import { LogLevel, Option, Predicate, type Schema } from "effect";

import type { StreamEndReason } from "../playback/playback-reporter.ts";
import { LogEvent, SLOW_MS } from "./log-events.ts";

type Annotations = LogRecord["annotations"];

interface Rule {
  readonly kind: TimelineKind;
  readonly source: TimelineEntry["source"];
  readonly summary: (fields: Annotations) => string;
  readonly keep?: (fields: Annotations) => boolean;
}

const text = (value: Schema.Json | undefined): string =>
  value === undefined || value === null
    ? "?"
    : Predicate.isString(value)
      ? value
      : JSON.stringify(value);

const number = (value: Schema.Json | undefined): number => (Predicate.isNumber(value) ? value : 0);

const duration = (value: Schema.Json | undefined): string => {
  const ms = number(value);

  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
};

const plural = (count: number, one: string): string =>
  `${String(count)} ${one}${count === 1 ? "" : "s"}`;

const medianOf = (values: readonly [number, ...Array<number>]): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};

const pad = (part: number): string => String(part).padStart(2, "0");

const position = (value: Schema.Json | undefined): string => {
  const total = Math.max(0, Math.floor(number(value)));

  return `${String(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

const STALL_ENDINGS = new Map([
  ["playing", "playing again"],
  ["paused", "paused by the viewer"],
  ["closed", "the player closed"],
]);

const STARTUP_ENDINGS = new Map([
  ["paused", "the viewer paused"],
  ["closed", "the player closed"],
]);

const STARTUP_STAGES = [
  ["negotiatedMs", "negotiated"],
  ["manifestLoadedMs", "playlist"],
  ["firstFragmentMs", "first segment"],
  ["firstFrameMs", "first frame"],
] as const;

const stagesOf = (fields: Annotations): string => {
  const known = STARTUP_STAGES.flatMap(([field, label]) =>
    Predicate.isNumber(fields[field]) ? [`${label} ${duration(fields[field])}`] : [],
  );

  return known.length === 0 ? "" : `; from play intent: ${known.join(", ")}`;
};

const audioOf = (fields: Annotations): string =>
  Predicate.isString(fields["audioCodec"])
    ? `; audio ${fields["audioCodec"]} ${text(fields["audioChannels"])} ch${Predicate.isString(fields["audioLanguage"]) ? `, ${fields["audioLanguage"]}` : ""}`
    : "";

const STREAM_END_REASONS: Record<StreamEndReason, string> = {
  expired: "nothing used it and every playback token that reached it had expired",
  unattended:
    "no playback session reports reached the service and nothing used the stream for ten idle periods",
  "resume-refused": "its player came back while no slot or transcode space was free",
  replaced: "a newer negotiation on the same device replaced it",
  stopped: "the player stopped it",
  abandoned: "the player went away before the first segment",
  failed: "the encoder failed",
  shutdown: "the media service shut down",
  "session-ended": "the playback session ended",
};

const RETIRED_END_REASONS = {
  idle: "no requests for STREAM_IDLE_SECONDS, so the service closed it",
};

const END_REASON_TEXTS: ReadonlyMap<string, string> = new Map(
  Object.entries({ ...STREAM_END_REASONS, ...RETIRED_END_REASONS }),
);

const age = (value: Schema.Json | undefined): string => {
  const ms = number(value);

  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : duration(ms);
};

const progressAge = (value: Schema.Json | undefined): string =>
  Predicate.isNumber(value) ? `${age(value)} ago` : "never";

const usage = (fields: Annotations): string =>
  `${text(fields["liveness"])}, last request ${age(fields["lastRequestAgeMs"])} ago, last progress ${progressAge(fields["lastProgressAgeMs"])}`;

const REFUSALS = new Map<string, (fields: Annotations) => string>([
  ["TranscodeCapacityReached", (fields) => `every ${text(fields["slots"])} slot is taken`],
  ["InsufficientTranscodeSpace", () => "the transcode folder is out of space"],
]);

const RULES = new Map<string, Rule>([
  [
    LogEvent.streamStarted,
    {
      kind: "stream-started",
      source: "server",
      summary: (fields) =>
        Predicate.isString(fields["streamId"])
          ? `HLS stream started (${text(fields["mode"])})`
          : `Direct play (${text(fields["mode"])})`,
    },
  ],
  [
    LogEvent.streamMoved,
    {
      kind: "stream-moved",
      source: "server",
      summary: (fields) =>
        `Encoder restarted at ${position(fields["fromSeconds"])} (generation ${text(fields["generation"])})`,
    },
  ],
  [
    LogEvent.streamReleased,
    {
      kind: "stream-moved",
      source: "server",
      summary: (fields) =>
        `Encoder stopped: ${usage(fields)}; the stream stays and restarts on the next request`,
    },
  ],
  [
    LogEvent.streamResumed,
    {
      kind: "stream-moved",
      source: "server",
      summary: (fields) =>
        `Encoder restarted at ${position(fields["fromSeconds"])} (generation ${text(fields["generation"])}) after ${age(fields["releasedForMs"])} stopped`,
    },
  ],
  [
    LogEvent.resumeRefused,
    {
      kind: "stream-moved",
      source: "server",
      summary: (fields) =>
        `Encoder not restarted for segment ${text(fields["segment"])}: ${REFUSALS.get(text(fields["reason"]))?.(fields) ?? text(fields["reason"])}; the stream closes and the player negotiates again`,
    },
  ],
  [
    LogEvent.streamEnded,
    {
      kind: "stream-ended",
      source: "server",
      summary: (fields) => {
        const reason = text(fields["reason"]);
        const why = END_REASON_TEXTS.get(reason);
        const used = Predicate.isString(fields["liveness"]) ? ` (${usage(fields)})` : "";

        return `Stream ended: ${reason}${why === undefined ? "" : `, ${why}`}${used}`;
      },
    },
  ],
  [
    LogEvent.modeChanged,
    {
      kind: "mode-changed",
      source: "server",
      summary: (fields) =>
        `Switched from ${text(fields["from"])} to ${text(fields["to"])}: ${text(fields["reason"])}`,
    },
  ],
  [
    LogEvent.encoderFailed,
    {
      kind: "encoder-failed",
      source: "server",
      summary: (fields) => `Encoder failed in ${text(fields["mode"])}`,
    },
  ],
  [
    LogEvent.slowSegment,
    {
      kind: "slow-segment",
      source: "server",
      summary: (fields) =>
        `Segment ${text(fields["segment"])} took ${duration(fields["elapsedMs"])}: encoder ${duration(fields["encoderWaitMs"])}, disk ${duration(fields["diskReadMs"])}, network ${duration(fields["networkWriteMs"])}${fields["completed"] === false ? ", cut off by the player" : ""}`,
    },
  ],
  [
    LogEvent.requestFailed,
    {
      kind: "request-failed",
      source: "server",
      summary: (fields) =>
        `${text(fields["route"])} request failed with ${text(fields["status"])}${Predicate.isString(fields["error"]) ? `: ${fields["error"]}` : ""}`,
    },
  ],
  [
    LogEvent.playerAttached,
    {
      kind: "player-attached",
      source: "player",
      summary: (fields) =>
        `Player attached: ${text(fields["engine"])} on ${text(fields["platform"])}, ${text(fields["mode"])}${audioOf(fields)}`,
    },
  ],
  [
    LogEvent.startupEnded,
    {
      kind: "startup",
      source: "player",
      summary: (fields) => {
        const ending = STARTUP_ENDINGS.get(text(fields["endedBy"]));

        return `${
          ending === undefined
            ? `Started playing after ${duration(fields["startupMs"])}`
            : `Waited ${duration(fields["startupMs"])} to start, then ${ending}`
        }${stagesOf(fields)}`;
      },
    },
  ],
  [
    LogEvent.bufferingStarted,
    {
      kind: "buffering-started",
      source: "player",
      summary: (fields) =>
        `Buffering at ${position(fields["positionSeconds"])} with ${number(fields["bufferedAheadSeconds"]).toFixed(1)} s buffered ahead`,
    },
  ],
  [
    LogEvent.bufferingEnded,
    {
      kind: "buffering-ended",
      source: "player",
      summary: (fields) =>
        `Stalled ${duration(fields["stalledMs"])}, then ${STALL_ENDINGS.get(text(fields["endedBy"])) ?? "playing again"}`,
    },
  ],
  [
    LogEvent.playerError,
    {
      kind: "player-error",
      source: "player",
      summary: (fields) =>
        `${text(fields["errorSource"])} ${fields["fatal"] === true ? "fatal " : ""}error ${text(fields["kind"])}${Predicate.isNumber(fields["status"]) ? ` (HTTP ${text(fields["status"])})` : ""}: ${text(fields["detail"])}`,
    },
  ],
  [
    LogEvent.droppedFrames,
    {
      kind: "dropped-frames",
      source: "player",
      summary: (fields) =>
        `Dropped ${text(fields["dropped"])} of ${text(fields["decoded"])} frames`,
    },
  ],
  [
    LogEvent.fragmentLoaded,
    {
      kind: "slow-fragment",
      source: "player",
      keep: (fields) => number(fields["elapsedMs"]) >= SLOW_MS,
      summary: (fields) =>
        `Segment ${text(fields["segment"])} loaded in ${duration(fields["elapsedMs"])}, first byte after ${duration(fields["firstByteMs"])}`,
    },
  ],
  [
    LogEvent.recovery,
    {
      kind: "recovery",
      source: "player",
      summary: (fields) => `Recovery: ${text(fields["action"])} (${text(fields["reason"])})`,
    },
  ],
]);

const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  "sessionId",
  "userId",
  "source",
  "occurredAt",
  "streamId",
]);

const occurredAt = (record: LogRecord): Option.Option<number> => {
  const reported = record.annotations["occurredAt"];
  const time = Date.parse(Predicate.isString(reported) ? reported : record.timestamp);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

const messageOf = (record: LogRecord): string =>
  Predicate.isString(record.message) ? record.message : "";

const entryOf = (record: LogRecord): Option.Option<TimelineEntry> => {
  const rule = RULES.get(messageOf(record));
  const fields = record.annotations;

  if (rule === undefined || (rule.keep !== undefined && !rule.keep(fields))) return Option.none();

  return Option.map(occurredAt(record), (at) => ({
    at: EpochMillis.make(at),
    source: rule.source,
    kind: rule.kind,
    level: record.level,
    streamId: Predicate.isString(fields["streamId"]) ? fields["streamId"] : null,
    summary: rule.summary(fields),
    details: Object.fromEntries(
      Object.entries(fields).filter(([key]) => !IDENTITY_FIELDS.has(key)),
    ),
  }));
};

const countOf = (entries: ReadonlyArray<TimelineEntry>, kind: TimelineKind): number =>
  entries.filter((entry) => entry.kind === kind).length;

const sumOf = (entries: ReadonlyArray<TimelineEntry>, kind: TimelineKind, field: string): number =>
  entries
    .filter((entry) => entry.kind === kind)
    .reduce((total, entry) => total + number(entry.details[field]), 0);

const STREAM_KINDS: ReadonlySet<TimelineKind> = new Set([
  "stream-started",
  "stream-ended",
  "encoder-failed",
]);

const streamsOf = (entries: ReadonlyArray<TimelineEntry>): number =>
  entries.filter((entry) => entry.kind === "stream-started" && entry.streamId === null).length +
  new Set(
    entries.flatMap((entry) =>
      STREAM_KINDS.has(entry.kind) && entry.streamId !== null ? [entry.streamId] : [],
    ),
  ).size;

const neverStarted = (
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, string | undefined> => {
  const started = new Set(
    entries.flatMap((entry) => (entry.kind === "stream-started" ? [entry.streamId] : [])),
  );

  const ended = new Map<string, string | undefined>();

  for (const entry of entries) {
    if (entry.streamId === null || started.has(entry.streamId)) continue;

    if (entry.kind === "stream-ended") {
      ended.set(entry.streamId, END_REASON_TEXTS.get(text(entry.details["reason"])));
    } else if (entry.kind === "encoder-failed" && !ended.has(entry.streamId)) {
      ended.set(entry.streamId, STREAM_END_REASONS.failed);
    }
  }

  return ended;
};

const countsOf = (entries: ReadonlyArray<TimelineEntry>): DiagnosticsCounts => ({
  streams: streamsOf(entries),
  stalls: countOf(entries, "buffering-started"),
  stalledMs: sumOf(entries, "buffering-ended", "stalledMs"),
  slowSegments: countOf(entries, "slow-segment"),
  failedRequests: countOf(entries, "request-failed"),
  playerErrors: countOf(entries, "player-error"),
  recoveries: entries.filter(
    (entry) => entry.kind === "recovery" && entry.details["action"] !== "renew-token",
  ).length,
  slowFragments: countOf(entries, "slow-fragment"),
  droppedFrames: sumOf(entries, "dropped-frames", "dropped"),
});

const isPlatform = (value: Schema.Json | undefined): value is ClientPlatform =>
  value === "web" || value === "ios";

const platformOf = (records: ReadonlyArray<LogRecord>): ClientPlatform | null =>
  records.map((record) => record.annotations["platform"]).find(isPlatform) ?? null;

interface Keeping {
  readonly fromPlayer: boolean;
  readonly unplacedLoads: number;
  readonly truncated: boolean;
  readonly logLevel: LogLevel.LogLevel;
  readonly suppressedFailures: number;
}

const missingEvidence = (
  entries: ReadonlyArray<TimelineEntry>,
  platform: ClientPlatform | null,
  { fromPlayer, unplacedLoads, truncated, logLevel, suppressedFailures }: Keeping,
): ReadonlyArray<string> => {
  const dropsInfo = LogLevel.isGreaterThan(logLevel, "Info");

  const engines = new Set(
    entries.flatMap((entry) =>
      entry.kind === "player-attached" ? [text(entry.details["engine"])] : [],
    ),
  );

  const direct = entries.some(
    (entry) => entry.kind === "stream-started" && entry.streamId === null,
  );

  return [
    ...(truncated
      ? [
          "Only the latest records fit in one timeline; earlier events of this session are left out.",
        ]
      : []),
    ...(dropsInfo
      ? [
          `The media service logs at ${logLevel.toUpperCase()} and above (LOG_LEVEL=${logLevel.toLowerCase()}), so it keeps no INFO records: stream starts, player attaches, startups, the start of each stall, and stalls under a second are missing. Set LOG_LEVEL=info to keep them.`,
        ]
      : []),
    ...(suppressedFailures > 0
      ? [
          `${String(suppressedFailures)} more failed requests were counted, not logged one by one: the session went past its budget of failure records.`,
        ]
      : []),
    ...(dropsInfo || streamsOf(entries) > 0
      ? []
      : [
          "No stream started in the retained logs: the session began before the oldest log file (LOG_RETENTION_DAYS) or never reached this media service.",
        ]),
    ...(dropsInfo || truncated
      ? []
      : [...neverStarted(entries)].map(
          ([streamId, why]) =>
            `Stream ${streamId} never started${why === undefined ? "" : `: ${why}`}. Its entries below are all the log holds of it.`,
        )),
    ...(fromPlayer || dropsInfo
      ? []
      : [
          "The player sent no diagnostics: an app from before diagnostics, a player that does not report them (mpv or VLC through media play), or events lost on the way. Stalls and player errors are unknown.",
        ]),
    ...(direct
      ? ["Direct play serves byte ranges, which are not timed; only failed requests show."]
      : []),
    ...(fromPlayer && !engines.has("hls.js")
      ? ["Segment load times come from hls.js only; this player does not report them."]
      : []),
    ...(platform === "ios" ? ["Dropped frames: AVPlayer does not report them."] : []),
    ...(unplacedLoads > 0
      ? [
          `The player reported ${plural(unplacedLoads, "segment load")} during startup but no startup that ended, so they are not shown.`,
        ]
      : []),
  ];
};

interface SegmentLoad {
  readonly index: number;
  readonly segment: number;
  readonly elapsedMs: number;
  readonly firstByteMs: number;
  readonly bytes: number;
}

interface StartupLoad {
  readonly at: number;
  readonly streamId: string | null;
  readonly load: SegmentLoad;
}

const DRIFT_METHOD =
  "video frame against the media clock; negative means the picture trails the sound";

const finite = (value: Schema.Json | undefined): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value);

const driftWindowsOf = (records: ReadonlyArray<LogRecord>): ReadonlyArray<DriftSummary> =>
  records.flatMap((record) => {
    const { samples, medianMs, worstMs } = record.annotations;

    return messageOf(record) === LogEvent.driftSampled &&
      finite(samples) &&
      finite(medianMs) &&
      finite(worstMs)
      ? [{ samples, medianMs, worstMs }]
      : [];
  });

const driftOf = (
  windows: ReadonlyArray<DriftSummary>,
  platform: ClientPlatform | null,
  fromPlayer: boolean,
  logLevel: LogLevel.LogLevel,
): Drift => {
  const [first, ...rest] = windows;

  if (first !== undefined) {
    return {
      status: "measured",
      method: "video-frame-vs-media-clock",
      samples: windows.reduce((total, window) => total + window.samples, 0),
      medianMs: medianOf([first.medianMs, ...rest.map((window) => window.medianMs)]),
      worstMs: summarizeDrift([first.worstMs, ...rest.map((window) => window.worstMs)]).worstMs,
    };
  }

  const reason =
    platform === "ios"
      ? "AVPlayer through expo-video exposes neither the times of the frames it shows nor its audio clock, so the iOS app cannot measure audio/video drift."
      : LogLevel.isGreaterThan(logLevel, "Info")
        ? `The media service logs at ${logLevel.toUpperCase()} and above (LOG_LEVEL=${logLevel.toLowerCase()}), so it keeps no drift samples, which are INFO records.`
        : fromPlayer
          ? "The browser sent no drift samples: it lacks requestVideoFrameCallback, it never played for 10 s, or the web app predates drift sampling."
          : "The player sent no diagnostics, so drift is not measured. Stalls, dropped frames, encoder restarts, and stream changes around the time it was noticed are the evidence available.";

  return { status: "not-measured", reason };
};

/** `drift` as a caller decodes it: measured only when it sent `measuredDrift`. */
export const driftFor = (drift: Drift, measuredDrift: boolean): Drift =>
  drift.status === "not-measured" || measuredDrift
    ? drift
    : {
        status: "not-measured",
        reason: `This client predates measured drift; update it to see it. The player sampled it ${drift.samples === 1 ? "once" : `${String(drift.samples)} times`}: median ${String(drift.medianMs)} ms, worst ${String(drift.worstMs)} ms (${DRIFT_METHOD}).`,
      };

const startupLoadsOf = (records: ReadonlyArray<LogRecord>): ReadonlyArray<StartupLoad> =>
  records
    .flatMap((record) => {
      const { index, segment, elapsedMs, firstByteMs, bytes, startup, streamId } =
        record.annotations;

      return messageOf(record) === LogEvent.fragmentLoaded && startup === true && finite(index)
        ? Option.toArray(occurredAt(record)).map((at) => ({
            at,
            streamId: Predicate.isString(streamId) ? streamId : null,
            load: {
              index,
              segment: number(segment),
              elapsedMs: number(elapsedMs),
              firstByteMs: number(firstByteMs),
              bytes: number(bytes),
            },
          }))
        : [];
    })
    .toSorted((left, right) => left.load.index - right.load.index);

const loadsSummary = (loads: ReadonlyArray<SegmentLoad>): string => {
  const [first, ...rest] = loads;

  if (first === undefined) return "";

  const slowest = rest.reduce(
    (worst, load) => (load.elapsedMs > worst.elapsedMs ? load : worst),
    first,
  );

  const median = medianOf([first.elapsedMs, ...rest.map((load) => load.elapsedMs)]);

  return `; first ${plural(loads.length, "segment load")}: median ${duration(median)}, slowest ${duration(slowest.elapsedMs)} (segment ${String(slowest.segment)})`;
};

interface PlacedLoads {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly placed: boolean;
}

/**
 * Puts the session's first segment loads on its first startup entry, so `startup` stays one entry
 * per startup: only loads of that entry's stream up to when it ended, since a player that seeks or
 * changes stream before its numbering stops loads segments that are no part of the startup.
 * `placed` is false when there is no startup entry to hold them.
 */
const withStartupLoads = (
  entries: ReadonlyArray<TimelineEntry>,
  startupLoads: ReadonlyArray<StartupLoad>,
): PlacedLoads => {
  const at = entries.findIndex((entry) => entry.kind === "startup");
  const startup = entries[at];

  if (startup === undefined) return { entries, placed: startupLoads.length === 0 };

  const loads = startupLoads.flatMap((each) =>
    each.streamId === startup.streamId && each.at <= startup.at ? [each.load] : [],
  );

  if (loads.length === 0) return { entries, placed: true };

  return {
    entries: entries.with(at, {
      at: startup.at,
      source: startup.source,
      kind: startup.kind,
      level: startup.level,
      streamId: startup.streamId,
      summary: `${startup.summary}${loadsSummary(loads)}`,
      details: {
        ...startup.details,
        segmentLoads: loads.map(({ index, segment, elapsedMs, firstByteMs, bytes }) => ({
          index,
          segment,
          elapsedMs,
          firstByteMs,
          bytes,
        })),
      },
    }),
    placed: true,
  };
};

/**
 * The timeline of session `sessionId` from its records, oldest first; none when no record names a
 * playback event. `truncated` says the records are only the latest of more, and `logLevel` is the
 * least severe level the service logs, which decides what the records can hold.
 */
export const timelineOf = (
  sessionId: PlaybackSessionId,
  records: ReadonlyArray<LogRecord>,
  truncated: boolean,
  logLevel: LogLevel.LogLevel = "Info",
): Option.Option<PlaybackDiagnostics> => {
  const loads = startupLoadsOf(records);

  const { entries, placed } = withStartupLoads(
    records
      .flatMap((record) => Option.toArray(entryOf(record)))
      .toSorted((left, right) => left.at - right.at),
    loads,
  );

  const first = entries[0];
  const last = entries.at(-1);

  if (first === undefined || last === undefined) return Option.none();
  const platform = platformOf(records);
  const windows = driftWindowsOf(records);
  const fromPlayer = windows.length > 0 || entries.some((entry) => entry.source === "player");

  return Option.some({
    sessionId,
    firstSeenAt: first.at,
    lastSeenAt: last.at,
    platform,
    counts: countsOf(entries),
    drift: driftOf(windows, platform, fromPlayer, logLevel),
    missing: missingEvidence(entries, platform, {
      fromPlayer,
      unplacedLoads: placed ? 0 : loads.length,
      truncated,
      logLevel,
      suppressedFailures: records
        .filter((record) => messageOf(record) === LogEvent.requestFailuresSuppressed)
        .reduce((total, record) => total + number(record.annotations["failures"]), 0),
    }),
    truncated,
    entries,
  });
};

/** The accounts `records` name, from their `userId` annotations. */
export const ownersOf = (records: ReadonlyArray<LogRecord>): ReadonlySet<string> =>
  new Set(
    records.flatMap((record) => {
      const userId = record.annotations["userId"];

      return Predicate.isString(userId) ? [userId] : [];
    }),
  );

/** The playback sessions `records` mention, most recently seen first. */
export const sessionsOf = (records: ReadonlyArray<LogRecord>): ReadonlyArray<DiagnosedSession> => {
  const sessions = new Map<string, DiagnosedSession>();

  for (const record of records) {
    const sessionId = record.annotations["sessionId"];
    const at = occurredAt(record);

    if (!Predicate.isString(sessionId) || Option.isNone(at)) continue;
    const userId = record.annotations["userId"];
    const platform = record.annotations["platform"];
    const seen = sessions.get(sessionId);
    const warning = atLeast(record.level, "WARN") ? 1 : 0;

    sessions.set(sessionId, {
      sessionId: PlaybackSessionId.make(sessionId),
      userId: seen?.userId ?? (Predicate.isString(userId) ? UserId.make(userId) : null),
      firstSeenAt: EpochMillis.make(Math.min(seen?.firstSeenAt ?? at.value, at.value)),
      lastSeenAt: EpochMillis.make(Math.max(seen?.lastSeenAt ?? at.value, at.value)),
      platform: seen?.platform ?? (isPlatform(platform) ? platform : null),
      warnings: (seen?.warnings ?? 0) + warning,
    });
  }

  return [...sessions.values()].toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);
};
