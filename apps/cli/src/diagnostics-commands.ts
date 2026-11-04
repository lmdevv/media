import { commands } from "@media/contracts/commands";
import {
  type DiagnosedSession,
  LOG_LEVELS,
  MAX_LOG_LIMIT,
  type LogLevel,
  type LogQuery,
  LogRecord,
  type PlaybackDiagnostics,
} from "@media/contracts/diagnostics";
import { PlaybackSessionId } from "@media/contracts/ids";
import { EpochMillis } from "@media/contracts/units";
import { TransportError } from "@media/sdk/effect";
import { Clock, Effect, Option, Predicate, Schema, Stream } from "effect";

import type { ShortcutCommand, Invocation } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  Outcome,
  positionalText,
  stringFlag,
  textOutcome,
  usage,
} from "./invocation";
import { Output } from "./output";
import { connect } from "./session";

const UNITS: ReadonlyMap<string, number> = new Map([
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

/** `500ms`, `90s`, `10m`, `2h`, or `1d` in milliseconds; none for anything else. */
export const parseDuration = (text: string): Option.Option<number> => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/u.exec(text.trim());
  const unit = UNITS.get(match?.[2] ?? "");

  return match === null || unit === undefined
    ? Option.none()
    : Option.some(Math.round(Number(match[1]) * unit));
};

/**
 * An instant from a flag: a duration before `now` (`15m` is fifteen minutes ago) or a date and
 * time JavaScript reads, such as `2026-10-21T14:00:00Z` or `2026-10-21 14:00` in local time.
 */
export const parseInstant = (text: string, now: number): Option.Option<EpochMillis> =>
  Option.orElse(
    Option.map(parseDuration(text), (ago) => now - ago),
    () => {
      const time = Date.parse(text.trim());

      return Number.isNaN(time) ? Option.none() : Option.some(time);
    },
  ).pipe(Option.flatMap((time) => EpochMillis.makeOption(Math.max(0, Math.round(time)))));

const isLevel = (value: string): value is LogLevel => LOG_LEVELS.some((level) => level === value);

/** `warn`, `WARN`, or `warning` as a log level. */
export const parseLevel = (text: string): Option.Option<LogLevel> => {
  const upper = text.trim().toUpperCase();
  const level = upper === "WARNING" ? "WARN" : upper;

  return isLevel(level) ? Option.some(level) : Option.none();
};

const pad = (part: number, width = 2): string => String(part).padStart(width, "0");

const clockTime = (time: number): string => {
  const date = new Date(time);

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

const printable = (text: string): string =>
  text.replaceAll(
    UNPRINTABLE,
    (control) => String.raw`\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/**
 * A value as a `key=value` part: strings with spaces, quotes, or control characters quoted as
 * JSON, everything else as JSON, and both `printable`: JSON leaves DEL and C1 controls raw.
 */
const fieldValue = (value: Schema.Json): string =>
  printable(
    Predicate.isString(value) && !/[\s"=\p{Cc}]/u.test(value) ? value : JSON.stringify(value),
  );

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

/**
 * One retained log line for people: local time, level, event, and its fields as `key=value`, with
 * a failure's cause indented below. A line that is not a record prints as it is.
 */
export const formatLogLine = (line: string): string =>
  Option.match(decodeRecord(line), {
    onNone: () => printable(line),
    onSome: (record) => {
      const time = Date.parse(record.timestamp);

      const message = printable(
        Predicate.isString(record.message) ? record.message : JSON.stringify(record.message),
      );

      const fields = Object.entries(record.annotations)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${printable(key)}=${fieldValue(value)}`);

      const head = [
        Number.isNaN(time) ? printable(record.timestamp) : clockTime(time),
        record.level.padEnd(5),
        message,
        ...fields,
      ].join(" ");

      return record.cause === undefined
        ? head
        : `${head}\n${record.cause
            .split("\n")
            .map((causeLine) => `    ${printable(causeLine)}`)
            .join("\n")}`;
    },
  });

