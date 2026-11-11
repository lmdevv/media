import type { ArgsSchema, MediaCommand, WireSchema } from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import type { CommandArgs, CommandNameOfKind, CommandResult } from "@media/contracts/commands";
import {
  DIAGNOSTICS_ROUTES,
  LOG_TRUNCATED_HEADER,
  LOG_UNAVAILABLE_SINCE_HEADER,
  LogQuery,
} from "@media/contracts/diagnostics";
import { EpochMillis } from "@media/contracts/units";
import { Effect, Option, Stream } from "effect";
import type { Redacted } from "effect";

import { encodeArgs } from "./calls";
import { baseUrl, encodeJson, requestJson, requestLines } from "./media-http";
import type { CallError, TransportError } from "./sdk-errors";
import type { TokenStorageError } from "./token-storage";

/** Commands served by the media service over HTTP. */
export type MediaName = CommandNameOfKind<"media">;

/** Any failure of a media route call, including an unreadable stored session. */
export type MediaRouteError = CallError | TokenStorageError;

/** Where the media service answers, and the session token its routes take as a bearer. */
export interface Options {
  /** The media service's base URL, such as `https://media.example.com`. */
  readonly url: string;
  /** The signed-in session's auth token, renewed when about to expire; none while signed out. */
  readonly bearer: Effect.Effect<Option.Option<Redacted.Redacted>, TokenStorageError>;
}

/** Retained log records as the media service sends them. */
export interface LogLines {
  /** Older records may match too: the query's limit was reached first. */
  readonly truncated: boolean;
  /**
   * Since when the media service has not been able to write or read its retained log; none while
   * it can. Records logged since then are missing here.
   */
  readonly unavailableSince: Option.Option<EpochMillis>;
  /**
   * One JSON record per line, oldest first; with `follow`, new records until interrupted. The
   * blank lines that keep a followed connection open are left out.
   */
  readonly lines: Stream.Stream<string, TransportError>;
}

/**
 * Runs the media service command `command`, named `name` for errors and traces, with the
 * session's token as the bearer.
 */
export const runCommand = <Command extends MediaCommand<ArgsSchema, WireSchema>>(
  options: Options,
  name: string,
  command: Command,
  args: Command["args"]["Type"],
): Effect.Effect<Command["result"]["Type"], MediaRouteError> =>
  Effect.gen(function* () {
    const wire = yield* encodeArgs(name, command.args, args);

    return yield* requestJson(
      {
        operation: name,
        url: `${baseUrl(options.url)}${command.route.path}`,
        method: command.route.method,
        body: Option.some(wire),
        bearer: yield* options.bearer,
      },
      command.result,
    );
  }).pipe(Effect.withSpan("MediaRoutes.run", { attributes: { command: name } }));

/** Runs the media service command `name` with the session's token as the bearer. */
export const run = <Name extends MediaName>(
  options: Options,
  name: Name,
  args: CommandArgs<Name>,
): Effect.Effect<CommandResult<Name>, MediaRouteError> =>
  runCommand(options, name, commands[name], args);

/** The media service's retained log, for a session holding the admin scope: what `query` matches. */
export const logs = Effect.fn("MediaRoutes.logs")(function* (options: Options, query: LogQuery) {
  const answer = yield* requestLines({
    operation: "logs",
    url: `${baseUrl(options.url)}${DIAGNOSTICS_ROUTES.logs}`,
    method: "POST",
    body: Option.some(yield* encodeJson(LogQuery, query)),
    bearer: yield* options.bearer,
  });

  const lines: LogLines = {
    truncated: answer.headers.get(LOG_TRUNCATED_HEADER) === "true",
    unavailableSince: Option.fromNullishOr(answer.headers.get(LOG_UNAVAILABLE_SINCE_HEADER)).pipe(
      Option.flatMap((text) => EpochMillis.makeOption(Date.parse(text))),
    ),
    lines: answer.lines.pipe(Stream.filter((line) => line.trim().length > 0)),
  };

  return lines;
});
