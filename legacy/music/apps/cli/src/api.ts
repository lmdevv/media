/**
 * The connection to a [music] server: signs in with the API key, caches the session token, and
 * runs registry commands through the shared SDK client with typed failures.
 */
import { argsDecoder } from "@music/commands/codec";
import { commands } from "@music/commands/registry";
import type {
  CommandArgs,
  CommandName,
  CommandResult,
  MutationName,
  QueryName,
} from "@music/commands/registry";
import { InvalidResultError, makeMusicClient } from "@music/sdk/client";
import { commandFailure } from "@music/sdk/errors";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Clock, Effect, Option, Redacted, Ref, Result, Schema } from "effect";

import type { ConfigPaths, Credentials, Session } from "./config";
import { keyHash, loadSession, saveSession, sessionUsable } from "./config";
import type { ConfigFileError } from "./errors";
import { AuthError, CommandFailed, ServerError, UsageError } from "./errors";
import type { WireArgs } from "./flags";
import { deriveFlags, describeIssue } from "./flags";

/** `auth:signIn` from Convex Auth. Its result is decoded below rather than trusted. */
const signInAction = makeFunctionReference<
  "action",
  { provider: "apikey"; params: { key: string } },
  Schema.Json
>("auth:signIn");

const SignInResult = Schema.Struct({
  tokens: Schema.NullOr(Schema.Struct({ token: Schema.String })),
});

const decodeSignInResult = Schema.decodeUnknownResult(SignInResult);

const JwtClaims = Schema.Struct({ exp: Schema.Finite });

const decodeJwtClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims));

/** Convex reports HTTP-level failures, such as a rejected token, as a JSON message body. */
const HttpFailure = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeHttpFailure = Schema.decodeUnknownOption(Schema.fromJsonString(HttpFailure));

/** Used when a token carries no readable `exp`; Convex Auth tokens last an hour. */
const fallbackLifetimeMs = 5 * 60_000;

/** Every failure a server call can produce. */
export type CallError = AuthError | CommandFailed | ServerError | ConfigFileError;

/** Translates whatever the Convex client threw into a typed CLI failure. */
const classify = (server: string, cause: unknown): AuthError | CommandFailed | ServerError => {
  if (cause instanceof InvalidResultError) {
    return new ServerError({ server, message: cause.message, cause });
  }

  if (!(cause instanceof Error)) {
    return new ServerError({ server, message: `Request to ${server} failed`, cause });
  }

  const failure = commandFailure(cause);

  if (failure?.code === "unauthenticated") {
    return new AuthError({ code: "unauthenticated", message: failure.message });
  }

  if (failure?.code === "forbidden") {
    return new AuthError({ code: "forbidden", message: failure.message });
  }

  if (failure !== null) return new CommandFailed(failure);

  const http = decodeHttpFailure(cause.message);

  if (Option.isSome(http) && /auth|token|jwt/iu.test(http.value.code)) {
    return new AuthError({
      code: "unauthenticated",
      message: `The server rejected the session: ${http.value.message}`,
    });
  }

  if (Option.isSome(http)) return new ServerError({ server, message: http.value.message, cause });

  // Something answered with an empty error body. Without /convex that is usually the web app's
  // address, whose proxy refuses Convex API calls; with it, the proxy is up but Convex behind it
  // is not (starting, or down), and the URL is right.
  if (cause.message.trim() === "") {
    return new ServerError({
      server,
      message: /\/convex\/?$/u.test(server)
        ? `${server} answered with an empty error: the [music] server may still be starting or be down. Try again shortly`
        : `${server} answered, but not as a [music] server. Use its Convex URL, which ends in /convex on the container install`,
      cause,
    });
  }

  return new ServerError({
    server,
    message: `Could not reach ${server}: ${cause.message}`,
    cause,
  });
};

const makeClient = (server: string): Effect.Effect<ConvexHttpClient, ServerError> =>
  Effect.try({
    try: () => new ConvexHttpClient(server, { logger: false }),
    catch: (cause) =>
      new ServerError({ server, message: `${server} is not a valid server URL`, cause }),
  });

const expiryOf = (token: string): Option.Option<number> => {
  const [, payload] = token.split(".");

  if (payload === undefined) return Option.none();

  return decodeJwtClaims(Buffer.from(payload, "base64url").toString("utf8")).pipe(
    Option.map((claims) => claims.exp * 1000),
  );
};

