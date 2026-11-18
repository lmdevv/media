import { inspect } from "node:util";

import { Context, Effect, Layer, Logger, Option, Redacted, References } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { usePlatform } from "../react";
import * as FakeConvex from "../testing/fake-convex";
import { jwtExpiringAt, Reply } from "../testing/fake-convex";
import * as TokenStorage from "../token-storage";
import * as Platform from "./platform";
import { createPlatform } from "../promise";
import type { PlatformGuest, PlatformSession } from "../promise";

const CODE = "mg_link.secret-that-must-stay-private";

const NAME = "Ada";

const START = Date.now();

const TOKEN = jwtExpiringAt(START + 3_600_000, "guest-1|session-1");

const RENEWED = jwtExpiringAt(START + 7_200_000, "guest-1|session-1");

const KEY = "media.session";

const tokens = (token = TOKEN, refreshToken = "refresh-1") =>
  Reply.Success({ value: { tokens: { token, refreshToken } } });

const refusals = [
  {
    code: "expired",
    tag: "Expired",
    message: "This link no longer works; ask whoever shared it for a new one",
  },
  { code: "conflict", tag: "Conflict", message: "This link has let in as many guests as it can" },
  {
    code: "invalid_args",
    tag: "InvalidArgs",
    message: "Give a name of 1 to 32 printable characters",
  },
  {
    code: "rate_limited",
    tag: "RateLimited",
    message: "This link was opened too often; wait a few minutes",
  },
] as const;

const withGuest = <A, E>(
  body: (fixture: {
    readonly platform: Platform.Interface;
    readonly fake: FakeConvex.FakeConvex;
    readonly stored: Map<string, string>;
    readonly logs: Array<string>;
  }) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stored = new Map<string, string>();
        const logs: Array<string> = [];
        const capture = Logger.make((entry) => logs.push(inspect(entry, { depth: 20 })));
        const context = yield* Layer.build(Layer.merge(TestClock.layer(), Logger.layer([capture])));

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const fake = yield* FakeConvex.make;

          const client = yield* Layer.build(
            Platform.layer({
              url: fake.url,
              connection: "http",
              signIn: Platform.SignInRoute.Boundary({ url: fake.signInUrl }),
              storage: TokenStorage.layerKeyValue(
                {
                  getItem: (key) => stored.get(key) ?? null,
                  setItem: (key, value) => {
                    stored.set(key, value);
                  },
                  removeItem: (key) => {
                    stored.delete(key);
                  },
                },
                KEY,
              ),
            }),
          );

          return yield* body({
            platform: Context.get(client, Platform.Platform),
            fake,
            stored,
            logs,
          });
        }).pipe(
          Effect.provideContext(context),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        );
      }),
    ),
  );

