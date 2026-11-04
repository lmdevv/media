import { atLeast, type LogQuery, LogRecord } from "@media/contracts/diagnostics";
import { Option, Predicate, Schema } from "effect";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LogRecord));

/** The record on one log line; none for a line cut short by a crash or not written by the logger. */
export const decodeRecord = (line: string): Option.Option<LogRecord> => decodeLine(line);

const recordTime = (record: LogRecord): Option.Option<number> => {
  const time = Date.parse(record.timestamp);

  return Number.isNaN(time) ? Option.none() : Option.some(time);
};

/**
 * Whether `line` may match, judged from its text alone: cheap enough to run on every line before
 * redacting or decoding any, and never false for a line that `matches`. It leaves `grep` to
 * `matches`, which sees the line only once it is redacted.
 */
export const mayMatch = (query: LogQuery, line: string): boolean =>
  (query.sessionId === undefined || line.includes(query.sessionId)) &&
  (query.streamId === undefined || line.includes(query.streamId));

/** Whether `line`, already redacted, contains the query's `grep`, ignoring case. */
export const matchesText = (query: LogQuery, line: string): boolean =>
  query.grep === undefined || line.toLowerCase().includes(query.grep.toLowerCase());

/**
 * Whether `record`, read from `line`, matches every filter of `query` but `grep`: none of them can
 * change when the line is redacted.
 */
export const matchesFields = (query: LogQuery, record: LogRecord, line: string): boolean => {
  const { since, until, level, sessionId, streamId, slowMs } = query;
  const time = recordTime(record);
  const { annotations } = record;
  const elapsedMs = annotations["elapsedMs"];

  return (
    mayMatch(query, line) &&
    (since === undefined || Option.exists(time, (at) => at >= since)) &&
    (until === undefined || Option.exists(time, (at) => at < until)) &&
    (level === undefined || atLeast(record.level, level)) &&
    (sessionId === undefined || annotations["sessionId"] === sessionId) &&
    (streamId === undefined || annotations["streamId"] === streamId) &&
    (slowMs === undefined || (Predicate.isNumber(elapsedMs) && elapsedMs >= slowMs))
  );
};
