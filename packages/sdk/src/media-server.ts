import type { CommandArgs, CommandResult } from "@media/contracts/commands";
import {
  ClientDiagnosticsRequest,
  ClientErrorReport,
  DIAGNOSTICS_ROUTES,
} from "@media/contracts/diagnostics";
import { Clock, Effect, Option, Redacted, Schema } from "effect";

import { reportGate, reportOf } from "./client-error-report";
import type { ErrorContext } from "./client-error-report";
import { baseUrl, encodeJson, requestJson } from "./media-http";
import type { MediaName } from "./movies-client";

/** The session a media server call goes out as: `createPlatform`'s `session` is one. */
export interface MediaServerSession {
  /** Calls `use` with the session's token under the session's refusal rule. */
  readonly refreshOnRefusal: <A>(use: (token: string | null) => Promise<A>) => Promise<A>;
}

/** Where the media server answers and the session its calls go out as. */
export type MediaServerOptions = {
  /** The media server's base URL, such as `https://media.example.com`. */
  readonly url: string;
} & (
  | {
      /**
       * The signed-in session, whose token goes as the bearer. A refusal follows the rule every
       * platform call does: one refresh of the session the call went out with, or one more try
       * when the session was renewed since.
       */
      readonly session: MediaServerSession;
    }
  | {
      /** The signed-in session's auth token; null while signed out. A refusal refreshes nothing. */
      readonly accessToken: () => Promise<string | null>;
    }
);

/** The media server's own routes, called as the signed-in person of the core (ADR 0010). */
export interface MediaServer {
  /**
   * Runs a media server command with the session's token as the bearer. Rejects with the
   * command's tagged errors, `TransportError`, or `ProtocolError`.
   */
  readonly run: <Name extends MediaName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  /**
   * Writes an app's unexpected error to the media server's retained log as the signed-in person;
   * sends nothing while signed out.
   */
  readonly reportError: (report: ClientErrorReport) => Promise<void>;
  /**
   * Writes an unexpected error, caught as `context` says, to the retained log as `reportError`
   * does, but at most once per repeat window for the same error and never during a pause the
   * server asked for (`ClientErrors`). Never rejects: a report that cannot go out is dropped.
   */
  readonly reportCaught: (cause: unknown, context: ErrorContext) => Promise<void>;
  /**
   * Sends a batch of a player's diagnostic events as the signed-in person, with the playback's
   * ticket in the body naming the playback they belong to; sends nothing while signed out.
   */
  readonly reportClientEvents: (request: ClientDiagnosticsRequest) => Promise<void>;
}

const bearerOf = (token: string | null): Option.Option<Redacted.Redacted> =>
  Option.map(Option.fromNullishOr(token), Redacted.make);

/**
 * Runs `use` with the session's token as the bearer, none while signed out, under the session's
 * refusal rule when the options name one. Rejects as `use` fails.
 */
export const withBearer = <A, E>(
  options: MediaServerOptions,
  use: (bearer: Option.Option<Redacted.Redacted>) => Effect.Effect<A, E>,
): Promise<A> => {
  const attempt = (token: string | null): Promise<A> => Effect.runPromise(use(bearerOf(token)));

  return "session" in options
    ? options.session.refreshOnRefusal(attempt)
    : options.accessToken().then(attempt);
};

const postSignedIn =
  (
    options: MediaServerOptions,
    operation: string,
    path: string,
    body: Effect.Effect<Schema.Json>,
  ) =>
  (bearer: Option.Option<Redacted.Redacted>) =>
    Effect.gen(function* () {
      if (Option.isNone(bearer)) return;

      yield* requestJson(
        {
          operation,
          url: `${baseUrl(options.url)}${path}`,
          method: "POST",
          body: Option.some(yield* body),
          bearer,
        },
        Schema.Null,
      );
    });

/** The media server's routes at `options.url`, called as the session the options name. */
export const createMediaServer = (options: MediaServerOptions): MediaServer => {
  const gate = reportGate();

  const sendReport = (report: ClientErrorReport) =>
    postSignedIn(
      options,
      "reportError",
      DIAGNOSTICS_ROUTES.clientErrors,
      encodeJson(ClientErrorReport, report),
    );

  return {
    // The command list loads with the first command, so a client that only reports errors, such
    // as every page of the movies client, does not carry it.
    run: (name, args) =>
      import("./media-commands").then(({ runMediaCommand }) =>
        runMediaCommand(options, name, args),
      ),
    reportError: (report) => withBearer(options, sendReport(report)),
    reportCaught: (cause, context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const report = reportOf(cause, context);

          if (!gate.admits(report, now)) return;

          // A report that cannot go out is dropped below, whatever stopped it.
          yield* Effect.promise(() =>
            withBearer(options, (bearer) =>
              sendReport(report)(bearer).pipe(
                Effect.tapErrorTag("RateLimited", (refused) =>
                  Effect.sync(() => gate.pause(now, refused.retryAfterSeconds)),
                ),
              ),
            ),
          );
        }).pipe(
          Effect.catchCause((dropped) => Effect.logDebug("MediaServer.reportDropped", dropped)),
        ),
      ),
    reportClientEvents: (request) =>
      withBearer(
        options,
        postSignedIn(
          options,
          "playback.diagnostics",
          DIAGNOSTICS_ROUTES.clientEvents,
          encodeJson(ClientDiagnosticsRequest, request),
        ),
      ),
  };
};
