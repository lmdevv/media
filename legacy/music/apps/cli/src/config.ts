/**
 * Credentials and the cached session token, stored under `$XDG_CONFIG_HOME/music/`.
 *
 * - `config.json` holds `{ server, key }` written by `music login` (mode 0600).
 * - `session.json` caches the JWT the key signs in to, with its expiry, so most commands skip the
 *   sign-in round trip. It is keyed by server and a hash of the key, so switching either drops it.
 *
 * `MUSIC_SERVER` and `MUSIC_API_KEY` override the file field by field. A plain `http://` server on
 * another machine would carry the key unencrypted, so `music login` refuses one unless given
 * `--insecure`, and `MUSIC_SERVER` is refused unless `MUSIC_INSECURE` is set.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import { Config, Effect, Option, Redacted, Result, Schema } from "effect";

import { AuthError, ConfigFileError, UsageError } from "./errors";
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

/**
 * Whether an opt-in variable is switched on. Anything else, including a typo, leaves it off: the
 * safe side for `MUSIC_INSECURE`, and no reason to fail every command.
 */
const isTruthy = (value: string): boolean =>
  ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());

/** Values the environment supplies. */
export interface Environment {
  readonly paths: ConfigPaths;
  readonly server: Option.Option<string>;
  readonly key: Option.Option<Redacted.Redacted>;
  /** `MUSIC_INSECURE`: allow a plain `http://` server on another machine. */
  readonly insecure: boolean;
}

/**
 * Reads `XDG_CONFIG_HOME` (or `HOME/.config`), `MUSIC_SERVER`, `MUSIC_API_KEY`, and
 * `MUSIC_INSECURE`.
 */
export const environment: Config.Config<Environment> = Config.all({
  xdg: nonEmpty("XDG_CONFIG_HOME"),
  home: nonEmpty("HOME"),
  server: nonEmpty("MUSIC_SERVER"),
  key: nonEmpty("MUSIC_API_KEY"),
  insecure: nonEmpty("MUSIC_INSECURE"),
}).pipe(
  Config.map(({ xdg, home, server, key, insecure }) => ({
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
    insecure: Option.exists(insecure, isTruthy),
  })),
);

/** `https://host/convex/` → `https://host/convex`. */
export const normalizeServer = (server: string): string => server.trim().replace(/\/+$/u, "");

/** A server URL the CLI can talk to. */
export const ServerUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s/]+/u, { message: "Expected an http(s) URL" }),
);

const isLoopbackHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/u.test(host);

/**
 * Whether talking to `server` would send the API key unencrypted to another machine: a plain
 * `http://` URL whose host is not this machine's loopback interface.
 */
export const sendsKeyInCleartext = (server: string): boolean => {
  if (!URL.canParse(server)) return false;

  const url = new URL(server);

  return url.protocol === "http:" && !isLoopbackHost(url.hostname);
};

/** Refuses a cleartext `server`, naming the flag or variable that allows it anyway. */
export const cleartextError = (
  server: string,
  allowWith: string,
  command: string | null,
): UsageError =>
  new UsageError({
    message: `${server} is plain http:// to another machine, which would send the API key unencrypted. Use https://, or allow it with ${allowWith}`,
    command,
  });

/** What `music login` stores. */
const StoredConfig = Schema.Struct({
  server: ServerUrl,
  key: Schema.String.check(Schema.isMinLength(1)),
  /** Set by `music login --insecure`: the user chose a plain http:// server on another machine. */
  insecure: Schema.optionalKey(Schema.Boolean),
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
        "Not logged in. Run music login --server <url>, or set MUSIC_SERVER and MUSIC_API_KEY",
    });
  }

  if (!env.insecure && sendsKeyInCleartext(server)) {
    if (Option.isSome(env.server)) return yield* cleartextError(server, "MUSIC_INSECURE=1", null);

    // `music login --insecure` records the choice. A config without it was written by a CLI that
    // did not ask, so the key would go out unencrypted without anyone having agreed to it.
    if (file?.insecure !== true) {
      return yield* cleartextError(server, "music login --insecure (or MUSIC_INSECURE=1)", "login");
    }
  }

  const credentials: Credentials = { server, key };

  return credentials;
});

/**
 * Stores credentials from `music login`, with `insecure` when the user allowed a plain http://
 * server on another machine.
 */
export const saveCredentials = (
  paths: ConfigPaths,
  credentials: Credentials,
  insecure = false,
): Effect.Effect<void, ConfigFileError> =>
  writeJson(
    paths.config,
    insecure
      ? { server: credentials.server, key: Redacted.value(credentials.key), insecure: true }
      : { server: credentials.server, key: Redacted.value(credentials.key) },
  );

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
