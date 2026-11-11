import type { CommandArgs, CommandResult } from "@media/contracts/commands";
import { commands } from "@media/contracts/commands";
import type { CommandNameOfKind } from "@media/contracts/commands";
import { type CommandError, InvalidArgs, Unauthenticated } from "@media/contracts/errors";
import type { CallError } from "@media/sdk/effect";
import { Effect, Match, Redacted, Schema, SchemaIssue } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CoreCallers from "../core/core-callers.ts";
import { retryAfter } from "./rate-limit.ts";

/** Commands the media service serves. */
export type MediaCommandName = CommandNameOfKind<"media">;

/** Implements one media command for an authorized caller. */
export type CommandHandler<Name extends MediaCommandName> = (
  args: CommandArgs<Name>,
  caller: CoreCallers.Caller,
) => Effect.Effect<CommandResult<Name>, CallError>;

const failureOf = Match.type<CallError>().pipe(
  Match.tagsExhaustive({
    Unauthenticated: (error) => ({ code: "unauthenticated", status: 401, message: error.message }),
    Forbidden: (error) => ({ code: "forbidden", status: 403, message: error.message }),
    NotFound: (error) => ({ code: "not_found", status: 404, message: error.message }),
    InvalidArgs: (error) => ({ code: "invalid_args", status: 400, message: error.message }),
    Conflict: (error) => ({ code: "conflict", status: 409, message: error.message }),
    Expired: (error) => ({ code: "expired", status: 410, message: error.message }),
    StaleRevision: (error) => ({ code: "stale_revision", status: 409, message: error.message }),
    RateLimited: (error) => ({
      code: "rate_limited",
      status: 429,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    }),
    Internal: (error) => ({ code: "internal", status: 500, message: error.message }),
    TransportError: () => ({
      code: "internal",
      status: 503,
      message: "The media service could not reach the core",
    }),
    ProtocolError: () => ({
      code: "internal",
      status: 502,
      message: "The core answered with something the media service does not understand",
    }),
  }),
);

/** The `{ code, message }` answer of a failed command or authenticated route. */
export const failureResponse = (error: CallError): HttpServerResponse.HttpServerResponse => {
  const failure = failureOf(error);

  const response = HttpServerResponse.jsonUnsafe(
    { code: failure.code, message: failure.message },
    { status: failure.status, headers: { "cache-control": "no-store" } },
  );

  return "retryAfterSeconds" in failure && failure.retryAfterSeconds !== undefined
    ? retryAfter(response, failure.retryAfterSeconds)
    : response;
};

const BEARER = /^Bearer\s+(\S+)$/iu;

/** The caller's Convex auth token from the `Authorization` header. */
export const bearerOf = (request: HttpServerRequest.HttpServerRequest) => {
  const match = BEARER.exec(request.headers["authorization"] ?? "");
  const token = match?.[1];

  return token === undefined
    ? Effect.fail<CommandError>(
        new Unauthenticated({ message: "Send the session's Convex auth token as a bearer token" }),
      )
    : Effect.succeed(Redacted.make(token));
};

const issueText = (issue: SchemaIssue.Issue): string =>
  SchemaIssue.makeFormatterDefault()(issue).replaceAll("\n", " ");

/**
 * Reads a request's JSON body as `schema`'s JSON form; `InvalidArgs` says the body is not JSON, or
 * starts with `invalid` and names the schema issue.
 */
export const bodyDecoder = <S extends Schema.Top>(schema: S, invalid: string) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema));

  return (request: HttpServerRequest.HttpServerRequest) =>
    request.json.pipe(
      Effect.mapError(() => new InvalidArgs({ message: "The body is not JSON" })),
      Effect.flatMap((body) =>
        decode(body).pipe(
          Effect.mapError(
            (error) => new InvalidArgs({ message: `${invalid}: ${issueText(error.issue)}` }),
          ),
        ),
      ),
    );
};

/** Registers `handler` at the route of the media command `name`. */
export const commandRoute = Effect.fnUntraced(function* <Name extends MediaCommandName>(
  name: Name,
  handler: CommandHandler<Name>,
) {
  const router = yield* HttpRouter.HttpRouter;
  const auth = yield* CoreCallers.Service;
  const command = commands[name];
  const decodeArgs = bodyDecoder(command.args, `Invalid arguments for ${name}`);
  const encodeResult = Schema.encodeEffect(Schema.toCodecJson(command.result));

  const route = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const caller = yield* auth.authorize(yield* bearerOf(request), command.scope);

    const args = yield* decodeArgs(request);

    const result = yield* handler(args, caller);
    const encoded = yield* encodeResult(result).pipe(Effect.orDie);

    return HttpServerResponse.jsonUnsafe(encoded, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catch((error) => Effect.succeed(failureResponse(error))),
    Effect.withSpan("CommandRoutes.command", { attributes: { command: name } }),
  );

  yield* router.add(command.route.method, command.route.path, route);
});
