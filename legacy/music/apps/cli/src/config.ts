/**
 * Credentials and the cached session token, stored under `$XDG_CONFIG_HOME/music/`.
 *
 * - `config.json` holds `{ server, key }` written by `music login` (mode 0600).
 * - `session.json` caches the JWT the key signs in to, with its expiry, so most commands skip the
 *   sign-in round trip. It is keyed by server and a hash of the key, so switching either drops it.
 *
 * `MUSIC_SERVER` and `MUSIC_API_KEY` override the file field by field.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { Config, Effect, Option, Redacted, Result, Schema } from "effect";

import { AuthError, ConfigFileError } from "./errors";
import { readTextFile, removeFile, writePrivateFile } from "./files";

/** Where the CLI keeps its files. */
export interface ConfigPaths {
  readonly dir: string;
  readonly config: string;
  readonly session: string;
}

/** The paths under a config home such as `~/.config`. */
export const pathsFor = (configHome: string): ConfigPaths => {
  const dir = join(configHome, "music");

  return { dir, config: join(dir, "config.json"), session: join(dir, "session.json") };
};

const nonEmpty = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.filter((value) => value.trim().length > 0)),
  );

/** Values the environment supplies. */
export interface Environment {
  readonly paths: ConfigPaths;
  readonly server: Option.Option<string>;
  readonly key: Option.Option<Redacted.Redacted>;
}

/** Reads `XDG_CONFIG_HOME` (or `HOME/.config`), `MUSIC_SERVER`, and `MUSIC_API_KEY`. */
export const environment: Config.Config<Environment> = Config.all({
  xdg: nonEmpty("XDG_CONFIG_HOME"),
  home: nonEmpty("HOME"),
  server: nonEmpty("MUSIC_SERVER"),
  key: nonEmpty("MUSIC_API_KEY"),
}).pipe(
  Config.map(({ xdg, home, server, key }) => ({
    paths: pathsFor(
      Option.getOrElse(xdg, () =>
        join(
          Option.getOrElse(home, () => "."),
          ".config",
        ),
      ),
    ),
    server: Option.map(server, normalizeServer),
    key: Option.map(key, (value) => Redacted.make(value.trim())),
  })),
);

/** `https://host/convex/` → `https://host/convex`. */
export const normalizeServer = (server: string): string => server.trim().replace(/\/+$/u, "");

/** A server URL the CLI can talk to. */
export const ServerUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s/]+/u, { message: "Expected an http(s) URL" }),
);

/** What `music login` stores. */
const StoredConfig = Schema.Struct({
  server: ServerUrl,
  key: Schema.String.check(Schema.isMinLength(1)),
});

/** A cached auth token for one server and key. */
export const Session = Schema.Struct({
  server: Schema.String,
  keyHash: Schema.String,
  token: Schema.String,
  /** Epoch milliseconds after which the token must not be used. */
  expiresAt: Schema.Finite,
});

export interface Session extends Schema.Schema.Type<typeof Session> {}

/** The server and key a command runs with. */
export interface Credentials {
  readonly server: string;
  readonly key: Redacted.Redacted;
}

const decodeStoredConfig = Schema.decodeUnknownResult(Schema.fromJsonString(StoredConfig));

const decodeSession = Schema.decodeUnknownResult(Schema.fromJsonString(Session));

const readText = (path: string): Effect.Effect<string | null, ConfigFileError> =>
  Effect.tryPromise({
    try: () => readTextFile(path),
    catch: (cause) => new ConfigFileError({ path, message: `Could not read ${path}`, cause }),
  });

const writeJson = (path: string, value: Schema.Json): Effect.Effect<void, ConfigFileError> =>
  Effect.tryPromise({
    try: () => writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`),
    catch: (cause) => new ConfigFileError({ path, message: `Could not write ${path}`, cause }),
  });

const remove = (path: string): Effect.Effect<void, ConfigFileError> =>
  Effect.tryPromise({
    try: () => removeFile(path),
    catch: (cause) => new ConfigFileError({ path, message: `Could not remove ${path}`, cause }),
  });

/** A short, stable fingerprint of a key, so the session cache never stores the key twice. */
export const keyHash = (key: Redacted.Redacted): string =>
  createHash("sha256").update(Redacted.value(key)).digest("hex").slice(0, 16);

/** Resolves the credentials for a command: environment first, then `config.json`. */
export const loadCredentials = Effect.fn("Config.loadCredentials")(function* (env: Environment) {
  const text = yield* readText(env.paths.config);
  const stored = text === null ? null : decodeStoredConfig(text);

  if (
    stored !== null &&
    Result.isFailure(stored) &&
    (Option.isNone(env.server) || Option.isNone(env.key))
  ) {
    return yield* new ConfigFileError({
      path: env.paths.config,
      message: `${env.paths.config} is not valid; run music login again`,
      cause: stored.failure,
    });
  }

  const file = stored !== null && Result.isSuccess(stored) ? stored.success : null;
  const server = Option.getOrElse(env.server, () => file?.server ?? "");
  const key = Option.getOrElse(env.key, () => Redacted.make(file?.key ?? ""));

  if (server.length === 0 || Redacted.value(key).length === 0) {
    return yield* new AuthError({
      code: "not_logged_in",
      message:
        "Not logged in. Run music login --server <url> --key <api-key>, or set MUSIC_SERVER and MUSIC_API_KEY",
    });
  }

  const credentials: Credentials = { server, key };

  return credentials;
});

/** Stores credentials from `music login`. */
export const saveCredentials = (
  paths: ConfigPaths,
  credentials: Credentials,
): Effect.Effect<void, ConfigFileError> =>
  writeJson(paths.config, {
    server: credentials.server,
    key: Redacted.value(credentials.key),
  });

/** Reads the cached session, treating a missing or unreadable cache as empty. */
export const loadSession = (
  paths: ConfigPaths,
): Effect.Effect<Option.Option<Session>, ConfigFileError> =>
  readText(paths.session).pipe(
    Effect.map((text) => (text === null ? Option.none() : Result.getSuccess(decodeSession(text)))),
  );

/** Caches a session token. */
export const saveSession = (
  paths: ConfigPaths,
  session: Session,
): Effect.Effect<void, ConfigFileError> =>
  writeJson(paths.session, {
    server: session.server,
    keyHash: session.keyHash,
    token: session.token,
    expiresAt: session.expiresAt,
  });

/** Deletes the stored credentials and the session cache. */
export const clearAll = (paths: ConfigPaths): Effect.Effect<void, ConfigFileError> =>
  Effect.all([remove(paths.config), remove(paths.session)], { discard: true });

/** Tokens are refreshed this long before they expire, so a request never races the expiry. */
const expirySkewMs = 60_000;

/** Whether a cached session can authenticate `credentials` at `now`. */
export const sessionUsable = (session: Session, credentials: Credentials, now: number): boolean =>
  session.server === credentials.server &&
  session.keyHash === keyHash(credentials.key) &&
  session.expiresAt - expirySkewMs > now;
