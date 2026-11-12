import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Redacted,
  Schedule,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import { Unauthenticated } from "@media/contracts/errors";

import { createMediaServer } from "../media-server";
import * as FakeConvex from "../testing/fake-convex";
import { jwtExpiringAt, jwtIssuedAt, Reply } from "../testing/fake-convex";
import * as TokenStorage from "../token-storage";
import * as Platform from "./platform";
import { createPlatform } from "./promise";

const HOUR = 3_600_000;

const SERVER = { name: "[media]", version: "0.2.0", hasOwner: true };

const SESSION = {
  userId: "user-1",
  username: "ada",
  role: "member",
  sessionId: "session-1",
  kind: "password",
  scopes: ["account"],
  device: null,
};

const refused = Reply.Failure({ code: "unauthenticated", message: "This session has ended" });

const tokens = (token: string, refreshToken: string) =>
  Reply.Success({ value: { tokens: { token, refreshToken } } });

const noTokens = Reply.Success({ value: { tokens: null } });

/**
 * Answers sign-ins with `signIns[username]` and refreshes with `refreshes[refreshToken]`, and
 * refuses any other refresh, as the server does a refresh token it no longer knows.
 */
const accounts = (
  fake: FakeConvex.FakeConvex,
  signIns: Readonly<Record<string, Reply>>,
  refreshes: Readonly<Record<string, Reply>>,
) =>
  fake.handle("auth:signIn", (request) =>
    Effect.succeed(
      Predicate.hasProperty(request.args, "refreshToken")
        ? (refreshes[String(request.args.refreshToken)] ?? noTokens)
        : (signIns[
            Predicate.hasProperty(request.args, "params") &&
            Predicate.hasProperty(request.args.params, "username")
              ? String(request.args.params.username)
              : ""
          ] ?? noTokens),
    ),
  );

const signInAs = (platform: Platform.Interface, username: string) =>
  platform.session.signIn(
    Platform.Credentials.Password({ username, password: Redacted.make("secret") }),
  );

/** A call the fake holds until the test answers it, with the bearer it arrived with. */
interface Held {
  readonly authorization: string | undefined;
  readonly answer: Deferred.Deferred<Reply>;
}

/** Holds every call to `path` until the test answers it, in arrival order. */
const holdCalls = (fake: FakeConvex.FakeConvex, path: string) =>
  Effect.gen(function* () {
    const arrivals = yield* Queue.unbounded<Held>();

    yield* fake.handle(path, (request) =>
      Effect.gen(function* () {
        const answer = yield* Deferred.make<Reply>();

        yield* Queue.offer(arrivals, { authorization: request.authorization, answer });

        return yield* Deferred.await(answer);
      }),
    );

    return { next: Queue.take(arrivals) };
  });

const refreshesOf = (fake: FakeConvex.FakeConvex) =>
  Effect.map(fake.requestsTo("auth:signIn"), (requests) =>
    requests.flatMap((request) =>
      Predicate.hasProperty(request.args, "refreshToken")
        ? [String(request.args.refreshToken)]
        : [],
    ),
  );

const outcome = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "answered";

  return Option.exists(Exit.findErrorOption(exit), (error) =>
    Predicate.isTagged(error, "Unauthenticated"),
  )
    ? "Unauthenticated"
    : "other";
};

const withPlatform = <A, E>(
  body: (
    platform: Platform.Interface,
    fake: FakeConvex.FakeConvex,
  ) => Effect.Effect<A, E, Scope.Scope>,
  connection: Platform.Options["connection"] = "http",
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        const context = yield* Layer.build(
          Platform.layer({
            url: fake.url,
            connection,
            storage: TokenStorage.layerMemory,
            signIn: Platform.SignInRoute.Boundary({ url: fake.signInUrl }),
          }),
        );

        return yield* body(Context.get(context, Platform.Platform), fake);
      }),
    ),
  );

const bearer = (token: string): string => `Bearer ${token}`;