const logQuery = Effect.fn("Logs.query")(function* (invocation: Invocation) {
  const { tokens } = invocation;
  const now = yield* Clock.currentTimeMillis;

  const instant = (flag: string) =>
    Option.match(stringFlag(tokens, flag), {
      onNone: () => Effect.succeedNone,
      onSome: (raw) =>
        Option.match(parseInstant(raw, now), {
          onNone: () =>
            Effect.fail(
              usage(invocation, `--${flag} expects a duration such as 15m or a time, got "${raw}"`),
            ),
          onSome: Effect.succeedSome,
        }),
    });

  const since = yield* instant("since");
  const until = yield* instant("until");
  const follow = booleanFlag(tokens, "follow");

  if (follow && Option.isSome(until)) {
    return yield* usage(invocation, "--follow has no end: drop --until");
  }

  if (Option.isSome(since) && Option.isSome(until) && since.value >= until.value) {
    return yield* usage(invocation, "--since must be before --until");
  }

  const level = yield* Option.match(stringFlag(tokens, "level"), {
    onNone: () => Effect.succeedNone,
    onSome: (raw) =>
      Option.match(parseLevel(raw), {
        onNone: () =>
          Effect.fail(
            usage(
              invocation,
              `--level must be trace, debug, info, warn, error, or fatal, got "${raw}"`,
            ),
          ),
        onSome: Effect.succeedSome,
      }),
  });

  const slow = yield* Option.match(stringFlag(tokens, "slow"), {
    onNone: () => Effect.succeedNone,
    onSome: (raw) =>
      Option.match(parseDuration(raw), {
        onNone: () =>
          Effect.fail(usage(invocation, `--slow expects a duration such as 1s, got "${raw}"`)),
        onSome: Effect.succeedSome,
      }),
  });

  const limit = yield* Option.match(stringFlag(tokens, "limit"), {
    onNone: () => Effect.succeedNone,
    onSome: (raw) => {
      const value = Number(raw);

      return Number.isInteger(value) && value >= 1 && value <= MAX_LOG_LIMIT
        ? Effect.succeedSome(value)
        : Effect.fail(
            usage(
              invocation,
              `--limit expects a whole number from 1 to ${String(MAX_LOG_LIMIT)}, got "${raw}"`,
            ),
          );
    },
  });

  const query: LogQuery = {
    follow,
    ...Option.match(since, { onNone: () => ({}), onSome: (value) => ({ since: value }) }),
    ...Option.match(until, { onNone: () => ({}), onSome: (value) => ({ until: value }) }),
    ...Option.match(level, { onNone: () => ({}), onSome: (value) => ({ level: value }) }),
    ...Option.match(slow, { onNone: () => ({}), onSome: (value) => ({ slowMs: value }) }),
    ...Option.match(limit, { onNone: () => ({}), onSome: (value) => ({ limit: value }) }),
    ...Option.match(stringFlag(tokens, "session-id"), {
      onNone: () => ({}),
      onSome: (value) => ({ sessionId: PlaybackSessionId.make(value) }),
    }),
    ...Option.match(stringFlag(tokens, "stream-id"), {
      onNone: () => ({}),
      onSome: (value) => ({ streamId: value }),
    }),
    ...Option.match(stringFlag(tokens, "grep"), {
      onNone: () => ({}),
      onSome: (value) => ({ grep: value }),
    }),
  };

  return query;
});

const printsJson = (invocation: Invocation): boolean =>
  booleanFlag(invocation.tokens, "json") ||
  Option.contains(stringFlag(invocation.tokens, "format"), "json");

const logs: ShortcutCommand = {
  path: "logs",
  options: {
    follow: { type: "boolean", short: "f" },
    since: { type: "string" },
    until: { type: "string" },
    level: { type: "string" },
    "session-id": { type: "string" },
    "stream-id": { type: "string" },
    slow: { type: "string" },
    grep: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const output = yield* Output;
      const query = yield* logQuery(invocation);
      const json = printsJson(invocation);
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const found = yield* connection.withSession(connection.client.logs(query));

      if (Option.isSome(found.unavailableSince)) {
        yield* output.err(
          `The media service has not been able to write or read its retained log since ${clockTime(found.unavailableSince.value)}: records logged since then are on its standard output only.`,
        );
      }

      if (found.truncated) {
        yield* output.err(
          `Older records may match too: narrow it with --since or raise --limit (up to ${String(MAX_LOG_LIMIT)}).`,
        );
      }

      yield* Stream.runForEach(found.lines, (line) =>
        output.out(json ? line : formatLogLine(line)),
      );

      if (query.follow === true) {
        return yield* new TransportError({
          operation: "logs",
          message: "Transport failed during logs: the media service ended the followed log",
          cause: null,
        });
      }

      return Outcome.Printed();
    }),
};

