import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Redacted } from "effect";

import * as MediaConfig from "./media-config.ts";

const decode = (env: Readonly<Record<string, string>>) =>
  Layer.build(
    MediaConfig.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              MEDIA_BASE_URL: "http://127.0.0.1:4300",
              DATA_DIR: "/nonexistent/data",
              TRANSCODE_DIR: "/nonexistent/transcode",
              HARDWARE_ACCELERATION: "none",
              ...env,
            },
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.map((context) => Context.get(context, MediaConfig.Service)),
    Effect.scoped,
    Effect.exit,
  );

/** The TMDB key `env` resolves to, unredacted. */
const tmdbKey = (env: Readonly<Record<string, string>>) =>
  decode(env).pipe(Effect.map(Exit.map((config) => Option.map(config.tmdbApiKey, Redacted.value))));

describe("media configuration", () => {
  it.effect("keeps the retained log at least 8 MiB, so it always holds several files", () =>
    Effect.gen(function* () {
      for (const tooSmall of ["0", "1", "7"]) {
        assert.isTrue(Exit.isFailure(yield* decode({ LOG_MAX_MB: tooSmall })), tooSmall);
      }

      const smallest = yield* decode({ LOG_MAX_MB: "8" });

      assert.deepStrictEqual(
        Exit.map(smallest, (config) => config.logs.maxBytes),
        Exit.succeed(8 * 1024 * 1024),
      );
    }),
  );

  it.effect("reads the core's ticket key ring as a secret, and none when unset", () =>
    Effect.gen(function* () {
      const set = yield* decode({ MEDIA_TICKET_KEYS: "k1:secret" });
      const unset = yield* decode({});

      assert.deepStrictEqual(
        Exit.map(set, (config) => Option.map(config.mediaTicketKeys, Redacted.value)),
        Exit.succeed(Option.some("k1:secret")),
      );
      assert.deepStrictEqual(
        Exit.map(unset, (config) => config.mediaTicketKeys),
        Exit.succeed(Option.none()),
      );
    }),
  );

  it.effect(
    "uses TMDB with the built-in key by default, a given key instead, and none when off",
    () =>
      Effect.gen(function* () {
        const builtIn = yield* tmdbKey({});

        assert.isTrue(Exit.isSuccess(builtIn) && Option.isSome(builtIn.value));
        assert.deepStrictEqual(yield* tmdbKey({ TMDB_API_KEY: "" }), builtIn);
        assert.deepStrictEqual(yield* tmdbKey({ TMDB: "on" }), builtIn);
        assert.deepStrictEqual(
          yield* tmdbKey({ TMDB_API_KEY: "own-key" }),
          Exit.succeed(Option.some("own-key")),
        );
        assert.deepStrictEqual(yield* tmdbKey({ TMDB: "off" }), Exit.succeed(Option.none()));
        assert.deepStrictEqual(
          yield* tmdbKey({ TMDB: "off", TMDB_API_KEY: "own-key" }),
          Exit.succeed(Option.none()),
        );
        assert.isTrue(Exit.isFailure(yield* tmdbKey({ TMDB: "yes" })));
      }),
  );
});
