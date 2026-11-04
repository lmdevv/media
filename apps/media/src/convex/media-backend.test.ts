import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Logger,
  Predicate,
  Redacted,
  Schedule,
} from "effect";

import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { jwtIssuedAt, Reply } from "@media/sdk/testing/fake-convex";

import * as MediaBackend from "./media-backend.ts";

const SESSION_STATUS = "mediaService:sessionStatus";

/** The session Convex Auth names in every token for the service's key: `userId|sessionId`. */
const KEY_SESSION = "service|key-session";

/** Tokens for the key's session, signed now; a later second gives a different token. */
const keySession = (refreshToken: string) =>
  Reply.Success({
    value: { tokens: { token: jwtIssuedAt(Date.now(), 3600, KEY_SESSION), refreshToken } },
  });

const isRefresh = (request: FakeConvex.RecordedRequest) =>
  Predicate.hasProperty(request.args, "refreshToken");

/**
 * A Convex deployment that, as the real one does, signs every sign-in with one API key into that
 * key's one session, and knows no playback session.
 */
const makeConvex = Effect.gen(function* () {
  const fake = yield* FakeConvex.make;
  let refreshTokens = 0;

  yield* fake.handle("auth:signIn", () =>
    Effect.sync(() => {
      refreshTokens += 1;

      return keySession(`refresh-${String(refreshTokens)}`);
    }),
  );
  yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
  yield* fake.reply(SESSION_STATUS, Reply.Success({ value: null }));

  return fake;
});

const connect = (fake: FakeConvex.FakeConvex) =>
  Layer.build(
    MediaBackend.layer({
      convexUrl: fake.url,
      apiKey: Redacted.make("mk_service"),
      callTimeout: Duration.seconds(2),
      probeEvery: Duration.seconds(1),
    }),
  ).pipe(Effect.map((context) => Context.get(context, MediaBackend.Service)));

