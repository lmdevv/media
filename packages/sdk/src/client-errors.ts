/**
 * Apps' unexpected errors, such as a crashed screen or an unhandled rejection, written to the media
 * service's retained log so whoever runs the server can find them with `media logs`. Nothing is
 * sent while signed out, and an error that repeats is sent once per `REPEAT_WINDOW_MS`, failed or
 * not, so a render loop or a failing poll sends one report rather than a flood. After the service
 * refuses one for its budget, nothing is sent until its `Retry-After` has passed; reports in
 * between are dropped.
 */
import { Clock, Context, Effect, Layer } from "effect";

import { Auth } from "./auth";
import { reportGate, reportOf } from "./client-error-report";
import type { ErrorContext } from "./client-error-report";
import { MoviesClient } from "./movies-client";

export { REPEAT_WINDOW_MS, reportGate, reportOf } from "./client-error-report";

export type { ErrorContext, ReportGate } from "./client-error-report";

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
  const gate = reportGate();

  const report = Effect.fn("ClientErrors.report")(
    function* (cause: unknown, context: ErrorContext) {
      if ((yield* auth.currentStatus) !== "signedIn") return;

      const now = yield* Clock.currentTimeMillis;
      const sent = reportOf(cause, context);

      if (!gate.admits(sent, now)) return;

      yield* client
        .reportError(sent)
        .pipe(
          Effect.tapErrorTag("RateLimited", (refused) =>
            Effect.sync(() => gate.pause(now, refused.retryAfterSeconds)),
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
