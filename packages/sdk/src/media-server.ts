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

/** Where the media server answers and how to read the session's bearer token. */
export interface MediaServerOptions {
  /** The media server's base URL, such as `https://media.example.com`. */
  readonly url: string;
  /** The signed-in session's auth token; null while signed out. `createPlatform`'s does this. */
  readonly accessToken: () => Promise<string | null>;
}

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

/** The session's token as a bearer, none while signed out. */
export const bearerOf = (options: MediaServerOptions) =>
  Effect.promise(() => options.accessToken()).pipe(
    Effect.map((token) => Option.map(Option.fromNullishOr(token), Redacted.make)),
  );

const postSignedIn = (
  options: MediaServerOptions,
  operation: string,
  path: string,
  body: Effect.Effect<Schema.Json>,
) =>
  Effect.gen(function* () {
    const bearer = yield* bearerOf(options);

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

/** The media server's routes at `options.url`, as the session `options.accessToken` reads. */
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
    reportError: (report) => Effect.runPromise(sendReport(report)),
    reportCaught: (cause, context) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const report = reportOf(cause, context);

          if (!gate.admits(report, now)) return;

          yield* sendReport(report).pipe(
            Effect.tapErrorTag("RateLimited", (refused) =>
              Effect.sync(() => gate.pause(now, refused.retryAfterSeconds)),
            ),
          );
        }).pipe(
          Effect.catchCause((dropped) => Effect.logDebug("MediaServer.reportDropped", dropped)),
        ),
      ),
    reportClientEvents: (request) =>
      Effect.runPromise(
        postSignedIn(
          options,
          "playback.diagnostics",
          DIAGNOSTICS_ROUTES.clientEvents,
          encodeJson(ClientDiagnosticsRequest, request),
        ),
      ),
  };
};
