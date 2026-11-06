import { join } from "node:path";

import { TokenStorage } from "@media/sdk/effect";
import { Config, Effect, Layer, Option, Redacted, Result, Schema, Stream, Struct } from "effect";

import { ConfigFileError } from "./cli-errors";
import { readTextFile, writePrivateFile } from "./files";

/** A server URL the CLI can talk to. */
export const ServerUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s/]+/u, { message: "Expected an http(s) URL" }),
);

const StoredSession = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

/** Whether `url` is a server URL the CLI can talk to. */
export const isServerUrl = (url: string): boolean => Schema.is(ServerUrl)(url);

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

/** One server and its credentials. */
export const StoredProfile = Schema.Struct({
  convexUrl: ServerUrl,
  mediaUrl: Schema.optionalKey(ServerUrl),
  /** This install's device ID on this server, used for playback sessions and rooms. */
  deviceId: Schema.String,
  /** The viewing profile commands use when `--profile-id` is not given. */
  viewingProfileId: Schema.optionalKey(Schema.String),
  /** An API key stored by `media login --api-key`; it signs in again when the session ends. */
  apiKey: Schema.optionalKey(Schema.String),
  session: Schema.optionalKey(StoredSession),
});

/** One server and its credentials. */
export interface StoredProfile extends Schema.Schema.Type<typeof StoredProfile> {}

/** The whole config file. */
export const StoredConfig = Schema.Struct({
  defaultProfile: Schema.String,
  profiles: Schema.Record(Schema.String, StoredProfile),
});

/** The whole config file. */
export interface StoredConfig extends Schema.Schema.Type<typeof StoredConfig> {}

const EMPTY: StoredConfig = { defaultProfile: "default", profiles: {} };

const decodeConfig = Schema.decodeUnknownResult(Schema.fromJsonString(StoredConfig));

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(StoredConfig));

/** What the environment supplies. */
export interface Environment {
  /** `XDG_CONFIG_HOME`, or `.config` in `HOME`. */
  readonly configHome: string;
  readonly configPath: string;
  readonly convexUrl: Option.Option<string>;
  readonly mediaUrl: Option.Option<string>;
  readonly apiKey: Option.Option<Redacted.Redacted>;
  readonly profile: Option.Option<string>;
}

/** A variable that is unset or blank reads as none. */
export const nonEmpty = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.filter((value) => value.trim().length > 0)),
  );

/** `https://host/` → `https://host`. */
export const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/u, "");

/** Reads `XDG_CONFIG_HOME` (or `HOME/.config`) and the `MEDIA_*` overrides. */
export const environment: Config.Config<Environment> = Config.all({
  xdg: nonEmpty("XDG_CONFIG_HOME"),
  home: nonEmpty("HOME"),
  convexUrl: nonEmpty("MEDIA_CONVEX_URL"),
  mediaUrl: nonEmpty("MEDIA_SERVER_URL"),
  apiKey: nonEmpty("MEDIA_API_KEY"),
  profile: nonEmpty("MEDIA_PROFILE"),
}).pipe(
  Config.map(({ xdg, home, convexUrl, mediaUrl, apiKey, profile }) => {
    const configHome = Option.getOrElse(xdg, () =>
      join(
        Option.getOrElse(home, () => "."),
        ".config",
      ),
    );

    return {
      configHome,
      configPath: join(configHome, "movies", "config.json"),
      convexUrl: Option.map(convexUrl, normalizeUrl),
      mediaUrl: Option.map(mediaUrl, normalizeUrl),
      apiKey: Option.map(apiKey, (value) => Redacted.make(value.trim())),
      profile,
    };
  }),
);

/** Reads the config file; a missing file is an empty config. */
export const loadConfig = Effect.fn("Config.load")(function* (path: string) {
  const text = yield* Effect.tryPromise({
    try: () => readTextFile(path),
    catch: (cause) => new ConfigFileError({ path, message: `Could not read ${path}`, cause }),
  });

  if (text === null) return EMPTY;
  const decoded = decodeConfig(text);

  if (Result.isFailure(decoded)) {
    return yield* new ConfigFileError({
      path,
      message: `${path} is not a valid [movies] config; fix it or run media login again`,
      cause: decoded.failure,
    });
  }

  return decoded.success;
});

/** Writes the config file with mode 0600. */
export const saveConfig = Effect.fn("Config.save")(function* (path: string, config: StoredConfig) {
  yield* Effect.tryPromise({
    try: () => writePrivateFile(path, `${encodeConfig(config)}\n`),
    catch: (cause) => new ConfigFileError({ path, message: `Could not write ${path}`, cause }),
  });
});

