import { join } from "node:path";

import type { Unauthenticated } from "@media/contracts/errors";
import { Platform, TokenStorage } from "@media/sdk/effect";
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";

import { ConfigFileError, NotLoggedIn } from "../cli-errors";
import type { Environment } from "../config";
import { nonEmpty, normalizeUrl, ServerUrl } from "../config";
import { readTextFile, writePrivateFile } from "../files";
import type { Invocation } from "../invocation";

const StoredCore = Schema.Struct({
  url: ServerUrl,
  session: Schema.optionalKey(Schema.Struct({ token: Schema.String, refreshToken: Schema.String })),
});

type StoredCore = typeof StoredCore.Type;

const decodeStored = Schema.decodeUnknownResult(Schema.fromJsonString(StoredCore));

const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredCore));

/** The core a command runs against, for one profile. */
export interface CoreTarget {
  /** The profile's name, resolved as the movies commands resolve theirs. */
  readonly profile: string;
  /** `$XDG_CONFIG_HOME/media/sessions/<profile>.json`, mode 0600. */
  readonly path: string;
  /**
   * `MEDIA_CORE_URL`, else the core the profile's file names. The file's session belongs to its
   * core and is never sent to another.
   */
  readonly url: Option.Option<string>;
  /** `MEDIA_CORE_API_KEY`: signs in for this run only. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /**
   * Where the session lives: in the profile's file, or only in memory when `MEDIA_CORE_API_KEY`
   * signs in or `MEDIA_CORE_URL` names another core than the file's.
   */
  readonly storage: "file" | "memory";
}

const readStored = Effect.fn("Core.readStored")(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => readTextFile(path),
    catch: (cause) => new ConfigFileError({ path, message: `Could not read ${path}`, cause }),
  });

  if (text === null) return Option.none<StoredCore>();
  const decoded = decodeStored(text);

  if (Result.isFailure(decoded)) {
    return yield* new ConfigFileError({
      path,
      message: `${path} is not a valid core session; delete it or run media auth login again`,
      cause: decoded.failure,
    });
  }

  return Option.some(decoded.success);
});

const writeStored = (path: string, stored: StoredCore): Effect.Effect<void, ConfigFileError> =>
  Effect.tryPromise({
    try: () => writePrivateFile(path, `${encodeStored(stored)}\n`),
    catch: (cause) => new ConfigFileError({ path, message: `Could not write ${path}`, cause }),
  });

/** The core target of `profile`: the profile's file, overridden by `MEDIA_CORE_*`. */
export const coreTarget = Effect.fn("Core.target")(
  function* (env: Environment, profile: string) {
    const url = Option.map(yield* nonEmpty("MEDIA_CORE_URL"), normalizeUrl);
    const apiKey = Option.map(yield* nonEmpty("MEDIA_CORE_API_KEY"), Redacted.make);
    const path = join(env.configHome, "media", "sessions", `${encodeURIComponent(profile)}.json`);
    const stored = yield* readStored(path);

    const shadowed = Option.exists(stored, (file) =>
      Option.exists(url, (wanted) => wanted !== file.url),
    );

    const target: CoreTarget = {
      profile,
      path,
      url: Option.orElse(url, () => Option.map(stored, (file) => file.url)),
      apiKey,
      storage: Option.isSome(apiKey) || shadowed ? "memory" : "file",
    };

    return target;
  },
  Effect.catchTag("ConfigError", (cause) =>
    Effect.fail(
      new ConfigFileError({
        path: "environment",
        message: "Could not read the environment",
        cause,
      }),
    ),
  ),
);

const storageError =
  (operation: "load" | "save" | "clear") =>
  (cause: ConfigFileError): TokenStorage.TokenStorageError =>
    new TokenStorage.TokenStorageError({ operation, message: cause.message, cause });

