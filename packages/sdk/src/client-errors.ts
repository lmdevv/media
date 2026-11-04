/**
 * Apps' unexpected errors, such as a crashed screen or an unhandled rejection, written to the media
 * service's retained log so whoever runs the server can find them with `media logs`. Nothing is
 * sent while signed out, and an error that repeats is sent once per `REPEAT_WINDOW_MS`, failed or
 * not, so a render loop or a failing poll sends one report rather than a flood. After the service
 * refuses one for its budget, nothing is sent until its `Retry-After` has passed; reports in
 * between are dropped.
 */
import {
  CLIENT_ERROR_LIMITS,
  type ClientErrorKind,
  type ClientErrorReport,
  type ClientPlatform,
} from "@media/contracts/diagnostics";
import type { PlaybackSessionId } from "@media/contracts/ids";
import { RequestId } from "@media/contracts/request-id";
import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect";

import { Auth } from "./auth";
import { decodeTagged } from "./media-http";
import { MoviesClient } from "./movies-client";

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

/** Reports apps' unexpected errors. */
export interface Interface {
  /**
   * Sends `cause` as caught in `context`, unless signed out or the same error was sent within
   * `REPEAT_WINDOW_MS`. Never fails: a report that cannot be sent is dropped.
   */
  readonly report: (cause: unknown, context: ErrorContext) => Effect.Effect<void>;
}

/** The error reporter. */
export class ClientErrors extends Context.Service<ClientErrors, Interface>()(
  "@media/sdk/ClientErrors",
) {}

const make = Effect.gen(function* () {
  const client = yield* MoviesClient;
  const auth = yield* Auth;
  const sentAt = new Map<string, number>();
  const pause = { until: 0 };

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

  const report = Effect.fn("ClientErrors.report")(
    function* (cause: unknown, context: ErrorContext) {
      if ((yield* auth.currentStatus) !== "signedIn") return;

      const now = yield* Clock.currentTimeMillis;
      const sent = reportOf(cause, context);

      if (now < pause.until) return;

      if (isRepeat(`${sent.kind}\u0000${sent.name}\u0000${sent.message}\u0000${sent.route}`, now)) {
        return;
      }

      yield* client.reportError(sent).pipe(
        Effect.tapErrorTag("RateLimited", (refused) =>
          Effect.sync(() => {
            pause.until = now + (refused.retryAfterSeconds ?? DEFAULT_PAUSE_SECONDS) * 1000;
          }),
        ),
      );
    },
    Effect.catchCause((cause) => Effect.logDebug("ClientErrors.dropped", cause)),
  );

  return ClientErrors.of({ report });
});

/** The reporter over the command client. */
export const layer: Layer.Layer<ClientErrors, never, MoviesClient | Auth> = Layer.effect(
  ClientErrors,
  make,
);
