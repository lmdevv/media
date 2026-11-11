import { join } from "node:path";

import type { Unauthenticated } from "@media/contracts/errors";
import type { CallError, MediaRoutes } from "@media/sdk/effect";
import { Platform, TokenStorage } from "@media/sdk/effect";
import { Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";

import { ConfigFileError, NotLoggedIn, UsageError } from "./cli-errors";
import { readTextFile, writePrivateFile } from "./files";

/** A server URL the CLI can talk to. */
const ServerUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s/]+/u, { message: "Expected an http(s) URL" }),
);

/** Whether `url` is a server URL the CLI can talk to. */
export const isServerUrl = (url: string): boolean => Schema.is(ServerUrl)(url);

/** `https://host/` → `https://host`. */
export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/u, "");

/** A variable that is unset or blank reads as none. */
export const nonEmpty = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.filter((value) => value.trim().length > 0)),
  );

/** An environment the CLI could not read, reported as the config it is. */
export const environmentError = <A, E, R>(
  effect: Effect.Effect<A, E | Config.ConfigError, R>,
): Effect.Effect<A, E | ConfigFileError, R> =>
  Effect.mapError(effect, (error) =>
    error instanceof Config.ConfigError
      ? new ConfigFileError({
          path: "environment",
          message: "Could not read the environment",
          cause: error,
        })
      : error,
  );

const StoredSession = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

/**
 * One profile's file: the core's URL, the media server's when it is not beside the core, and the
 * session the core issued.
 */
const StoredProfile = Schema.Struct({
  url: ServerUrl,
  mediaUrl: Schema.optionalKey(ServerUrl),
  session: Schema.optionalKey(StoredSession),
});

type StoredProfile = typeof StoredProfile.Type;

/** Where a profile's core and media server answer. */
interface Server {
  readonly url: string;
  readonly mediaUrl: Option.Option<string>;
}

const decodeStored = Schema.decodeUnknownResult(Schema.fromJsonString(StoredProfile));

const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredProfile));

/** The addresses the environment names for one run, never stored. */
interface Overrides {
  /** `MEDIA_SERVER_URL`. */
  readonly mediaUrl: Option.Option<string>;
  /** `MEDIA_CORE_SIGN_IN_URL`. */
  readonly signInUrl: Option.Option<string>;
}

/** The profile, server, and credentials a command runs with. */
export interface Target {
  /** `--profile`, else `MEDIA_PROFILE`, else `default`. */
  readonly profile: string;
  /** The profile's one config file: `$XDG_CONFIG_HOME/media/sessions/<profile>.json`, mode 0600. */
  readonly path: string;
  /**
   * `MEDIA_CORE_URL`, else the core the profile's file names. The file's session belongs to its
   * core and is never sent to another.
   */
  readonly url: Option.Option<string>;
  /** The media server the profile keeps for this core (`auth login --media-url`), if any. */
  readonly savedMediaUrl: Option.Option<string>;
  readonly overrides: Overrides;
  /**
   * `MEDIA_SERVER_URL`, else `savedMediaUrl`, else the one beside the core: where playback,
   * logs, and diagnostics go.
   */
  readonly mediaUrl: Option.Option<string>;
  /** `MEDIA_CORE_API_KEY`: signs in for this run only. */
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /**
   * `MEDIA_CORE_SIGN_IN_URL`, where every sign-in goes (ADR 0007). Without it, the boundary on
   * the media server.
   */
  readonly signInUrl: Option.Option<string>;
  /**
   * Where the session lives: in the profile's file, or only in memory when `MEDIA_CORE_API_KEY`
   * signs in or `MEDIA_CORE_URL` names another core than the file's.
   */
  readonly storage: "file" | "memory";
}