const shortTime = (time: number): string => clockTime(time).slice(0, 19);

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

const driftLine = (drift: PlaybackDiagnostics["drift"]): string =>
  drift.status === "measured"
    ? `Audio/video drift: median ${String(drift.medianMs)} ms, worst ${String(drift.worstMs)} ms over ${plural(drift.samples, "sample")} (video frame against the media clock; negative means the picture trails the sound)`
    : `Audio/video drift: not measured. ${printable(drift.reason)}`;

/** The timeline for people: a summary, what is not known, then one line per event. */
export const renderTimeline = (diagnostics: PlaybackDiagnostics): string => {
  const { counts } = diagnostics;

  return [
    `Playback session ${printable(diagnostics.sessionId)}${diagnostics.platform === null ? "" : ` (${diagnostics.platform})`}`,
    `${shortTime(diagnostics.firstSeenAt)} to ${shortTime(diagnostics.lastSeenAt)}`,
    [
      plural(counts.streams, "stream"),
      `${plural(counts.stalls, "stall")} (${seconds(counts.stalledMs)})`,
      plural(counts.slowSegments, "slow segment"),
      plural(counts.failedRequests, "failed request"),
      plural(counts.playerErrors, "player error"),
      plural(counts.recoveries, "recovery", "recoveries"),
      plural(counts.slowFragments, "slow segment load"),
      plural(counts.droppedFrames, "dropped frame"),
    ].join(", "),
    driftLine(diagnostics.drift),
    ...(diagnostics.missing.length === 0
      ? []
      : ["Missing evidence:", ...diagnostics.missing.map((gap) => `  - ${printable(gap)}`)]),
    "",
    ...diagnostics.entries.map((entry) =>
      [
        clockTime(entry.at).slice(11),
        entry.source.padEnd(6),
        entry.level.padEnd(5),
        entry.kind.padEnd(17),
        printable(entry.summary),
      ].join("  "),
    ),
  ].join("\n");
};

const renderSessions = (sessions: ReadonlyArray<DiagnosedSession>): string =>
  sessions.length === 0
    ? "No playback sessions in the retained logs for that time."
    : sessions
        .map((session) =>
          [
            printable(session.sessionId),
            shortTime(session.lastSeenAt),
            (session.platform ?? "-").padEnd(3),
            plural(session.warnings, "warning"),
            printable(session.userId ?? ""),
          ].join("  "),
        )
        .join("\n");

const playbackTimeline: ShortcutCommand = {
  path: "diagnostics playback",
  options: { json: { type: "boolean" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const sessionId = positionalText(invocation.tokens);

      if (Option.isNone(sessionId)) {
        return yield* usage(
          invocation,
          "diagnostics playback needs a session ID; media diagnostics sessions lists recent ones",
        );
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const diagnostics = yield* connection.withSession(
        connection.client.media("diagnostics.playback", {
          sessionId: PlaybackSessionId.make(sessionId.value),
          measuredDrift: true,
        }),
      );

      const json = yield* encodeResult(
        "diagnostics.playback",
        commands["diagnostics.playback"],
        diagnostics,
      );

      return textOutcome(json, renderTimeline(diagnostics));
    }),
};

const sessions: ShortcutCommand = {
  path: "diagnostics sessions",
  options: { since: { type: "string" }, json: { type: "boolean" } },
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const raw = stringFlag(invocation.tokens, "since");
      const since = Option.flatMap(raw, (text) => parseInstant(text, now));

      if (Option.isSome(raw) && Option.isNone(since)) {
        return yield* usage(
          invocation,
          `--since expects a duration such as 2d or a time, got "${raw.value}"`,
        );
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const found = yield* connection.withSession(
        connection.client.media(
          "diagnostics.sessions",
          Option.match(since, { onNone: () => ({}), onSome: (value) => ({ since: value }) }),
        ),
      );

      const json = yield* encodeResult(
        "diagnostics.sessions",
        commands["diagnostics.sessions"],
        found,
      );

      return textOutcome(json, renderSessions(found));
    }),
};

/** The troubleshooting shortcuts. */
export const diagnosticsCommands: ReadonlyArray<ShortcutCommand> = [
  logs,
  playbackTimeline,
  sessions,
];