const awaitStatus = (backend: MediaBackend.Interface, status: "connected" | "connecting") =>
  backend.status.pipe(
    Effect.repeat({
      until: (current) => current === status,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout(Duration.seconds(10)),
  );

const sessionStatus = (backend: MediaBackend.Interface) =>
  backend.call("mediaService.sessionStatus", { sessionId: "no-such-session" });

describe("media service Convex connection", () => {
  it.live(
    "signs in again when Convex stops taking its token without saying so",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const backend = yield* connect(fake);

        yield* awaitStatus(backend, "connected");
        const refused = new Set(yield* fake.acceptedTokens);

        // The Convex client reconnects presenting the refused token, and is never told why.
        yield* fake.refuseAcceptedTokens;

        const recovered = yield* sessionStatus(backend).pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
        );

        assert.strictEqual(recovered, null);
        assert.isTrue((yield* fake.acceptedTokens).some((token) => !refused.has(token)));
        yield* awaitStatus(backend, "connected");
      }),
    40_000,
  );

  it.live(
    "stays connected while idle, and reports connecting while Convex does not answer",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const backend = yield* connect(fake);

        yield* awaitStatus(backend, "connected");

        yield* Effect.sleep(Duration.seconds(4));
        assert.strictEqual(yield* backend.status, "connected");

        const answering = yield* Deferred.make<void>();

        yield* fake.handle(SESSION_STATUS, () =>
          Deferred.await(answering).pipe(Effect.as(Reply.Success({ value: [] }))),
        );

        yield* awaitStatus(backend, "connecting");

        yield* fake.reply(SESSION_STATUS, Reply.Success({ value: null }));
        yield* Deferred.succeed(answering, undefined);

        yield* awaitStatus(backend, "connected");
      }),
    40_000,
  );

  it.live(
    "reports connected soon after Convex answers again, not a probe interval later",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const answering = yield* Deferred.make<void>();

        // Convex takes the sign-in but answers no query yet, as while the connection is still
        // waiting out its reconnect backoff after an outage.
        yield* fake.handle(SESSION_STATUS, () =>
          Deferred.await(answering).pipe(Effect.as(Reply.Success({ value: [] }))),
        );

        const backend = yield* Layer.build(
          MediaBackend.layer({
            convexUrl: fake.url,
            apiKey: Redacted.make("mk_service"),
            callTimeout: Duration.seconds(1),
            probeEvery: Duration.seconds(30),
          }),
        ).pipe(Effect.map((context) => Context.get(context, MediaBackend.Service)));

        yield* fake.requestsTo("auth:signIn").pipe(
          Effect.repeat({
            until: (requests) => requests.filter((r) => !isRefresh(r)).length >= 2,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout(Duration.seconds(10)),
        );
        yield* Effect.sleep(Duration.seconds(2));
        assert.strictEqual(yield* backend.status, "connecting");

        yield* Deferred.succeed(answering, undefined);
        yield* awaitStatus(backend, "connected").pipe(Effect.timeout(Duration.seconds(5)));
      }),
    40_000,
  );

  it.live(
    "stays connected and says why when Convex answers a probe with a failure",
    () => {
      const logged: Array<unknown> = [];

      const capture = Logger.make((entry) => {
        logged.push(entry.message);
      });

      return Effect.gen(function* () {
        const loggers = yield* Layer.build(Logger.layer([capture]));

        yield* Effect.gen(function* () {
          const fake = yield* makeConvex;

          yield* fake.reply(SESSION_STATUS, Reply.Crash({ message: "sessionStatus broke" }));
          const backend = yield* connect(fake);

          yield* Effect.sync(() => JSON.stringify(logged)).pipe(
            Effect.repeat({
              until: (text) => text.includes("MediaBackend.probe_failed"),
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeout(Duration.seconds(10)),
          );

          // Convex answered, so the connection works; the failure is the function's.
          assert.strictEqual(yield* backend.status, "connected");
        }).pipe(Effect.provideContext(loggers));
      });
    },
    20_000,
  );

  it.live(
    "keeps the session it signed in again to when an earlier refresh lands late",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;
        const refreshing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let refreshes = 0;

        yield* fake.handle("auth:signIn", (request) =>
          Effect.gen(function* () {
            if (!isRefresh(request)) return keySession("signed-in");
            refreshes += 1;

            if (refreshes === 1) {
              yield* Deferred.succeed(refreshing, undefined);
              yield* Deferred.await(release);
            }

            return keySession(`refreshed-${String(refreshes)}`);
          }),
        );

        const backend = yield* connect(fake);

        yield* Deferred.await(refreshing).pipe(Effect.timeout(Duration.seconds(10)));
        yield* awaitStatus(backend, "connected");
        // A new second, so signing in again mints a token the fake has not refused.
        yield* Effect.sleep(Duration.millis(1100));
        yield* fake.refuseAcceptedTokens;

        yield* fake.requestsTo("auth:signIn").pipe(
          Effect.repeat({
            until: (requests) => requests.filter((r) => !isRefresh(r)).length >= 2,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout(Duration.seconds(10)),
        );
        yield* Deferred.succeed(release, undefined);

        const recovered = yield* sessionStatus(backend).pipe(
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
        );

        assert.strictEqual(recovered, null);
        assert.deepStrictEqual(yield* fake.requestsTo("auth:signOut"), []);
      }),
    40_000,
  );

  it.live(
    "holds one probe at a time while Convex takes sign-ins but answers no query",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeConvex;

        const backend = yield* Layer.build(
          MediaBackend.layer({
            convexUrl: fake.url,
            apiKey: Redacted.make("mk_service"),
            callTimeout: Duration.millis(100),
            probeEvery: Duration.millis(100),
          }),
        ).pipe(Effect.map((context) => Context.get(context, MediaBackend.Service)));

        yield* awaitStatus(backend, "connected");

        // Each probe cycle asks about a new session ID; the client sends every query it still holds
        // each time it reconnects.
        yield* fake.reply(SESSION_STATUS, Reply.Drop());
        yield* Effect.sleep(Duration.seconds(5));

        const asked = new Set(
          (yield* fake.requestsTo(SESSION_STATUS)).map((request) => JSON.stringify(request.args)),
        );

        assert.isAbove(asked.size, 2);

        yield* fake.reply(SESSION_STATUS, Reply.Success({ value: null }));
        yield* awaitStatus(backend, "connected");
        assert.strictEqual(yield* fake.peakSubscriptions(SESSION_STATUS), 1);
      }),
    40_000,
  );
});