/** Where the media server and the sign-in boundary are for the core at `url`. */
const addressesOf = (
  url: Option.Option<string>,
  savedMediaUrl: Option.Option<string>,
  overrides: Overrides,
): Pick<Target, "mediaUrl" | "signInUrl"> => {
  const mediaUrl = Option.orElse(overrides.mediaUrl, () =>
    Option.orElse(savedMediaUrl, () => Option.map(url, Platform.serverUrlBeside)),
  );

  return {
    mediaUrl,
    signInUrl: Option.orElse(overrides.signInUrl, () =>
      Option.map(mediaUrl, Platform.signInUrlFor),
    ),
  };
};

const readStored = Effect.fn("Config.readStored")(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => readTextFile(path),
    catch: (cause) => new ConfigFileError({ path, message: `Could not read ${path}`, cause }),
  });

  if (text === null) return Option.none<StoredProfile>();
  const decoded = decodeStored(text);

  if (Result.isFailure(decoded)) {
    return yield* new ConfigFileError({
      path,
      message: `${path} is not a valid [media] profile; delete it, then run media auth login`,
      cause: decoded.failure,
    });
  }

  return Option.some(decoded.success);
});

const writeStored = (path: string, stored: StoredProfile): Effect.Effect<void, ConfigFileError> =>
  Effect.tryPromise({
    try: () => writePrivateFile(path, `${encodeStored(stored)}\n`),
    catch: (cause) => new ConfigFileError({ path, message: `Could not write ${path}`, cause }),
  });

const urlVariable = Effect.fn("Config.urlVariable")(function* (name: string) {
  const url = Option.map(yield* nonEmpty(name), normalizeUrl);

  if (Option.isSome(url) && !isServerUrl(url.value)) {
    return yield* new UsageError({
      message: `${name} is not an http(s) URL: "${url.value}"`,
      command: null,
    });
  }

  return url;
});

/** The target of `--profile` (or `MEDIA_PROFILE`): the profile's file, overridden by `MEDIA_*`. */
export const resolveTarget = Effect.fn("Config.resolveTarget")(function* (
  profileFlag: Option.Option<string>,
) {
  const home = yield* nonEmpty("HOME");

  const configHome = Option.getOrElse(yield* nonEmpty("XDG_CONFIG_HOME"), () =>
    join(
      Option.getOrElse(home, () => "."),
      ".config",
    ),
  );

  const fromEnv = yield* nonEmpty("MEDIA_PROFILE");

  const named = Option.getOrElse(
    Option.orElse(profileFlag, () => fromEnv),
    () => "default",
  );

  const url = yield* urlVariable("MEDIA_CORE_URL");

  const overrides: Overrides = {
    mediaUrl: yield* urlVariable("MEDIA_SERVER_URL"),
    signInUrl: yield* urlVariable("MEDIA_CORE_SIGN_IN_URL"),
  };

  const apiKey = Option.map(yield* nonEmpty("MEDIA_CORE_API_KEY"), (key) =>
    Redacted.make(key.trim()),
  );

  const path = join(configHome, "media", "sessions", `${encodeURIComponent(named)}.json`);
  const onDisk = yield* readStored(path);

  const shadowed = Option.exists(onDisk, (held) =>
    Option.exists(url, (wanted) => wanted !== held.url),
  );

  const stored = shadowed ? Option.none<StoredProfile>() : onDisk;
  const core = Option.orElse(url, () => Option.map(stored, (held) => held.url));
  const savedMediaUrl = Option.flatMap(stored, (held) => Option.fromNullishOr(held.mediaUrl));

  const target: Target = {
    profile: named,
    path,
    url: core,
    savedMediaUrl,
    overrides,
    ...addressesOf(core, savedMediaUrl, overrides),
    apiKey,
    storage: Option.isSome(apiKey) || shadowed ? "memory" : "file",
  };

  return target;
}, environmentError);

/**
 * The target pointed at the core `url`, as `media auth login --server <url> --media-url <url>`
 * names it. The profile keeps `mediaUrl`, else the media server it kept for that core; the
 * environment's addresses still win for this run.
 */