/** Changes one profile in the config file, creating it from `initial` when it does not exist. */
export const updateProfile = Effect.fn("Config.updateProfile")(function* (
  path: string,
  name: string,
  change: (profile: Option.Option<StoredProfile>) => Option.Option<StoredProfile>,
) {
  const config = yield* loadConfig(path);
  const next = change(Option.fromNullishOr(config.profiles[name]));

  const profiles = Object.fromEntries([
    ...Object.entries(config.profiles).filter(([key]) => key !== name),
    ...Option.match(next, { onNone: () => [], onSome: (profile) => [[name, profile] as const] }),
  ]);

  yield* saveConfig(path, { defaultProfile: config.defaultProfile, profiles });

  return next;
});

/** Sets which profile commands use by default. */
export const setDefaultProfile = Effect.fn("Config.setDefaultProfile")(function* (
  path: string,
  name: string,
) {
  const config = yield* loadConfig(path);

  yield* saveConfig(path, { defaultProfile: name, profiles: config.profiles });
});

/** The profile and server a command runs against. */
export interface Target {
  /** The profile's name in the config file. */
  readonly name: string;
  /**
   * The stored profile, unless `MEDIA_CONVEX_URL` names another server: a profile's device,
   * viewing profile, API key, and session belong to its own server and are never sent elsewhere.
   */
  readonly stored: Option.Option<StoredProfile>;
  /**
   * The stored profile of this name when it belongs to another server than `MEDIA_CONVEX_URL`.
   * Commands never replace or clear it.
   */
  readonly shadowed: Option.Option<StoredProfile>;
  /** The server, normalized: `https://host/` reads as `https://host`. */
  readonly convexUrl: Option.Option<string>;
  readonly mediaUrl: Option.Option<string>;
  readonly apiKey: Option.Option<Redacted.Redacted>;
  /** The API key came from `MEDIA_API_KEY`, so its session is not stored. */
  readonly apiKeyFromEnvironment: boolean;
  /**
   * Where the session's tokens live: in the stored profile, or only in memory when the API key
   * comes from the environment or no stored profile is for this server.
   */
  readonly sessionStorage: "profile" | "memory";
}

/** Combines the flag, the environment, and the config file into the command's target. */
export const resolveTarget = (
  config: StoredConfig,
  env: Environment,
  profileFlag: Option.Option<string>,
): Target => {
  const name = Option.getOrElse(
    Option.orElse(profileFlag, () => env.profile),
    () => config.defaultProfile,
  );

  const named = Option.fromNullishOr(config.profiles[name]);

  const forThisServer = (profile: StoredProfile): boolean =>
    Option.match(env.convexUrl, {
      onNone: () => true,
      onSome: (url) => url === normalizeUrl(profile.convexUrl),
    });

  const stored = Option.filter(named, forThisServer);

  const storedKey = Option.flatMap(stored, (profile) => Option.fromNullishOr(profile.apiKey));

  return {
    name,
    stored,
    shadowed: Option.filter(named, (profile) => !forThisServer(profile)),
    convexUrl: Option.orElse(env.convexUrl, () =>
      Option.map(stored, (profile) => normalizeUrl(profile.convexUrl)),
    ),
    mediaUrl: Option.orElse(env.mediaUrl, () =>
      Option.flatMap(stored, (profile) => Option.fromNullishOr(profile.mediaUrl)),
    ),
    apiKey: Option.orElse(env.apiKey, () => Option.map(storedKey, Redacted.make)),
    apiKeyFromEnvironment: Option.isSome(env.apiKey),
    sessionStorage: Option.isSome(stored) && Option.isNone(env.apiKey) ? "profile" : "memory",
  };
};

/**
 * Keeps the session's tokens in the profile's `session` field. A profile that does not exist yet
 * (a first login) is created when the session is saved with `create`.
 */
export const layerProfileStorage = (
  path: string,
  name: string,
  create: Option.Option<Omit<StoredProfile, "session">>,
): Layer.Layer<TokenStorage.TokenStorage> =>
  Layer.succeed(
    TokenStorage.TokenStorage,
    TokenStorage.TokenStorage.of({
      load: loadConfig(path).pipe(
        Effect.map((config) =>
          Option.flatMap(Option.fromNullishOr(config.profiles[name]?.session), (session) =>
            TokenStorage.parseStoredSession(JSON.stringify(session)),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new TokenStorage.TokenStorageError({
              operation: "load",
              message: cause.message,
              cause,
            }),
        ),
      ),
      save: (session) =>
        updateProfile(path, name, (profile) =>
          Option.map(
            Option.orElse(profile, () => create),
            (base): StoredProfile =>
              Struct.assign(base, {
                session: {
                  token: Redacted.value(session.token),
                  refreshToken: Redacted.value(session.refreshToken),
                },
              }),
          ),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new TokenStorage.TokenStorageError({
                operation: "save",
                message: cause.message,
                cause,
              }),
          ),
        ),
      clear: updateProfile(path, name, (profile) =>
        Option.map(profile, ({ session: _session, ...rest }) => rest),
      ).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new TokenStorage.TokenStorageError({
              operation: "clear",
              message: cause.message,
              cause,
            }),
        ),
      ),
      changed: Stream.never,
    }),
  );
