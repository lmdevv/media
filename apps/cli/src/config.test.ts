import { join } from "node:path";

import { TokenStorage } from "@media/sdk/effect";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import type { Environment, StoredConfig } from "./config";
import { layerProfileStorage, loadConfig, resolveTarget, saveConfig } from "./config";
import { makeTempDir, permissions, removeDir } from "./testing/process";

const dir = await makeTempDir("movies-config-test-");

afterAll(() => removeDir(dir));

const env = (overrides: Partial<Environment>): Environment => ({
  configPath: join(dir, "movies", "config.json"),
  convexUrl: Option.none(),
  mediaUrl: Option.none(),
  apiKey: Option.none(),
  profile: Option.none(),
  ...overrides,
});

const config: StoredConfig = {
  defaultProfile: "home",
  profiles: {
    home: { convexUrl: "https://home.example/convex", deviceId: "cli-home", apiKey: "mk_home" },
    work: { convexUrl: "https://work.example/convex", deviceId: "cli-work" },
  },
};

describe("target resolution", () => {
  it("prefers the flag, then MEDIA_PROFILE, then the stored default", () => {
    expect(resolveTarget(config, env({}), Option.none()).name).toBe("home");
    expect(resolveTarget(config, env({ profile: Option.some("work") }), Option.none()).name).toBe(
      "work",
    );
    expect(
      resolveTarget(config, env({ profile: Option.some("work") }), Option.some("home")).name,
    ).toBe("home");
  });

  it("lets the environment override the stored server and key", () => {
    const target = resolveTarget(
      config,
      env({
        convexUrl: Option.some("https://env.example/convex"),
        apiKey: Option.some(Redacted.make("mk_env")),
      }),
      Option.none(),
    );

    expect(Option.getOrNull(target.convexUrl)).toBe("https://env.example/convex");
    expect(Option.map(target.apiKey, Redacted.value)).toStrictEqual(Option.some("mk_env"));
    expect(target.apiKeyFromEnvironment).toBe(true);
  });

  it("keeps the stored profile's credentials away from another server in MEDIA_CONVEX_URL", () => {
    const target = resolveTarget(
      config,
      env({ convexUrl: Option.some("https://other.example/convex") }),
      Option.none(),
    );

    expect(Option.getOrNull(target.convexUrl)).toBe("https://other.example/convex");
    expect(target.stored).toStrictEqual(Option.none());
    expect(target.shadowed).toStrictEqual(Option.fromNullishOr(config.profiles["home"]));
    expect(target.apiKey).toStrictEqual(Option.none());
    expect(target.sessionStorage).toBe("memory");
  });

  it("uses the stored profile when MEDIA_CONVEX_URL names its server", () => {
    const target = resolveTarget(
      config,
      env({ convexUrl: Option.some("https://home.example/convex") }),
      Option.none(),
    );

    expect(target.stored).toStrictEqual(Option.fromNullishOr(config.profiles["home"]));
    expect(Option.map(target.apiKey, Redacted.value)).toStrictEqual(Option.some("mk_home"));
    expect(target.sessionStorage).toBe("profile");
  });
});

describe("the config file", () => {
  it("round-trips with mode 0600 and stores sessions per profile", async () => {
    const path = env({}).configPath;

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* saveConfig(path, config);
        expect(yield* loadConfig(path)).toStrictEqual(config);
        expect(yield* Effect.promise(() => permissions(path))).toBe(0o600);

        const storage = Context.get(
          yield* Effect.scoped(Layer.build(layerProfileStorage(path, "work", Option.none()))),
          TokenStorage.TokenStorage,
        );

        yield* storage.save({
          token: Redacted.make("jwt"),
          refreshToken: Redacted.make("refresh"),
        });
        expect((yield* loadConfig(path)).profiles["work"]?.session).toStrictEqual({
          token: "jwt",
          refreshToken: "refresh",
        });
        expect(Option.isSome(yield* storage.load)).toBe(true);

        yield* storage.clear;
        expect((yield* loadConfig(path)).profiles["work"]).toStrictEqual(config.profiles["work"]);
      }),
    );
  });
});