describe("guest sign-in", () => {
  it("redacts the guest code when credentials are inspected or serialized", () => {
    const credentials = Platform.Credentials.Guest({ code: Redacted.make(CODE), name: NAME });

    expect(inspect(credentials)).not.toContain(CODE);
    expect(JSON.stringify(credentials)).not.toContain(CODE);
    expect(Redacted.value(credentials.code)).toBe(CODE);
  });

  it("sends the guest provider payload once and persists only session tokens", async () => {
    await withGuest(({ platform, fake, stored, logs }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens());
        yield* platform.session.signInAsGuest({ code: Redacted.make(CODE), name: NAME });

        expect(yield* platform.session.currentStatus).toBe("signedIn");
        expect(
          (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
        ).toStrictEqual([{ provider: "guest", params: { code: CODE, name: NAME } }]);
        expect([...stored.keys()]).toStrictEqual([KEY]);
        expect(
          Option.getOrThrow(TokenStorage.parseStoredSession(stored.get(KEY) ?? "")),
        ).toStrictEqual({
          token: Redacted.make(TOKEN),
          refreshToken: Redacted.make("refresh-1"),
        });
        expect(inspect([...stored])).not.toContain(CODE);
        expect(logs.length).toBeGreaterThan(0);
        expect(inspect(logs)).not.toContain(CODE);
      }),
    );
  });

  it.each(refusals)(
    "returns $tag for $code without storing or logging the code",
    async ({ code, tag, message }) => {
      await withGuest(({ platform, fake, stored, logs }) =>
        Effect.gen(function* () {
          yield* fake.reply("auth:signIn", Reply.Failure({ code, message }));

          const error = yield* Effect.flip(
            platform.session.signInAsGuest({ code: Redacted.make(CODE), name: NAME }),
          );

          expect(error).toMatchObject({ _tag: tag, message });
          expect(inspect(error, { depth: 20 })).not.toContain(CODE);
          expect(JSON.stringify(error)).not.toContain(CODE);
          expect(yield* platform.session.currentStatus).toBe("signedOut");
          expect(stored.size).toBe(0);
          expect(logs.length).toBeGreaterThan(0);
          expect(inspect(logs)).not.toContain(CODE);
          expect((yield* fake.requestsTo("auth:signIn")).length).toBe(1);
        }),
      );
    },
  );

  it("renews with the refresh token and keeps the guest identity without redeeming again", async () => {
    await withGuest(({ platform, fake, stored }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens());
        yield* platform.session.signIn(
          Platform.Credentials.Guest({ code: Redacted.make(CODE), name: NAME }),
        );
        yield* fake.reply("auth:signIn", tokens(RENEWED, "refresh-2"));
        yield* TestClock.setTime(START + 3_600_000 - 30_000);

        expect(Option.map(yield* platform.session.accessToken, Redacted.value)).toStrictEqual(
          Option.some(RENEWED),
        );
        expect(
          (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
        ).toStrictEqual([
          { provider: "guest", params: { code: CODE, name: NAME } },
          { refreshToken: "refresh-1" },
        ]);
        const session = Option.getOrThrow(TokenStorage.parseStoredSession(stored.get(KEY) ?? ""));
        expect(TokenStorage.sessionOf(session)).toStrictEqual(Option.some("guest-1|session-1"));
        expect(Redacted.value(session.refreshToken)).toBe("refresh-2");
        expect(inspect([...stored])).not.toContain(CODE);
      }),
    );
  });

  it("exposes guest sign-in through the promise client and React's shared client", async () => {
    expectTypeOf<ReturnType<typeof usePlatform>["session"]["signInAsGuest"]>().toEqualTypeOf<
      PlatformSession["signInAsGuest"]
    >();
    expectTypeOf<PlatformSession["signInAsGuest"]>().toEqualTypeOf<
      (guest: PlatformGuest) => Promise<void>
    >();
    expectTypeOf<Platform.Session["signInAsGuest"]>().toEqualTypeOf<
      (
        guest: Platform.GuestSignIn,
      ) => Effect.Effect<void, Platform.PlatformError | TokenStorage.TokenStorageError>
    >();

    await withGuest(({ fake }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens());

        const platform = createPlatform({
          url: fake.url,
          signInUrl: fake.signInUrl,
          connection: "http",
        });

        yield* Effect.promise(async () => {
          try {
            await platform.session.signInAsGuest({ code: CODE, name: NAME });
            expect(await platform.session.status()).toBe("signedIn");
          } finally {
            await platform.dispose();
          }
        });
        expect(
          (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
        ).toStrictEqual([{ provider: "guest", params: { code: CODE, name: NAME } }]);
      }),
    );
  });

  it.each(refusals)("rejects the promise with $tag", async ({ code, tag, message }) => {
    await withGuest(({ fake }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Failure({ code, message }));

        const platform = createPlatform({
          url: fake.url,
          signInUrl: fake.signInUrl,
          connection: "http",
        });

        yield* Effect.promise(async () => {
          try {
            await expect(
              platform.session.signInAsGuest({ code: CODE, name: NAME }),
            ).rejects.toMatchObject({ _tag: tag, message });
          } finally {
            await platform.dispose();
          }
        });
      }),
    );
  });
});