describe("a refusal fenced on the token the call went out with", () => {
  it("fences on the token renewed while authorizing the call, and leaves a renewed session alone after a delayed refusal", async () => {
    const expiring = jwtExpiringAt(Date.now() + 30_000, "user-1|session-1");
    const renewed = jwtExpiringAt(Date.now() + HOUR, "user-1|session-1");
    const later = jwtExpiringAt(Date.now() + 2 * HOUR, "user-1|session-1");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(
          fake,
          { ada: tokens(expiring, "refresh-1") },
          { "refresh-1": tokens(renewed, "refresh-2"), "refresh-2": tokens(later, "refresh-3") },
        );
        yield* signInAs(platform, "ada");
        const calls = yield* holdCalls(fake, "core/auth/sessions:current");

        const first = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const a = yield* calls.next;
        const second = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const b = yield* calls.next;

        // The first refusal answers the session as renewed while authorizing: one refresh (D51).
        yield* Deferred.succeed(a.answer, refused);
        const firstExit = yield* Fiber.join(first);
        const afterFirst = yield* refreshesOf(fake);

        // The delayed second refusal answers the same token, which that refresh renewed since:
        // it refreshes nothing, ends nothing, and is not sent again.
        yield* Deferred.succeed(b.answer, refused);
        const secondExit = yield* Fiber.join(second);

        return {
          sentWith: (yield* fake.requestsTo("core/auth/sessions:current")).map(
            (request) => request.authorization,
          ),
          afterFirst,
          exits: [outcome(firstExit), outcome(secondExit)],
          refreshes: yield* refreshesOf(fake),
          status: yield* platform.session.currentStatus,
          holder: Option.map(yield* platform.session.accessToken, Redacted.value),
        };
      }),
    );

    expect(answer).toStrictEqual({
      sentWith: [bearer(renewed), bearer(renewed)],
      afterFirst: ["refresh-1", "refresh-2"],
      exits: ["Unauthenticated", "Unauthenticated"],
      refreshes: ["refresh-1", "refresh-2"],
      status: "signedIn",
      holder: Option.some(later),
    });
  });

  it.each([
    ["refuses the call", refused],
    ["rejects the token", Reply.TokenRejected()],
  ])(
    "never sends one person's call again as the next, nor refreshes them, when the server %s",
    async (_, refusal) => {
      const ada = jwtExpiringAt(Date.now() + HOUR, "user-1|session-1");
      const bo = jwtExpiringAt(Date.now() + HOUR, "user-2|session-2");

      const answer = await withPlatform((platform, fake) =>
        Effect.gen(function* () {
          yield* accounts(
            fake,
            { ada: tokens(ada, "ada-refresh-1"), bo: tokens(bo, "bo-refresh-1") },
            {},
          );
          yield* signInAs(platform, "ada");
          const calls = yield* holdCalls(fake, "core/auth/sessions:current");
          const call = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
          const asAda = yield* calls.next;

          yield* signInAs(platform, "bo");
          yield* Deferred.succeed(asAda.answer, refusal);
          const exit = yield* Fiber.join(call);

          return {
            sentWith: (yield* fake.requestsTo("core/auth/sessions:current")).map(
              (request) => request.authorization,
            ),
            exit: outcome(exit),
            refreshes: yield* refreshesOf(fake),
            status: yield* platform.session.currentStatus,
            holder: Option.map(yield* platform.session.accessToken, Redacted.value),
          };
        }),
      );

      expect(answer).toMatchObject({
        sentWith: [bearer(ada)],
        exit: "Unauthenticated",
        refreshes: [],
        status: "signedIn",
        holder: Option.some(bo),
      });
    },
  );

  it("shares one refresh between refusals of one generation when that refresh keeps the token", async () => {
    const token = jwtExpiringAt(Date.now() + HOUR, "user-1|session-1");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(fake, { ada: tokens(token, "refresh-1") }, { "refresh-1": Reply.Drop() });
        yield* signInAs(platform, "ada");
        const calls = yield* holdCalls(fake, "core/auth/sessions:current");

        const first = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const a = yield* calls.next;
        const second = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const b = yield* calls.next;

        // The refresh cannot reach the server, so the session keeps its token.
        yield* Deferred.succeed(a.answer, refused);
        const firstExit = yield* Fiber.join(first);

        yield* Deferred.succeed(b.answer, refused);
        const secondExit = yield* Fiber.join(second);

        return {
          exits: [outcome(firstExit), outcome(secondExit)],
          calls: (yield* fake.requestsTo("core/auth/sessions:current")).length,
          refreshes: yield* refreshesOf(fake),
          status: yield* platform.session.currentStatus,
        };
      }),
    );

    expect(answer).toStrictEqual({
      exits: ["Unauthenticated", "Unauthenticated"],
      calls: 2,
      refreshes: ["refresh-1"],
      status: "signedIn",
    });
  });

  it("subscribes again after a refusal of a token renewed since, and keeps the renewed session", async () => {
    const first = jwtExpiringAt(Date.now() + HOUR, "user-1|session-1");
    const renewed = jwtExpiringAt(Date.now() + 2 * HOUR, "user-1|session-1");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(
          fake,
          { ada: tokens(first, "refresh-1") },
          { "refresh-1": tokens(renewed, "refresh-2") },
        );
        yield* fake.reply("core/accounts/me:changePassword", refused);
        yield* signInAs(platform, "ada");
        const polls = yield* holdCalls(fake, "core/auth/sessions:current");

        const watched = yield* Effect.forkChild(
          Stream.runHead(platform.core.auth.sessions.current.watch()),
        );

        const stale = yield* polls.next;

        // Another call's refusal renews the session while the poll is out with the first token.
        yield* Effect.flip(
          platform.core.accounts.me.changePassword({
            currentPassword: "old-password",
            newPassword: "new-password",
          }),
        );
        yield* Deferred.succeed(stale.answer, refused);
        const again = yield* polls.next;

        yield* Deferred.succeed(again.answer, Reply.Success({ value: SESSION }));

        return {
          sentWith: [stale.authorization, again.authorization],
          head: yield* Fiber.join(watched),
          refreshes: yield* refreshesOf(fake),
          status: yield* platform.session.currentStatus,
        };
      }),
    );

    expect(answer).toMatchObject({
      sentWith: [bearer(first), bearer(renewed)],
      head: { _tag: "Some", value: { sessionId: "session-1" } },
      refreshes: ["refresh-1"],
      status: "signedIn",
    });
  });
});

