import { Brand, Context, Effect, Layer, Predicate, Redacted } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as FakeConvex from "../testing/fake-convex";
import { jwtExpiringAt, Reply } from "../testing/fake-convex";
import * as TokenStorage from "../token-storage";
import * as Platform from "./platform";
import { createPlatform } from "./promise";
import type { Id } from "./command";

const TOKEN = jwtExpiringAt(Date.now() + 3_600_000, "user-1|session-1");

const signedIn = Reply.Success({ value: { tokens: { token: TOKEN, refreshToken: "refresh-1" } } });

const SERVER = { name: "[media]", version: "0.2.0", hasOwner: true };

const withPlatform = <A, E>(
  body: (
    platform: Platform.Interface,
    fake: FakeConvex.FakeConvex,
  ) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        const context = yield* Layer.build(
          Platform.layer({
            url: fake.url,
            connection: "http",
            storage: TokenStorage.layerMemory,
          }),
        );

        return yield* body(Context.get(context, Platform.Platform), fake);
      }),
    ),
  );

const RENEWED = jwtExpiringAt(Date.now() + 7_200_000, "user-1|session-1");

const refusedAfterSignIn = (refresh: Reply) =>
  withPlatform((platform, fake) =>
    Effect.gen(function* () {
      yield* fake.handle("auth:signIn", (request) =>
        Effect.succeed(Predicate.hasProperty(request.args, "refreshToken") ? refresh : signedIn),
      );
      yield* fake.reply(
        "core/accounts/me:changePassword",
        Reply.Failure({ code: "unauthenticated", message: "Wrong password" }),
      );
      yield* platform.session.signIn(
        Platform.Credentials.Password({ username: "ada", password: Redacted.make("secret") }),
      );

      const failure = yield* Effect.flip(
        platform.core.accounts.me.changePassword({
          currentPassword: "wrong",
          newPassword: "new-password",
        }),
      );

      return {
        failure,
        status: yield* platform.session.currentStatus,
        calls: (yield* fake.requestsTo("core/accounts/me:changePassword")).length,
        signIns: (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
      };
    }),
  );

describe("Platform", () => {
  it("runs a command as the method at its name's path", async () => {
    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply("core/server:info", Reply.Success({ value: SERVER }));

        const info = yield* platform.core.server.info();
        const requests = yield* fake.requestsTo("core/server:info");

        return { info, requests: requests.map((request) => [request.kind, request.args]) };
      }),
    );

    expect(answer).toStrictEqual({ info: SERVER, requests: [["query", {}]] });
  });

  it("fails with a protocol error when the answer does not match the command", async () => {
    const failure = await withPlatform((platform, fake) =>
      fake
        .reply("core/server:info", Reply.Success({ value: { name: 7 } }))
        .pipe(Effect.andThen(Effect.flip(platform.core.server.info()))),
    );

    expect(failure).toMatchObject({ _tag: "ProtocolError", operation: "core.server.info" });
  });

  it("turns each refusal into its tagged error, and stale_revision into a protocol error", async () => {
    const failures = await withPlatform((platform, fake) =>
      Effect.forEach(["forbidden", "unauthenticated", "stale_revision"] as const, (code) =>
        fake
          .reply("core/auth/sessions:endAll", Reply.Failure({ code, message: code }))
          .pipe(
            Effect.andThen(Effect.flip(platform.core.auth.sessions.endAll({ keepCurrent: true }))),
          ),
      ),
    );

    expect(failures).toMatchObject([
      { _tag: "Forbidden", message: "forbidden" },
      { _tag: "Unauthenticated", message: "unauthenticated" },
      { _tag: "ProtocolError" },
    ]);
  });

  describe("a command refused as unauthenticated", () => {
    it("shows signed out at once when the server refuses the refresh", async () => {
      expect(await refusedAfterSignIn(Reply.Success({ value: { tokens: null } }))).toMatchObject({
        failure: { _tag: "Unauthenticated", message: "Wrong password" },
        status: "signedOut",
        calls: 1,
        signIns: [
          { provider: "password", params: { username: "ada", password: "secret" } },
          { refreshToken: "refresh-1" },
        ],
      });
    });

    it("stays signed in without repeating the call when the refresh renews the session", async () => {
      const renewed = Reply.Success({
        value: { tokens: { token: RENEWED, refreshToken: "refresh-2" } },
      });

      expect(await refusedAfterSignIn(renewed)).toMatchObject({
        failure: { _tag: "Unauthenticated" },
        status: "signedIn",
        calls: 1,
      });
    });

    it("stays signed in when the refresh cannot reach the server", async () => {
      expect(await refusedAfterSignIn(Reply.Drop())).toMatchObject({
        failure: { _tag: "Unauthenticated" },
        status: "signedIn",
        calls: 1,
      });
    });

    it("asks for no refresh while signed out", async () => {
      const answer = await withPlatform((platform, fake) =>
        Effect.gen(function* () {
          yield* fake.reply(
            "core/auth/sessions:current",
            Reply.Failure({ code: "unauthenticated", message: "Sign in first" }),
          );

          const failure = yield* Effect.flip(platform.core.auth.sessions.current());

          return { failure, refreshes: (yield* fake.requestsTo("auth:signIn")).length };
        }),
      );

      expect(answer).toMatchObject({ failure: { _tag: "Unauthenticated" }, refreshes: 0 });
    });
  });

  it("refuses arguments the command does not take before sending them", async () => {
    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          platform.core.auth.apiKeys.create({ name: "ci", scopes: [], expiresInDays: Number.NaN }),
        );

        return { failure, sent: (yield* fake.requestsTo("core/auth/apiKeys:create")).length };
      }),
    );

    expect(answer).toMatchObject({ failure: { _tag: "InvalidArgs" }, sent: 0 });
  });

  it("signs in with a username and password and calls as that session", async () => {
    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", signedIn);
        yield* fake.reply(
          "core/auth/sessions:current",
          Reply.Success({
            value: {
              userId: "user-1",
              username: "ada",
              role: "member",
              sessionId: "session-1",
              kind: "password",
              scopes: ["account"],
            },
          }),
        );
        yield* fake.reply("core/auth/sessions:end", Reply.Success({ value: null }));

        yield* platform.session.signIn(
          Platform.Credentials.Password({ username: "ada", password: Redacted.make("secret") }),
        );

        const me = yield* platform.core.auth.sessions.current();

        yield* platform.core.auth.sessions.end({ sessionId: me.sessionId });

        return {
          status: yield* platform.session.currentStatus,
          signIns: (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
          ended: (yield* fake.requestsTo("core/auth/sessions:end")).map((request) => [
            request.args,
            request.authorization,
          ]),
        };
      }),
    );

    expect(answer).toStrictEqual({
      status: "signedIn",
      signIns: [{ provider: "password", params: { username: "ada", password: "secret" } }],
      ended: [[{ sessionId: "session-1" }, `Bearer ${TOKEN}`]],
    });
  });

  it("signs in with an API key through the apiKey provider", async () => {
    const signIns = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", signedIn);
        yield* platform.session.signIn(
          Platform.Credentials.ApiKey({ key: Redacted.make("mk_1.secret") }),
        );

        return (yield* fake.requestsTo("auth:signIn")).map((request) => request.args);
      }),
    );

    expect(signIns).toStrictEqual([{ provider: "apiKey", params: { key: "mk_1.secret" } }]);
  });

  it("sends setup, invite, and reset sign-ins to their own providers", async () => {
    const signIns = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", signedIn);

        yield* Effect.forEach(
          [
            Platform.Credentials.Setup({ username: "ada", password: Redacted.make("secret") }),
            Platform.Credentials.Invite({
              code: Redacted.make("mi_1.secret"),
              username: "bo",
              password: Redacted.make("secret"),
            }),
            Platform.Credentials.Reset({
              code: Redacted.make("mr_1.secret"),
              password: Redacted.make("secret"),
            }),
          ],
          platform.session.signIn,
        );

        return (yield* fake.requestsTo("auth:signIn")).map((request) => request.args);
      }),
    );

    expect(signIns).toStrictEqual([
      { provider: "setup", params: { username: "ada", password: "secret" } },
      { provider: "invite", params: { code: "mi_1.secret", username: "bo", password: "secret" } },
      { provider: "reset", params: { code: "mr_1.secret", password: "secret" } },
    ]);
  });

  it("waits for a device's approval, then signs it in", async () => {
    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        let polls = 0;

        yield* fake.reply(
          "core/auth/deviceCodes:start",
          Reply.Success({
            value: {
              deviceCode: "dc_1.secret",
              userCode: "BCDF-GHJK",
              expiresAt: Date.now() + 600_000,
              intervalSeconds: 0,
            },
          }),
        );
        yield* fake.handle("auth:signIn", () => {
          polls += 1;

          return Effect.succeed(
            polls < 3 ? Reply.Failure({ code: "pending", message: "Waiting" }) : signedIn,
          );
        });

        const pending = yield* platform.session.startDeviceSignIn("media CLI");

        yield* pending.complete;

        return {
          userCode: pending.userCode,
          status: yield* platform.session.currentStatus,
          started: (yield* fake.requestsTo("core/auth/deviceCodes:start")).map(
            (request) => request.args,
          ),
          polls: (yield* fake.requestsTo("auth:signIn")).map((request) => request.args),
        };
      }),
    );

    const poll = { provider: "deviceCode", params: { deviceCode: "dc_1.secret" } };

    expect(answer).toStrictEqual({
      userCode: "BCDF-GHJK",
      status: "signedIn",
      started: [{ clientName: "media CLI" }],
      polls: [poll, poll, poll],
    });
  });

  it("stops waiting for a device once its code is denied", async () => {
    const refusal = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply(
          "core/auth/deviceCodes:start",
          Reply.Success({
            value: {
              deviceCode: "dc_1.secret",
              userCode: "BCDF-GHJK",
              expiresAt: Date.now() + 600_000,
              intervalSeconds: 0,
            },
          }),
        );
        yield* fake.reply("auth:signIn", Reply.Failure({ code: "denied", message: "Denied" }));

        const pending = yield* platform.session.startDeviceSignIn("media CLI");

        return yield* Effect.flip(pending.complete);
      }),
    );

    expect(refusal).toMatchObject({ _tag: "DeviceSignInRefused", state: "denied" });
  });

  it("ends the wait when the server says the device code expired", async () => {
    const refusal = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* fake.reply(
          "core/auth/deviceCodes:start",
          Reply.Success({
            value: {
              deviceCode: "dc_1.secret",
              userCode: "BCDF-GHJK",
              expiresAt: 0,
              intervalSeconds: 0,
            },
          }),
        );
        yield* fake.reply("auth:signIn", Reply.Failure({ code: "expired", message: "Expired" }));

        const pending = yield* platform.session.startDeviceSignIn("media CLI");

        return yield* Effect.flip(pending.complete);
      }),
    );

    expect(refusal).toMatchObject({ _tag: "DeviceSignInRefused", state: "expired" });
  });
});

