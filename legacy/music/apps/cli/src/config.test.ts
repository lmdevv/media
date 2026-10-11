import { Effect, Option, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Credentials, Environment, Session } from "./config";
import {
  clearAll,
  keyHash,
  loadCredentials,
  loadSession,
  pathsFor,
  saveCredentials,
  saveSession,
  sessionUsable,
} from "./config";
import { makeTempDir, permissions, readText, removeDir, writeText } from "./testing/process";

const credentials: Credentials = {
  server: "https://music.example.com/convex",
  key: Redacted.make("mk_file-key-0123456789"),
};

const load = (environment: Environment) =>
  Effect.runPromise(Effect.result(loadCredentials(environment)));

describe("config files", () => {
  let home = "";

  const env = (overrides: Partial<Pick<Environment, "server" | "key">> = {}): Environment => ({
    paths: pathsFor(home),
    server: overrides.server ?? Option.none(),
    key: overrides.key ?? Option.none(),
  });

  beforeEach(async () => {
    home = await makeTempDir("music-cli-config-");
  });

  afterEach(() => removeDir(home));

  it("stores credentials readable only by the owner and reads them back", async () => {
    await Effect.runPromise(saveCredentials(pathsFor(home), credentials));

    const paths = pathsFor(home);

    expect(await permissions(paths.config)).toBe(0o600);
    expect(await permissions(paths.dir)).toBe(0o700);
    expect(JSON.parse(await readText(paths.config))).toEqual({
      server: credentials.server,
      key: "mk_file-key-0123456789",
    });

    const loaded = await Effect.runPromise(loadCredentials(env()));

    expect(loaded.server).toBe(credentials.server);
    expect(Redacted.value(loaded.key)).toBe("mk_file-key-0123456789");
  });

  it("lets MUSIC_SERVER and MUSIC_API_KEY override the file field by field", async () => {
    await Effect.runPromise(saveCredentials(pathsFor(home), credentials));

    const loaded = await Effect.runPromise(
      loadCredentials(env({ key: Option.some(Redacted.make("mk_env-key")) })),
    );

    expect(loaded.server).toBe(credentials.server);
    expect(Redacted.value(loaded.key)).toBe("mk_env-key");

    const fromEnvOnly = await Effect.runPromise(
      Effect.flatMap(clearAll(pathsFor(home)), () =>
        loadCredentials(
          env({
            server: Option.some("http://127.0.0.1:3210"),
            key: Option.some(Redacted.make("mk_env-key")),
          }),
        ),
      ),
    );

    expect(fromEnvOnly.server).toBe("http://127.0.0.1:3210");
  });

  it("fails with not_logged_in when nothing is configured", async () => {
    const result = await load(env());

    expect(result).toMatchObject({ failure: { _tag: "AuthError", code: "not_logged_in" } });
  });

  it("fails with a config error for a corrupt file", async () => {
    await Effect.runPromise(saveCredentials(pathsFor(home), credentials));
    await writeText(pathsFor(home).config, "{not json");

    expect(await load(env())).toMatchObject({ failure: { _tag: "ConfigFileError" } });
  });

  it("caches sessions and forgets everything on logout", async () => {
    const paths = pathsFor(home);

    const session: Session = {
      server: credentials.server,
      keyHash: keyHash(credentials.key),
      token: "header.payload.signature",
      expiresAt: 2_000_000,
    };

    expect(await Effect.runPromise(loadSession(paths))).toEqual(Option.none());

    await Effect.runPromise(saveSession(paths, session));

    expect(await permissions(paths.session)).toBe(0o600);
    expect(await Effect.runPromise(loadSession(paths))).toEqual(Option.some(session));

    await writeText(paths.session, "garbage");

    expect(await Effect.runPromise(loadSession(paths))).toEqual(Option.none());

    await Effect.runPromise(Effect.andThen(saveSession(paths, session), clearAll(paths)));

    expect(await load(env())).toMatchObject({ failure: { _tag: "AuthError" } });
    expect(await Effect.runPromise(loadSession(paths))).toEqual(Option.none());
  });
});

describe("sessionUsable", () => {
  const session: Session = {
    server: credentials.server,
    keyHash: keyHash(credentials.key),
    token: "t",
    expiresAt: 10 * 60_000,
  };

  it("uses a token for the same server and key until a minute before expiry", () => {
    expect(sessionUsable(session, credentials, 0)).toBe(true);
    expect(sessionUsable(session, credentials, 9 * 60_000 - 1)).toBe(true);
    expect(sessionUsable(session, credentials, 9 * 60_000)).toBe(false);
  });

  it("drops the token when the server or key changes", () => {
    expect(sessionUsable(session, { ...credentials, server: "https://other" }, 0)).toBe(false);
    expect(sessionUsable(session, { ...credentials, key: Redacted.make("mk_other") }, 0)).toBe(
      false,
    );
  });
});