describe("a refusal over the WebSocket connection", () => {
  it("subscribes again with the renewed token, and signs out once the server refuses that too", async () => {
    // Tokens with `iat`, so the connection renews only near their expiry.
    const first = jwtIssuedAt(Date.now(), 3600, "user-1|session-1");
    const connected = jwtIssuedAt(Date.now(), 5400, "user-1|session-1");
    const renewed = jwtIssuedAt(Date.now(), 7200, "user-1|session-1");

    const answer = await withPlatform(
      (platform, fake) =>
        Effect.gen(function* () {
          yield* accounts(
            fake,
            { ada: tokens(first, "refresh-1") },
            {
              "refresh-1": tokens(connected, "refresh-2"),
              "refresh-2": tokens(renewed, "refresh-3"),
            },
          );
          yield* fake.reply("core/server:info", Reply.Success({ value: SERVER }));
          yield* signInAs(platform, "ada");

          // The connection renews the session once as it first signs in.
          yield* refreshesOf(fake).pipe(
            Effect.repeat({
              until: (refreshes) => refreshes.length === 1,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout(Duration.seconds(5)),
          );
          yield* platform.core.server.info();

          // A call to another server renews the session again; the connection keeps its token,
          // which stays valid until it expires.
          yield* Effect.flip(
            platform.session.refreshOnRefusal(() =>
              Effect.fail(new Unauthenticated({ message: "Wrong password" })),
            ),
          );

          // Then the session ends on the server, which refuses every query from then on. The
          // subscription's refusal names the connection's older token, so the connection takes
          // the renewed one and subscribes again; that refusal is the session's own (D51).
          yield* fake.reply("core/auth/sessions:current", refused);

          const failure = yield* Effect.flip(
            Stream.runHead(platform.core.auth.sessions.current.watch()),
          ).pipe(Effect.timeout(Duration.seconds(5)));

          // The one refresh for the renewed token is refused, which signs the session out.
          const status = yield* platform.session.currentStatus.pipe(
            Effect.repeat({
              until: (now) => now === "signedOut",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout(Duration.seconds(5)),
          );

          return {
            failure,
            refreshes: yield* refreshesOf(fake),
            status,
            sentWith: (yield* fake.requestsTo("core/auth/sessions:current")).map(
              (request) => request.authorization,
            ),
          };
        }),
      "websocket",
    );

    expect(answer).toMatchObject({
      failure: { _tag: "Unauthenticated" },
      refreshes: ["refresh-1", "refresh-2", "refresh-3"],
      status: "signedOut",
    });
    // The subscription went out again, and the second request carried the renewed token.
    expect(answer.sentWith.slice(0, 2)).toStrictEqual([bearer(connected), bearer(renewed)]);
  });
});

describe("the web clients' media server calls", () => {
  it("refresh once after the media server refuses the session, and sign out when that is refused", async () => {
    const token = jwtExpiringAt(Date.now() + HOUR, "user-1|session-1");
    const bearers: Array<string | undefined> = [];

    const media = createServer((request: IncomingMessage, response: ServerResponse) => {
      bearers.push(request.headers.authorization);
      request.resume();
      request.on("end", () => {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ code: "unauthenticated", message: "This session has ended" }));
      });
    });

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          yield* accounts(fake, { ada: tokens(token, "refresh-1") }, {});

          const url = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<string>((resolve) => {
                  media.listen(0, "127.0.0.1", () => {
                    const address = media.address();

                    resolve(
                      address === null || Predicate.isString(address)
                        ? ""
                        : `http://127.0.0.1:${address.port}`,
                    );
                  });
                }),
            ),
            () =>
              Effect.promise(() => new Promise<void>((resolve) => media.close(() => resolve()))),
          );

          const platform = createPlatform({
            url: fake.url,
            signInUrl: fake.signInUrl,
            connection: "http",
          });

          const outcomes = yield* Effect.promise(async () => {
            await platform.session.signInWithPassword({ username: "ada", password: "secret" });
            const server = createMediaServer({ url, session: platform.session });

            const rejected = await server
              .reportError({
                platform: "web",
                appVersion: "0.2.0",
                kind: "render",
                route: "/",
                name: "Error",
                message: "boom",
              })
              .then(
                () => null,
                (error: Error) => error,
              );

            const status = await platform.session.status();

            await platform.dispose();

            return { rejected, status };
          });

          return { ...outcomes, refreshes: yield* refreshesOf(fake) };
        }),
      ),
    );

    expect(answer).toMatchObject({
      rejected: { _tag: "Unauthenticated" },
      status: "signedOut",
      refreshes: ["refresh-1"],
    });
    expect(bearers).toStrictEqual([bearer(token)]);
  });
});