describe("createPlatform", () => {
  it("runs commands as Promise methods that reject with tagged errors", async () => {
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          yield* fake.reply("core/server:info", Reply.Success({ value: SERVER }));
          yield* fake.reply(
            "core/auth/sessions:endAll",
            Reply.Failure({ code: "forbidden", message: "This session lacks the account scope" }),
          );

          const platform = createPlatform({ url: fake.url, connection: "http" });

          return yield* Effect.promise(async () => {
            const info = await platform.core.server.info();

            const refused = await platform.core.auth.sessions.endAll({ keepCurrent: false }).then(
              () => null,
              (error: Error) => error,
            );

            const watch = platform.core.server.info.watch();

            const watched = await new Promise((resolve) => {
              const stop = watch.subscribe(() => {
                const state = watch.getSnapshot();

                if (state.status !== "loading") {
                  stop();
                  resolve(state);
                }
              });
            });

            await platform.dispose();

            return { info, refused, watched };
          });
        }),
      ),
    );

    expect(answer).toMatchObject({
      info: SERVER,
      refused: { _tag: "Forbidden", message: "This session lacks the account scope" },
      watched: { status: "success", data: SERVER },
    });
  });
});

describe("opening a tile", () => {
  it("sends the tile provider the device, the person, and the proof given", async () => {
    const ada = Brand.nominal<Id<"users">>()("user-1");
    const approvalId = Brand.nominal<Id<"tileApprovals">>()("approval-1");

    const signIns = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          yield* fake.reply("auth:signIn", signedIn);
          const platform = createPlatform({ url: fake.url, connection: "http" });

          yield* Effect.promise(async () => {
            await platform.session.openTile({ device: "dv_1.secret", userId: ada });
            await platform.session.openTile({
              device: "dv_1.secret",
              userId: ada,
              proof: { kind: "password", by: ada, password: "secret" },
            });
            await platform.session.openTile({
              device: "dv_1.secret",
              userId: ada,
              proof: { kind: "code", by: ada, code: "1234" },
            });
            await platform.session.openTile({
              device: "dv_1.secret",
              userId: ada,
              proof: { kind: "approval", approvalId },
            });
            await platform.dispose();
          });

          return (yield* fake.requestsTo("auth:signIn")).map((request) => request.args);
        }),
      ),
    );

    const tile = { provider: "tile", params: { device: "dv_1.secret", userId: "user-1" } };

    expect(signIns).toStrictEqual([
      tile,
      {
        ...tile,
        params: { ...tile.params, proof: { kind: "password", by: "user-1", password: "secret" } },
      },
      { ...tile, params: { ...tile.params, proof: { kind: "code", by: "user-1", code: "1234" } } },
      {
        ...tile,
        params: { ...tile.params, proof: { kind: "approval", approvalId: "approval-1" } },
      },
    ]);
  });
});