export const retarget = (target: Target, url: string, mediaUrl: Option.Option<string>): Target => {
  const savedMediaUrl = Option.orElse(mediaUrl, () =>
    Option.filter(target.savedMediaUrl, () => Option.contains(target.url, url)),
  );

  return {
    ...target,
    url: Option.some(url),
    savedMediaUrl,
    ...addressesOf(Option.some(url), savedMediaUrl, target.overrides),
  };
};

const storageError =
  (operation: "load" | "save" | "clear") =>
  (cause: ConfigFileError): TokenStorage.TokenStorageError =>
    new TokenStorage.TokenStorageError({ operation, message: cause.message, cause });

const toSession = (session: NonNullable<StoredProfile["session"]>): TokenStorage.StoredSession => ({
  token: Redacted.make(session.token),
  refreshToken: Redacted.make(session.refreshToken),
});

/** The file's form of `server`, with `session` when given. */
const storedOf = (
  server: Server,
  session: Option.Option<NonNullable<StoredProfile["session"]>>,
): StoredProfile => ({
  url: server.url,
  ...Option.match(server.mediaUrl, { onNone: () => ({}), onSome: (mediaUrl) => ({ mediaUrl }) }),
  ...Option.match(session, { onNone: () => ({}), onSome: (held) => ({ session: held }) }),
});

/**
 * Keeps the session for `server` in the profile's file. `stored` starts from the file's session
 * for that core; `signedOut` starts from none, so the file changes only once a new sign-in
 * succeeds. Signing out keeps the servers.
 */
const layerProfileFile = (
  path: string,
  server: Server,
  start: "stored" | "signedOut",
): Layer.Layer<TokenStorage.TokenStorage> =>
  Layer.succeed(
    TokenStorage.TokenStorage,
    TokenStorage.TokenStorage.of(
      TokenStorage.owned({
        load:
          start === "signedOut"
            ? Effect.succeedNone
            : readStored(path).pipe(
                Effect.map((stored) =>
                  Option.flatMap(
                    Option.filter(stored, (file) => file.url === server.url),
                    (file) => Option.map(Option.fromNullishOr(file.session), toSession),
                  ),
                ),
                Effect.mapError(storageError("load")),
              ),
        save: (session) =>
          writeStored(
            path,
            storedOf(
              server,
              Option.some({
                token: Redacted.value(session.token),
                refreshToken: Redacted.value(session.refreshToken),
              }),
            ),
          ).pipe(Effect.mapError(storageError("save"))),
        clear: writeStored(path, storedOf(server, Option.none())).pipe(
          Effect.mapError(storageError("clear")),
        ),
      }),
    ),
  );

/** Holds `session` for one sign-out and writes nothing. */
const layerHolding = (
  session: TokenStorage.StoredSession,
): Layer.Layer<TokenStorage.TokenStorage> =>
  Layer.succeed(
    TokenStorage.TokenStorage,
    TokenStorage.TokenStorage.of(
      TokenStorage.owned({
        load: Effect.succeedSome(session),
        save: () => Effect.void,
        clear: Effect.void,
      }),
    ),
  );

/** A session store failure, reported as the profile file it concerns. */
export const storageFailure =
  (path: string) =>
  (error: TokenStorage.TokenStorageError): ConfigFileError =>
    new ConfigFileError({ path, message: error.message, cause: error });

const openPlatform = (
  target: Target,
  url: string,
  storage: Layer.Layer<TokenStorage.TokenStorage>,
) =>
  Layer.build(
    Platform.layer({
      url,
      connection: "http",
      storage,
      signIn: Platform.SignInRoute.Boundary({
        url: Option.getOrElse(target.signInUrl, () => Platform.signInUrlBeside(url)),
      }),
    }),
  ).pipe(
    Effect.map((context) => Context.get(context, Platform.Platform)),
    Effect.catchTag("TokenStorageError", (error) =>
      Effect.fail(storageFailure(target.path)(error)),
    ),
  );