describe("the verifier's probes on #146", () => {
  it("never sends a refused call again, so Ada's call never goes out as Bo", async () => {
    const ada = jwtExpiringAt(Date.now() + HOUR, "ada|session-a");
    const expiring = jwtExpiringAt(Date.now() + 30_000, "ada|session-a");
    const bo = jwtExpiringAt(Date.now() + HOUR, "bo|session-b");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(
          fake,
          { ada: tokens(ada, "r1"), bo: tokens(bo, "br1") },
          { r1: tokens(expiring, "r2") },
        );
        yield* fake.reply("core/auth/sessions:revoke", Reply.Success({ value: null }));
        yield* signInAs(platform, "ada");
        const calls = yield* holdCalls(fake, "core/auth/sessions:current");
        const first = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const initial = yield* calls.next;

        // Another call renews Ada to a token about to expire, so a second send would renew again.
        yield* Effect.flip(
          platform.session.refreshOnRefusal(() =>
            Effect.fail(new Unauthenticated({ message: "renew Ada" })),
          ),
        );

        // A renewal waits until Ada has signed out and Bo has signed in.
        const renewalArrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<Reply>();

        yield* fake.handle("auth:signIn", (request) =>
          Predicate.hasProperty(request.args, "refreshToken")
            ? Deferred.succeed(renewalArrived, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              )
            : Effect.succeed(tokens(bo, "br1")),
        );
        yield* fake.reply("core/auth/sessions:current", Reply.Success({ value: SESSION }));
        yield* Deferred.succeed(initial.answer, refused);

        const settled = yield* Effect.raceFirst(
          Deferred.await(renewalArrived).pipe(Effect.as("renewing")),
          Fiber.await(first).pipe(Effect.as("answered")),
        );

        yield* platform.session.signOut;
        yield* signInAs(platform, "bo");
        yield* Deferred.succeed(
          release,
          tokens(jwtExpiringAt(Date.now() + 2 * HOUR, "ada|session-a"), "r3"),
        );
        const exit = yield* Fiber.join(first);

        return {
          settled,
          sentWith: (yield* fake.requestsTo("core/auth/sessions:current")).map(
            (request) => request.authorization,
          ),
          exit: outcome(exit),
        };
      }),
    );

    expect(answer).toStrictEqual({
      settled: "answered",
      sentWith: [bearer(ada)],
      exit: "Unauthenticated",
    });
  });

  it("sends a call once when the token is rejected, with no resend from the connection or the client", async () => {
    const t1 = jwtExpiringAt(Date.now() + HOUR, "ada|session-a");
    const t2 = jwtExpiringAt(Date.now() + 2 * HOUR, "ada|session-a");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(fake, { ada: tokens(t1, "r1") }, { r1: tokens(t2, "r2") });
        yield* signInAs(platform, "ada");
        const calls = yield* holdCalls(fake, "core/auth/sessions:current");
        const first = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const initial = yield* calls.next;

        // Any later send is refused at once, so a resend shows as a second request.
        yield* fake.reply("core/auth/sessions:current", refused);
        yield* Deferred.succeed(initial.answer, Reply.TokenRejected());
        const exit = yield* Fiber.join(first);

        return {
          calls: (yield* fake.requestsTo("core/auth/sessions:current")).length,
          exit: outcome(exit),
          refreshes: yield* refreshesOf(fake),
          status: yield* platform.session.currentStatus,
        };
      }),
    );

    expect(answer).toStrictEqual({
      calls: 1,
      exit: "Unauthenticated",
      refreshes: ["r1"],
      status: "signedIn",
    });
  });

  it("keeps a renewed session when the WebSocket connection's older token is refused", async () => {
    const first = jwtIssuedAt(Date.now(), 3600, "ada|session-a");
    const connected = jwtIssuedAt(Date.now(), 5400, "ada|session-a");
    const renewed = jwtIssuedAt(Date.now(), 7200, "ada|session-a");
    const confirmed = jwtIssuedAt(Date.now(), 9000, "ada|session-a");

    const answer = await withPlatform(
      (platform, fake) =>
        Effect.gen(function* () {
          // The connection renews once each time it takes a new token source, as at sign-in.
          yield* accounts(
            fake,
            { ada: tokens(first, "r1") },
            { r1: tokens(connected, "r2"), r2: tokens(renewed, "r3"), r3: tokens(confirmed, "r4") },
          );
          yield* fake.reply("core/server:info", Reply.Success({ value: SERVER }));
          yield* signInAs(platform, "ada");
          yield* refreshesOf(fake).pipe(
            Effect.repeat({
              until: (refreshes) => refreshes.length === 1,
              schedule: Schedule.spaced("10 millis"),
            }),
            Effect.timeout(Duration.seconds(5)),
          );
          yield* platform.core.server.info();
          yield* Effect.flip(
            platform.session.refreshOnRefusal(() =>
              Effect.fail(new Unauthenticated({ message: "renew" })),
            ),
          );
          yield* fake.handle("core/auth/sessions:current", (request) =>
            Effect.succeed(
              request.authorization === bearer(connected)
                ? refused
                : Reply.Success({ value: SESSION }),
            ),
          );

          const exit = yield* Effect.exit(
            Stream.runHead(platform.core.auth.sessions.current.watch()),
          ).pipe(Effect.timeout(Duration.seconds(5)));

          return {
            exit: outcome(exit),
            status: yield* platform.session.currentStatus,
            refreshes: yield* refreshesOf(fake),
            sentWith: (yield* fake.requestsTo("core/auth/sessions:current")).map(
              (request) => request.authorization,
            ),
          };
        }),
      "websocket",
    );

    expect(answer).toMatchObject({ exit: "answered", status: "signedIn" });
    expect(answer.refreshes.slice(0, 2)).toStrictEqual(["r1", "r2"]);
    expect(answer.sentWith.slice(0, 2)).toStrictEqual([bearer(connected), bearer(renewed)]);
  });

  it("settles another person's delayed refusal at once while the session's refresh is out", async () => {
    const ada = jwtExpiringAt(Date.now() + HOUR, "ada|session-a");
    const bo = jwtExpiringAt(Date.now() + HOUR, "bo|session-b");

    const answer = await withPlatform((platform, fake) =>
      Effect.gen(function* () {
        yield* accounts(fake, { ada: tokens(ada, "r1"), bo: tokens(bo, "br1") }, {});
        yield* signInAs(platform, "ada");
        const calls = yield* holdCalls(fake, "core/auth/sessions:current");
        const stale = yield* Effect.forkChild(Effect.exit(platform.core.auth.sessions.current()));
        const held = yield* calls.next;

        yield* signInAs(platform, "bo");

        // Bo's refusal starts the refresh of Bo's generation, which the server holds.
        const renewalArrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<Reply>();

        yield* fake.handle("auth:signIn", () =>
          Deferred.succeed(renewalArrived, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );

        const refreshing = yield* Effect.forkChild(
          Effect.exit(
            platform.session.refreshOnRefusal(() =>
              Effect.fail(new Unauthenticated({ message: "Bo's refusal" })),
            ),
          ),
        );

        yield* Deferred.await(renewalArrived);
        yield* Deferred.succeed(held.answer, refused);
        const settled = yield* Fiber.await(stale).pipe(Effect.timeoutOption(Duration.millis(200)));

        yield* Deferred.succeed(
          release,
          tokens(jwtExpiringAt(Date.now() + 2 * HOUR, "bo|session-b"), "br2"),
        );
        yield* Fiber.join(refreshing);

        return {
          settledWhileRefreshOut: Option.isSome(settled),
          exit: outcome(yield* Fiber.join(stale)),
          status: yield* platform.session.currentStatus,
          refreshes: yield* refreshesOf(fake),
        };
      }),
    );

    expect(answer).toStrictEqual({
      settledWhileRefreshOut: true,
      exit: "Unauthenticated",
      status: "signedIn",
      refreshes: ["br1"],
    });
  });
});
