import type {
  AnyCommand,
  ArgsSchema,
  ConvexCommand,
  MediaCommand,
  WireSchema,
} from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import type {
  CommandArgs,
  CommandName,
  CommandNameOfKind,
  CommandResult,
} from "@media/contracts/commands";
import {
  ClientErrorReport,
  DIAGNOSTICS_ROUTES,
  LOG_TRUNCATED_HEADER,
  LOG_UNAVAILABLE_SINCE_HEADER,
  LogQuery,
} from "@media/contracts/diagnostics";
import { EpochMillis } from "@media/contracts/units";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";

import * as Auth from "./auth";
import { acrossReconnects, decodeResult, encodeArgs } from "./calls";
import * as ConvexTransport from "./convex-transport";
import type { FunctionKind } from "./convex-transport";
import { baseUrl, encodeJson, requestJson, requestLines } from "./media-http";
import type { CallError } from "./sdk-errors";
import { TransportError } from "./sdk-errors";
import type { TokenStorageError } from "./token-storage";

/** Commands served by a Convex query; only these can be subscribed to. */
export type QueryName = CommandNameOfKind<"query">;

/** Commands served by a Convex mutation. */
export type MutationName = CommandNameOfKind<"mutation">;

/** Commands served by a Convex action. */
export type ActionName = CommandNameOfKind<"action">;

/** Commands served by the media service over HTTP. */
export type MediaName = CommandNameOfKind<"media">;

/** Any failure of a command call, including an unreadable stored session for media commands. */
export type ClientError = CallError | TokenStorageError;

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

/** Runs registry commands as the signed-in session. */
export interface Interface {
  /** Runs a query command once. */
  readonly query: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, CallError>;
  /**
   * Runs a mutation command. One that fails with `TransportError` may still have run; read the
   * state again before retrying it.
   */
  readonly mutate: <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, CallError>;
  /** Runs an action command, such as one that calls another service. */
  readonly action: <Name extends ActionName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, CallError>;
  /**
   * Runs a media service command with the session's token as the bearer. Fails with
   * `TransportError` when no media service URL is configured.
   */
  readonly media: <Name extends MediaName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, ClientError>;
  /** Runs any command, choosing the transport by its kind. */
  readonly run: <Name extends CommandName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, ClientError>;
  /**
   * The media service's retained log, for a session holding the `admin` scope: the records `query`
   * matches. Fails with `TransportError` when no media service URL is configured.
   */
  readonly logs: (query: LogQuery) => Effect.Effect<LogLines, ClientError>;
  /**
   * Writes an app's unexpected error to the media service's retained log, as the signed-in
   * account; sends nothing while signed out. Fails with `TransportError` when no media service URL
   * is configured, and with `RateLimited` once the account has sent more than its budget.
   */
  readonly reportError: (report: ClientErrorReport) => Effect.Effect<void, ClientError>;
  /** The query's result now and after every change. Ends only by failing or being interrupted. */
  readonly subscribe: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Stream.Stream<CommandResult<Name>, CallError>;
}

/** The typed command client. */
export class MoviesClient extends Context.Service<MoviesClient, Interface>()(
  "@media/sdk/MoviesClient",
) {}

/** Options for the command client. */
export interface Options {
  /** Where the media service answers, such as `https://movies.example.com`; none disables `media`. */
  readonly mediaUrl: Option.Option<string>;
}

/** Builds the client over the Convex connection and the session's auth. */
export const make = Effect.fn("MoviesClient.make")(function* (options: Options) {
  const transport = yield* ConvexTransport.ConvexTransport;
  const auth = yield* Auth.Auth;

  const callConvex = <Command extends ConvexCommand<FunctionKind, ArgsSchema, WireSchema>>(
    name: string,
    command: Command,
    args: Command["args"]["Type"],
  ): Effect.Effect<Command["result"]["Type"], CallError> =>
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, command.args, args);
      const raw = yield* transport.call(command.kind, command.function, wire);

      return yield* decodeResult(name, command.result, raw);
    }).pipe(Effect.withSpan("MoviesClient.call", { attributes: { command: name } }));

  const mediaRoute = (operation: string, path: string): Effect.Effect<string, TransportError> =>
    Option.match(options.mediaUrl, {
      onNone: () =>
        Effect.fail(
          new TransportError({
            operation,
            message: `Transport failed during ${operation}: no media service URL is configured`,
            cause: null,
          }),
        ),
      onSome: (url) => Effect.succeed(`${baseUrl(url)}${path}`),
    });

  const callMedia = <Command extends MediaCommand<ArgsSchema, WireSchema>>(
    name: string,
    command: Command,
    args: Command["args"]["Type"],
  ): Effect.Effect<Command["result"]["Type"], ClientError> =>
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, command.args, args);
      const url = yield* mediaRoute(name, command.route.path);
      const bearer = yield* auth.accessToken(false);

      return yield* requestJson(
        {
          operation: name,
          url,
          method: command.route.method,
          body: Option.some(wire),
          bearer,
        },
        command.result,
      );
    }).pipe(Effect.withSpan("MoviesClient.media", { attributes: { command: name } }));

  const logs = Effect.fn("MoviesClient.logs")(function* (query: LogQuery) {
    const answer = yield* requestLines({
      operation: "logs",
      url: yield* mediaRoute("logs", DIAGNOSTICS_ROUTES.logs),
      method: "POST",
      body: Option.some(yield* encodeJson(LogQuery, query)),
      bearer: yield* auth.accessToken(false),
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

  const reportError = Effect.fn("MoviesClient.reportError")(function* (report: ClientErrorReport) {
    const url = yield* mediaRoute("reportError", DIAGNOSTICS_ROUTES.clientErrors);
    const bearer = yield* auth.accessToken(false);

    if (Option.isNone(bearer)) return;

    yield* requestJson(
      {
        operation: "reportError",
        url,
        method: "POST",
        body: Option.some(yield* encodeJson(ClientErrorReport, report)),
        bearer,
      },
      Schema.Null,
    );
  });

  const invoke = <Command extends AnyCommand>(
    name: string,
    command: Command,
    args: Command["args"]["Type"],
  ): Effect.Effect<Command["result"]["Type"], ClientError> =>
    command.kind === "media" ? callMedia(name, command, args) : callConvex(name, command, args);

  const subscribeTo = <Command extends ConvexCommand<"query", ArgsSchema, WireSchema>>(
    name: string,
    command: Command,
    args: Command["args"]["Type"],
  ): Stream.Stream<Command["result"]["Type"], CallError> =>
    Stream.unwrap(
      Effect.map(encodeArgs(name, command.args, args), (wire) =>
        acrossReconnects(
          auth,
          transport
            .subscribe(command.function, wire)
            .pipe(Stream.mapEffect((raw) => decodeResult(name, command.result, raw))),
        ),
      ),
    );

  return MoviesClient.of({
    query: (name, args) => callConvex(name, commands[name], args),
    mutate: (name, args) => callConvex(name, commands[name], args),
    action: (name, args) => callConvex(name, commands[name], args),
    media: (name, args) => callMedia(name, commands[name], args),
    run: (name, args) => invoke(name, commands[name], args),
    logs,
    reportError,
    subscribe: (name, args) => subscribeTo(name, commands[name], args),
  });
});

/** The command client over the connection and auth in context. */
export const layer = (
  options: Options,
): Layer.Layer<MoviesClient, never, ConvexTransport.ConvexTransport | Auth.Auth> =>
  Layer.effect(MoviesClient, make(options));
