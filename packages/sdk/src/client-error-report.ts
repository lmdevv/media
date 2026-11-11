/**
 * An app's unexpected error as a report, and the gate that decides which reports go out: once per
 * `REPEAT_WINDOW_MS` for a repeated error, and none while the service's `Retry-After` lasts. This
 * module needs no client, so a client that only reports errors loads none of the command list.
 */
import {
  CLIENT_ERROR_LIMITS,
  type ClientErrorKind,
  type ClientErrorReport,
  type ClientPlatform,
} from "@media/contracts/diagnostics";
import type { PlaybackSessionId } from "@media/contracts/ids";
import { RequestId } from "@media/contracts/request-id";
import { Option, Predicate, Schema } from "effect";

import { decodeTagged } from "./media-http";

/** Where an app caught an error. */
export interface ErrorContext {
  readonly platform: ClientPlatform;
  readonly appVersion: string;
  readonly kind: ClientErrorKind;
  /** The path or screen the app showed, such as `/titles/abc`. */
  readonly route: string;
  /** The playback session playing then, when the app knows it. */
  readonly sessionId?: PlaybackSessionId;
}

/** How long an error that was sent is not sent again. */
export const REPEAT_WINDOW_MS = 30_000;

const MAX_REMEMBERED = 100;

const DEFAULT_PAUSE_SECONDS = 60;

const cut = (text: string, maxLength: number): string =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const bounded = (text: string, maxLength: number, fallback: string): string =>
  cut(text.length === 0 ? fallback : text, maxLength);

const decodeIdentity = Schema.decodeUnknownOption(Schema.Struct({ requestId: RequestId }));

const textOf = Option.liftThrowable(String);

const jsonOf = Option.liftThrowable(JSON.stringify);

const textField = Option.liftPredicate(Predicate.isString);

/**
 * `cause` as a report from `context`, with every text field cut to its bound. An SDK error is
 * named by its tag and keeps the media service request it failed.
 */
export const reportOf = (cause: unknown, context: ErrorContext): ClientErrorReport => {
  const error = cause instanceof Error ? Option.some(cause) : Option.none<Error>();

  const name = Option.firstSomeOf([
    Option.map(decodeTagged(cause), (tagged) => tagged.tag),
    Option.flatMap(error, (value) => textField(value.name)),
  ]).pipe(Option.getOrElse(() => "NonError"));

  const message = Option.match(error, {
    onNone: () =>
      Option.orElse(
        Predicate.isObject(cause) ? Option.flatMap(jsonOf(cause), textField) : Option.none(),
        () => textOf(cause),
      ),
    onSome: (value) => textField(value.message),
  }).pipe(Option.getOrElse(() => "A value that cannot be shown"));

  const stack = error.pipe(
    Option.flatMap((value) => textField(value.stack)),
    Option.filter((text) => text.length > 0),
  );

  return {
    platform: context.platform,
    appVersion: bounded(context.appVersion, CLIENT_ERROR_LIMITS.appVersion, "unknown"),
    kind: context.kind,
    route: bounded(context.route, CLIENT_ERROR_LIMITS.route, "/"),
    name: bounded(name, CLIENT_ERROR_LIMITS.name, "Error"),
    message: cut(message, CLIENT_ERROR_LIMITS.message),
    ...Option.match(stack, {
      onNone: () => ({}),
      onSome: (text) => ({ stack: cut(text, CLIENT_ERROR_LIMITS.stack) }),
    }),
    ...Option.match(decodeIdentity(cause), {
      onNone: () => ({}),
      onSome: ({ requestId }) => ({ requestId }),
    }),
    ...Option.match(
      Option.fromNullishOr(context.sessionId).pipe(
        Option.filter((id) => id.length <= CLIENT_ERROR_LIMITS.sessionId),
      ),
      {
        onNone: () => ({}),
        onSome: (sessionId) => ({ sessionId }),
      },
    ),
  };
};

/** Which reports go out, for one reporter. */
export interface ReportGate {
  /**
   * Whether `report` goes out at `now`: not while a refusal's pause lasts, and not when the same
   * error went out within `REPEAT_WINDOW_MS`. An admitted report counts as sent, failed or not.
   */
  readonly admits: (report: ClientErrorReport, now: number) => boolean;
  /** The service refused a report at `now` for its budget; send nothing for `retryAfterSeconds`. */
  readonly pause: (now: number, retryAfterSeconds: number | undefined) => void;
}

/** A gate with nothing sent yet and no pause. */
export const reportGate = (): ReportGate => {
  const sentAt = new Map<string, number>();
  const paused = { until: 0 };

  const isRepeat = (key: string, now: number): boolean => {
    for (const [seen, at] of sentAt) {
      if (now - at >= REPEAT_WINDOW_MS) sentAt.delete(seen);
    }

    if (sentAt.has(key)) return true;

    if (sentAt.size >= MAX_REMEMBERED) {
      const oldest = sentAt.keys().next();

      if (oldest.done !== true) sentAt.delete(oldest.value);
    }

    sentAt.set(key, now);

    return false;
  };

  return {
    admits: (report, now) =>
      now >= paused.until &&
      !isRepeat(
        `${report.kind}\u0000${report.name}\u0000${report.message}\u0000${report.route}`,
        now,
      ),
    pause: (now, retryAfterSeconds) => {
      paused.until = now + (retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS) * 1000;
    },
  };
};