const layerSessionFile = (path: string, url: string): Layer.Layer<TokenStorage.TokenStorage> =>
  Layer.succeed(
    TokenStorage.TokenStorage,
    TokenStorage.TokenStorage.of({
      load: readStored(path).pipe(
        Effect.map((stored) =>
          Option.flatMap(
            Option.filter(stored, (file) => file.url === url),
            (file) =>
              Option.map(Option.fromNullishOr(file.session), (session) => ({
                token: Redacted.make(session.token),
                refreshToken: Redacted.make(session.refreshToken),
              })),
          ),
        ),
        Effect.mapError(storageError("load")),
      ),
      save: (session) =>
        writeStored(path, {
          url,
          session: {
            token: Redacted.value(session.token),
            refreshToken: Redacted.value(session.refreshToken),
          },
        }).pipe(Effect.mapError(storageError("save"))),
      clear: writeStored(path, { url }).pipe(Effect.mapError(storageError("clear"))),
    }),
  );

/** A session store failure, reported as the session file it concerns. */
export const storageFailure =
  (path: string) =>
  (error: TokenStorage.TokenStorageError): ConfigFileError =>
    new ConfigFileError({ path, message: error.message, cause: error });

/** The platform client of `url` over the target's session store, for the scope's lifetime. */
export const openCore = Effect.fn("Core.open")(function* (target: CoreTarget, url: string) {
  const storage =
    target.storage === "file" ? layerSessionFile(target.path, url) : TokenStorage.layerMemory;

  const context = yield* Layer.build(Platform.layer({ url, connection: "http", storage })).pipe(
    Effect.catchTag("TokenStorageError", (error) =>
      Effect.fail(storageFailure(target.path)(error)),
    ),
  );

  return Context.get(context, Platform.Platform);
});

interface CoreConnection {
  readonly platform: Platform.Interface;
  readonly url: string;
  readonly target: CoreTarget;
  readonly signedIn: <A>(
    effect: Effect.Effect<A, Platform.PlatformError>,
  ) => Effect.Effect<A, Platform.PlatformError | NotLoggedIn>;
}

/**
 * Connects to the invocation's core. `required` fails with `NotLoggedIn` unless a session is
 * stored or `MEDIA_CORE_API_KEY` signs one in; `optional` connects as is, for public commands.
 */
export const connectCore = Effect.fn("Core.connect")(function* (
  invocation: Invocation,
  mode: "required" | "optional",
) {
  const target = yield* coreTarget(invocation.env, invocation.target.name);

  if (Option.isNone(target.url)) {
    return yield* new NotLoggedIn({
      message:
        "No core server: run media auth login --server <convex-url>, or set MEDIA_CORE_URL and MEDIA_CORE_API_KEY",
    });
  }

  const url = target.url.value;
  const platform = yield* openCore(target, url);
  const signedOut = Effect.map(platform.session.currentStatus, (status) => status !== "signedIn");

  if (Option.isSome(target.apiKey) && (yield* signedOut)) {
    yield* platform.session
      .signIn(Platform.Credentials.ApiKey({ key: target.apiKey.value }))
      .pipe(
        Effect.catchTag("TokenStorageError", (error) =>
          Effect.fail(storageFailure(target.path)(error)),
        ),
      );
  }

  if (mode === "required" && (yield* signedOut)) {
    return yield* new NotLoggedIn({
      message: `Not signed in to the core at ${url}: run media auth login`,
    });
  }

  const endedSession = (
    error: Unauthenticated,
  ): Effect.Effect<never, Unauthenticated | NotLoggedIn> =>
    Effect.flatMap(signedOut, (out) =>
      Effect.fail(
        out
          ? new NotLoggedIn({
              message: `The core at ${url} ended this session: run media auth login`,
            })
          : error,
      ),
    );

  const connection: CoreConnection = {
    platform,
    url,
    target,
    signedIn: (effect) => effect.pipe(Effect.catchTag("Unauthenticated", endedSession)),
  };

  return connection;
});