/** Signs in with an API key and returns a session to cache. */
export const signIn = Effect.fn("Api.signIn")(function* (credentials: Credentials) {
  const client = yield* makeClient(credentials.server);

  const raw = yield* Effect.tryPromise({
    try: () =>
      client.action(signInAction, {
        provider: "apikey",
        params: { key: Redacted.value(credentials.key) },
      }),
    catch: (cause) => classify(credentials.server, cause),
  });

  const decoded = decodeSignInResult(raw);

  if (Result.isFailure(decoded)) {
    return yield* new ServerError({
      server: credentials.server,
      message: `${credentials.server} answered sign-in with an unexpected response; is it a [music] server?`,
      cause: decoded.failure,
    });
  }

  const tokens = decoded.success.tokens;

  if (tokens === null) {
    return yield* new AuthError({
      code: "invalid_key",
      message:
        "The server rejected the API key. Create a new key in Settings or with music keys create",
    });
  }

  const now = yield* Clock.currentTimeMillis;

  const session: Session = {
    server: credentials.server,
    keyHash: keyHash(credentials.key),
    token: tokens.token,
    expiresAt: Option.getOrElse(expiryOf(tokens.token), () => now + fallbackLifetimeMs),
  };

  return session;
});

/** Runs registry commands as the signed-in user. */
export interface Api {
  readonly server: string;
  readonly read: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, CallError>;
  readonly run: <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Effect.Effect<CommandResult<Name>, CallError>;
}

/**
 * Connects with cached or fresh credentials. A cached token the server rejects is replaced once
 * by signing in again, which covers revoked sessions and a reset server.
 */
export const connect = Effect.fn("Api.connect")(function* (
  credentials: Credentials,
  paths: ConfigPaths,
) {
  const client = yield* makeClient(credentials.server);
  const music = makeMusicClient(client);
  const now = yield* Clock.currentTimeMillis;

  const cached = Option.filter(yield* loadSession(paths), (session) =>
    sessionUsable(session, credentials, now),
  );

  const authenticate = Effect.fn("Api.authenticate")(function* () {
    const session = yield* signIn(credentials);

    yield* saveSession(paths, session);
    client.setAuth(session.token);
  });

  if (Option.isSome(cached)) client.setAuth(cached.value.token);
  else yield* authenticate();

  const usingCachedToken = yield* Ref.make(Option.isSome(cached));

  const call = <A>(request: () => Promise<A>): Effect.Effect<A, CallError> => {
    const attempt = Effect.tryPromise({
      try: request,
      catch: (cause) => classify(credentials.server, cause),
    });

    return attempt.pipe(
      Effect.catchTag("AuthError", (error) =>
        Effect.gen(function* () {
          const retry =
            error.code === "unauthenticated" && (yield* Ref.getAndSet(usingCachedToken, false));

          if (!retry) return yield* error;

          yield* authenticate();

          return yield* attempt;
        }),
      ),
    );
  };

  const api: Api = {
    server: credentials.server,
    read: (name, args) => call(() => music.read(name, args)),
    run: (name, args) => call(() => music.run(name, args)),
  };

  return api;
});

const isQueryName = (name: CommandName): name is QueryName => commands[name].kind === "query";

const isMutationName = (name: CommandName): name is MutationName =>
  commands[name].kind === "mutation";

/**
 * Validates wire arguments against the registry schema before anything is sent. Failures are
 * usage errors that name the offending flag.
 */
export const validateArgs = <Name extends CommandName>(
  name: Name,
  args: WireArgs,
  usage: string,
): Result.Result<CommandArgs<Name>, UsageError> =>
  Result.mapError(
    argsDecoder(name)(args, { errors: "all" }),
    (error) =>
      new UsageError({
        message: describeIssue(deriveFlags(commands[name].args), error.issue),
        command: usage,
      }),
  );

/** Validates wire arguments, then runs the command as a query or a mutation. */
export const invoke = Effect.fn("Api.invoke")(function* (
  api: Api,
  name: CommandName,
  args: WireArgs,
  usage: string,
) {
  if (isQueryName(name)) {
    return yield* api.read(name, yield* Effect.fromResult(validateArgs(name, args, usage)));
  }

  if (isMutationName(name)) {
    return yield* api.run(name, yield* Effect.fromResult(validateArgs(name, args, usage)));
  }

  return yield* Effect.die(new Error("Registry command kind is neither query nor mutation"));
});
