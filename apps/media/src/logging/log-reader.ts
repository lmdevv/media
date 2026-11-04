/**
 * Reads the retained log for a query: the last `limit` matching records, newest file first so a
 * recent question never reads the whole history, then, when following, each new matching line as
 * it is written. Files outside the query's time window are skipped by their names and modification
 * times; a modification time counts as up to two seconds early, since network shares and FAT keep
 * it that coarsely. Each line is redacted again before it is decoded or matched, so a file written by anything
 * else never shows, and a `grep` never finds, what the console would hide.
 */
import type { LogQuery, LogRecord } from "@media/contracts/diagnostics";
import { Effect, FileSystem, Option, Path, Stream } from "effect";

import { redactJsonText } from "../observability.ts";
import { isNotFound } from "../platform/file-info.ts";
import type { LogFile } from "./log-files.ts";
import { decodeRecord, matchesFields, matchesText, mayMatch } from "./log-query.ts";
import * as RetainedLogs from "./retained-logs.ts";

const DEFAULT_LOG_LIMIT = 500;

/** One matching line and its record. */
export interface Match {
  readonly line: string;
  readonly record: LogRecord;
}

interface Found {
  readonly matches: ReadonlyArray<Match>;
  readonly truncated: boolean;
  readonly live: Stream.Stream<string>;
  readonly unavailableSince: Option.Option<number>;
}

const MODIFIED_AT_SLACK_MS = 2000;

const overlaps = (file: LogFile, query: LogQuery): boolean =>
  (query.since === undefined || file.modifiedAt + MODIFIED_AT_SLACK_MS >= query.since) &&
  (query.until === undefined || file.startsAt < query.until);

/** Which records count, beyond the query; every record when omitted. */
export type Keep = (record: LogRecord) => boolean;

const keepAll: Keep = () => true;

const matchLine = (query: LogQuery, keep: Keep, line: string): Option.Option<Match> => {
  if (
    !mayMatch(query, line) ||
    !Option.exists(decodeRecord(line), (raw) => keep(raw) && matchesFields(query, raw, line))
  ) {
    return Option.none();
  }

  const redacted = redactJsonText(line);

  return decodeRecord(redacted).pipe(
    Option.filter(
      (record) =>
        keep(record) && matchesText(query, redacted) && matchesFields(query, record, redacted),
    ),
    Option.map((record) => ({ line: redacted, record })),
  );
};

const nothingFound = () => ({ kept: Array.of<Match>(), total: 0 });

/**
 * Reads the retained log for `query`, counting only records `keep` accepts toward its limit;
 * following lasts as long as the scope.
 */
export const read = Effect.fn("LogReader.read")(function* (query: LogQuery, keep: Keep = keepAll) {
  const retained = yield* RetainedLogs.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const limit = query.limit ?? DEFAULT_LOG_LIMIT;
  const snapshot = yield* retained.snapshot;
  const files = snapshot.files.filter((file) => overlaps(file, query)).toReversed();

  const lastMatches = (file: LogFile) =>
    fs.stream(path.join(snapshot.directory, file.name), { bytesToRead: file.sizeBytes }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => matchLine(query, keep, line)),
      Stream.filter(Option.isSome),
      Stream.runFold(
        () => ({ kept: Array.of<Match>(), total: 0 }),
        (state, match) => {
          state.kept.push(match.value);

          if (state.kept.length > limit) state.kept.shift();

          return { kept: state.kept, total: state.total + 1 };
        },
      ),
      Effect.catchIf(isNotFound, () => Effect.sync(nothingFound)),
      Effect.catch((error) =>
        Effect.logWarning("LogReader.unreadable").pipe(
          Effect.annotateLogs({ file: file.name, error: error.message }),
          Effect.map(nothingFound),
        ),
      ),
    );

  const collected: Array<Match> = [];
  let total = 0;
  let index = 0;

  while (index < files.length && total < limit) {
    const file = files[index];

    if (file !== undefined) {
      const scanned = yield* lastMatches(file);

      collected.unshift(...scanned.kept);
      total += scanned.total;
    }

    index += 1;
  }

  const found: Found = {
    matches: collected.slice(-limit),
    truncated: total > limit || index < files.length,
    live:
      query.follow === true
        ? Stream.fromSubscription(snapshot.live).pipe(
            Stream.map((line) => matchLine(query, keep, line)),
            Stream.filter(Option.isSome),
            Stream.map((match) => match.value.line),
          )
        : Stream.empty,
    unavailableSince: snapshot.unavailableSince,
  };

  return found;
});