/** The servers the profile's file keeps: the core, and its media server when it is not beside it. */
const serverOf = (target: Target, url: string): Server => ({
  url,
  mediaUrl: Option.filter(
    target.savedMediaUrl,
    (mediaUrl) => mediaUrl !== Platform.serverUrlBeside(url),
  ),
});

/**
 * A signed-out platform client of the target's core whose sign-in replaces the profile's file
 * only once it succeeds.
 */
export const openForSignIn = (target: Target, url: string) =>
  openPlatform(target, url, layerProfileFile(target.path, serverOf(target, url), "signedOut"));

/** A session the profile's file holds, and the core that issued it. */
interface HeldSession {
  readonly server: Server;
  readonly session: TokenStorage.StoredSession;
}

/** The session the profile's file holds, for whichever core issued it. */
export const heldSession = (
  target: Target,
): Effect.Effect<Option.Option<HeldSession>, ConfigFileError> =>
  Effect.map(readStored(target.path), (stored) =>
    Option.flatMap(stored, (file) =>
      Option.map(Option.fromNullishOr(file.session), (session) => ({
        server: { url: file.url, mediaUrl: Option.fromNullishOr(file.mediaUrl) },
        session: toSession(session),
      })),
    ),
  );

/** Ends `held` on the core that issued it, when that core answers. Writes nothing. */
export const endSession = (target: Target, held: HeldSession): Effect.Effect<void> =>
  openPlatform(target, held.server.url, layerHolding(held.session)).pipe(
    Effect.flatMap((platform) => platform.session.signOut),
    Effect.scoped,
    Effect.ignore,
  );

/** Forgets the profile's session, keeping its servers. */
export const forgetSession = (
  target: Target,
  held: HeldSession,
): Effect.Effect<void, ConfigFileError> =>
  writeStored(target.path, storedOf(held.server, Option.none()));

/** What a command works with: the core, as the profile's session, and its media server. */
export interface Connection {
  readonly platform: Platform.Interface;
  readonly url: string;
  readonly target: Target;
  /** The media server's routes, called with the session's token. */
  readonly media: MediaRoutes.Options;
  /**
   * Runs a call, reporting `not_logged_in` once the core has ended the session: the client has
   * already tried one refresh (D51).
   */
  readonly signedIn: <A>(
    effect: Effect.Effect<A, MediaRoutes.MediaRouteError>,
  ) => Effect.Effect<A, CallError | ConfigFileError | NotLoggedIn>;
}

/**
 * Connects to the target's core. `required` fails with `NotLoggedIn` unless a session is stored or
 * `MEDIA_CORE_API_KEY` signs one in; `optional` connects as is, for public commands.
 */
export const connect = Effect.fn("Config.connect")(function* (
  target: Target,
  mode: "required" | "optional",
) {
  if (Option.isNone(target.url)) {
    return yield* new NotLoggedIn({
      message:
        "Not signed in: run media auth login --server <core-url>, or set MEDIA_CORE_URL and MEDIA_CORE_API_KEY",
    });
  }

  const url = target.url.value;

  const platform = yield* openPlatform(
    target,
    url,
    target.storage === "file"
      ? layerProfileFile(target.path, serverOf(target, url), "stored")
      : TokenStorage.layerMemory,
  );

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

  const connection: Connection = {
    platform,
    url,
    target,
    media: {
      url: Option.getOrElse(target.mediaUrl, () => Platform.serverUrlBeside(url)),
      bearer: platform.session.accessToken,
    },
    signedIn: (effect) =>
      effect.pipe(
        Effect.catchTags({
          Unauthenticated: endedSession,
          TokenStorageError: (error) => Effect.fail(storageFailure(target.path)(error)),
        }),
      ),
  };

  return connection;
});
