import { inspect } from "node:util";

import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Auth from "./auth";
import * as ConvexTransport from "./convex-transport";
import * as FakeConvex from "./testing/fake-convex";
import { jwtExpiringAt, Reply } from "./testing/fake-convex";
import * as TokenStorage from "./token-storage";
import type { KeyValueStore } from "./token-storage";

const START = 1_760_000_000_000;

const KEY = "movies.session";

const FRESH = jwtExpiringAt(START + 3_600_000, "alex");

const EXPIRING = jwtExpiringAt(START + 30_000, "alex");

const EXPIRED = jwtExpiringAt(START - 600_000, "alex");

const RENEWED = jwtExpiringAt(START + 3_600_000, "alex-renewed");

const ROTATED = "refresh-2";

/** A JWT whose `sub` is a number, which Convex Auth never signs but another issuer might. */
const numericSubject = (expiresAt: number): string =>
  [{ alg: "none" }, { exp: Math.floor(expiresAt / 1000), sub: 7 }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("fake")
    .join(".");

/** Convex Auth's `sub` claim names the user and the session: `userId|sessionId`. */
const KEY_SUBJECT = "service|key-session";

const KEY_SESSION = jwtExpiringAt(START + 3_600_000, KEY_SUBJECT);

interface MemoryStore {
  readonly store: KeyValueStore;
  readonly saved: () => Option.Option<{ readonly token: string; readonly refreshToken: string }>;
  readonly failWrites: (failing: boolean) => void;
  readonly failClears: (failing: boolean) => void;
}

const memoryStore = (initial: Option.Option<{ token: string; refreshToken: string }>) => {
  const items = new Map<string, string>();
  let failing = false;
  let failingClears = false;

  if (Option.isSome(initial)) {
    items.set(
      KEY,
      TokenStorage.serializeSession({
        token: Redacted.make(initial.value.token),
        refreshToken: Redacted.make(initial.value.refreshToken),
      }),
    );
  }

  const memory: MemoryStore = {
    store: {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (failing) throw new Error(`The disk is full; could not write ${value}`);
        items.set(key, value);
      },
      removeItem: (key) => {
        if (failingClears) throw new Error("The disk is read-only");
        items.delete(key);
      },
    },
    saved: () =>
      Option.map(
        Option.flatMap(Option.fromNullishOr(items.get(KEY)), TokenStorage.parseStoredSession),
        (session) => ({
          token: Redacted.value(session.token),
          refreshToken: Redacted.value(session.refreshToken),
        }),
      ),
    failWrites: (next) => {
      failing = next;
    },
    failClears: (next) => {
      failingClears = next;
    },
  };

  return memory;
};

interface Fixture {
  readonly fake: FakeConvex.FakeConvex;
  readonly memory: MemoryStore;
  readonly auth: Auth.Engine;
  readonly logs: () => ReadonlyArray<string>;
}

const withAuth = <A, E>(
  stored: Option.Option<{ token: string; refreshToken: string }>,
  body: (fixture: Fixture) => Effect.Effect<A, E, ConvexTransport.ConvexTransport | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const logged: Array<string> = [];

        const capture = Logger.make((entry) => {
          logged.push(inspect([entry.message, entry.cause], { depth: 20 }));
        });

        const testClock = yield* Layer.build(
          Layer.mergeAll(TestClock.layer(), Logger.layer([capture])),
        );

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const fake = yield* FakeConvex.make;
          const memory = memoryStore(stored);

          const sdk = yield* Layer.build(
            Layer.mergeAll(
              ConvexTransport.layerHttp(fake.url),
              TokenStorage.layerKeyValue(memory.store, KEY),
            ),
          );

          const auth = yield* Auth.makeEngine({ convexUrl: fake.url }).pipe(
            Effect.provideContext(sdk),
          );

          return yield* body({ fake, memory, auth, logs: () => [...logged] }).pipe(
            Effect.provideContext(sdk),
          );
        }).pipe(Effect.provideContext(testClock));
      }),
    ),
  );

const signedInWith = (token: string) => Option.some({ token, refreshToken: "refresh-1" });

const tokens = (token: string, refreshToken: string): Reply =>
  Reply.Success({ value: { tokens: { token, refreshToken } } });

const reveal = (token: Option.Option<Redacted.Redacted>): string | null =>
  Option.match(token, { onNone: () => null, onSome: Redacted.value });

const isReconnecting = (auth: Auth.Interface) =>
  Effect.map(
    Stream.runHead(auth.reconnecting),
    Option.getOrElse(() => false),
  );

const reconnected = (auth: Auth.Interface) =>
  Stream.runHead(Stream.filter(auth.reconnecting, (waiting) => !waiting));

const failForAMinute = (auth: Auth.Interface) =>
  Effect.gen(function* () {
    const answers: Array<string | null> = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) yield* TestClock.adjust(30_000);
      answers.push(reveal(yield* auth.accessToken(true)));
    }

    return answers;
  });

const SERVER_FAILURES = [
  { name: "Internal", reply: Reply.Crash({ message: "Convex is busy" }) },
  {
    name: "ProtocolError",
    reply: Reply.Success({ value: { tokens: { token: 12, refreshToken: 34 } } }),
  },
  // Only `{ tokens: null }` refuses a refresh; an answer without tokens is a broken server.
  { name: "no tokens", reply: Reply.Success({ value: {} }) },
  { name: "a redirect", reply: Reply.Success({ value: { redirect: "https://example.invalid" } }) },
  ...(["not_found", "invalid_args", "conflict", "stale_revision", "internal"] as const).map(
    (code) => ({ name: code, reply: Reply.Failure({ code, message: "Convex is busy" }) }),
  ),
];

const refreshRequests = (fake: FakeConvex.FakeConvex) =>
  Effect.map(fake.requestsTo("auth:signIn"), (requests) =>
    requests.flatMap((request) =>
      Predicate.hasProperty(request.args, "refreshToken") ? [request.args.refreshToken] : [],
    ),
  );

const serverSignOuts = (fake: FakeConvex.FakeConvex, expected: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 50; tries += 1) {
      if ((yield* fake.requestsTo("auth:signOut")).length >= expected) break;
      yield* TestClock.withLive(Effect.sleep(20));
    }

    return (yield* fake.requestsTo("auth:signOut")).map((request) => request.authorization);
  });

const gateRefresh = (fake: FakeConvex.FakeConvex, reply: Reply) =>
  Effect.gen(function* () {
    const arrived = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    yield* fake.handle("auth:signIn", (request) =>
      Predicate.hasProperty(request.args, "refreshToken")
        ? Effect.gen(function* () {
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            return reply;
          })
        : Effect.succeed(tokens(jwtExpiringAt(START + 3_600_000, "sam"), "sam-refresh")),
    );

    return { arrived, release };
  });

describe("Auth", () => {
  it("uses a fresh token without refreshing it", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(reveal(yield* auth.accessToken(false))).toBe(FRESH);
        expect(yield* fake.requests).toStrictEqual([]);
      }),
    ));

  it("refreshes a token about to expire whatever its subject claim holds", () =>
    withAuth(signedInWith(numericSubject(START + 30_000)), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));

        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
      }),
    ));

  it("refreshes a token about to expire once and stores the renewed session", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));

        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: RENEWED, refreshToken: ROTATED }),
        );
      }),
    ));

  it("shares one refresh between concurrent callers", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        const callers = yield* Effect.forkChild(
          Effect.all([auth.accessToken(true), auth.accessToken(true), auth.accessToken(true)], {
            concurrency: "unbounded",
          }),
        );

        yield* Deferred.await(gate.arrived);
        yield* Deferred.succeed(gate.release, undefined);

        expect((yield* Fiber.join(callers)).map(reveal)).toStrictEqual([RENEWED, RENEWED, RENEWED]);
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
      }),
    ));

  it("signs out when the server refuses the refresh token", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));

        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("keeps the current token when the server cannot be reached", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Drop());

        expect(reveal(yield* auth.accessToken(false))).toBe(EXPIRING);
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(memory.saved()).toStrictEqual(signedInWith(EXPIRING));
      }),
    ));

  it("keeps the current token through refreshes the server fails for less than a minute", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));

        for (let attempt = 0; attempt < 10; attempt += 1) {
          expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
          yield* TestClock.adjust(5_000);
        }

        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));

        expect(reveal(yield* auth.accessToken(true))).toBe(RENEWED);
        expect(yield* auth.currentStatus).toBe("signedIn");
      }),
    ));

  it.each(SERVER_FAILURES)(
    "keeps the stored session once the server has failed every refresh for a minute with $name",
    ({ reply }) =>
      withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
        Effect.gen(function* () {
          yield* fake.reply("auth:signIn", reply);

          // The connection gets no token, so it stops waiting for one and runs signed out.
          expect(yield* failForAMinute(auth)).toStrictEqual([FRESH, FRESH, null]);
          expect(memory.saved()).toStrictEqual(signedInWith(FRESH));
          expect(yield* auth.currentStatus).toBe("signedIn");
          expect(yield* isReconnecting(auth)).toBe(true);
        }),
      ),
  );

  it("renews the kept session in the background once the server recovers", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));
        yield* failForAMinute(auth);

        for (let wait = 0; wait < 5; wait += 1) yield* TestClock.adjust(30_000);
        expect(yield* isReconnecting(auth)).toBe(true);

        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* TestClock.adjust(30_000);
        yield* reconnected(auth);

        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: RENEWED, refreshToken: ROTATED }),
        );
        expect(new Set(yield* refreshRequests(fake))).toStrictEqual(new Set(["refresh-1"]));
      }),
    ));

  it("signs out once the server refuses a session it had failed to renew", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));
        yield* failForAMinute(auth);

        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));
        yield* TestClock.adjust(30_000);
        yield* reconnected(auth);

        expect(yield* auth.currentStatus).toBe("signedOut");
        yield* Effect.sync(memory.saved).pipe(
          Effect.repeat({ until: Option.isNone, schedule: Schedule.spaced(10) }),
          Effect.timeout(1000),
          TestClock.withLive,
        );
      }),
    ));

  it("stops renewing a kept session once someone signs in", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.handle("auth:signIn", (request) =>
          Effect.succeed(
            Predicate.hasProperty(request.args, "refreshToken")
              ? Reply.Crash({ message: "Convex is busy" })
              : tokens(jwtExpiringAt(START + 3_600_000, "sam"), "sam-refresh"),
          ),
        );
        yield* failForAMinute(auth);
        yield* auth.open({ provider: "apikey", params: { key: "sam-key" } });
        const asked = (yield* refreshRequests(fake)).length;

        for (let wait = 0; wait < 5; wait += 1) yield* TestClock.adjust(30_000);

        expect(yield* isReconnecting(auth)).toBe(false);
        expect((yield* refreshRequests(fake)).length).toBe(asked);
      }),
    ));

  it("does not count time asleep toward the minute", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));

        // Nothing asks for a token while the device sleeps, so failures an hour apart are not a
        // minute of the server failing.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (attempt > 0) yield* TestClock.adjust(3_600_000);
          expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
        }

        expect(yield* isReconnecting(auth)).toBe(false);
        expect(memory.saved()).toStrictEqual(signedInWith(FRESH));
      }),
    ));

  it("keeps the connection waiting after two failed refreshes, however far apart", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));
        expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
        yield* TestClock.adjust(60_000);
        expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);

        expect(yield* isReconnecting(auth)).toBe(false);
      }),
    ));

  it("starts the minute again after a refresh that cannot reach the server", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));
        expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
        yield* TestClock.adjust(50_000);

        yield* fake.reply("auth:signIn", Reply.Drop());
        expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
        yield* TestClock.adjust(20_000);

        yield* fake.reply("auth:signIn", Reply.Crash({ message: "Convex is busy" }));
        expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
        expect(yield* auth.currentStatus).toBe("signedIn");
      }),
    ));

  it("keeps the session through any number of refreshes that cannot reach the server", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Drop());

        for (let attempt = 0; attempt < 10; attempt += 1) {
          expect(reveal(yield* auth.accessToken(true))).toBe(FRESH);
          yield* TestClock.adjust(60_000);
        }

        expect(yield* auth.currentStatus).toBe("signedIn");
      }),
    ));

  it("keeps the current token when a refresh gets no answer in time", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        const waiting = yield* Effect.forkChild(auth.accessToken(false));

        yield* Deferred.await(gate.arrived);
        yield* TestClock.adjust(60_000);

        expect(reveal(yield* Fiber.join(waiting))).toBe(EXPIRING);
      }),
    ));

  it("does not bring the session back when a refresh lands after sign-out", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.signOut;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(refreshing)).toStrictEqual(Option.none());
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("does not overwrite another account's session when a refresh lands after sign-in", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));
        const sam = jwtExpiringAt(START + 3_600_000, "sam");
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.open({ provider: "apikey", params: { key: "sam-key" } });
        yield* Deferred.succeed(gate.release, undefined);

        expect(reveal(yield* Fiber.join(refreshing))).toBe(sam);
        expect(reveal(yield* auth.accessToken(false))).toBe(sam);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("ends another account's session when its refresh lands after sign-in", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.open({ provider: "apikey", params: { key: "sam-key" } });
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(refreshing);

        expect(yield* serverSignOuts(fake, 1)).toStrictEqual([`Bearer ${RENEWED}`]);
      }),
    ));

  it("keeps an API key's shared session when a refresh of it lands after signing in again", () =>
    withAuth(signedInWith(KEY_SESSION), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        // Every sign-in with one API key shares one session, so a refresh that lands late renews
        // the session the new sign-in holds; ending it would sign the new sign-in out.
        const signedInAgain = jwtExpiringAt(START + 3_660_000, KEY_SUBJECT);
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        yield* fake.handle("auth:signIn", (request) =>
          Predicate.hasProperty(request.args, "refreshToken")
            ? Effect.gen(function* () {
                yield* Deferred.succeed(arrived, undefined);
                yield* Deferred.await(release);

                return tokens(jwtExpiringAt(START + 3_630_000, KEY_SUBJECT), "key-refresh-2");
              })
            : Effect.succeed(tokens(signedInAgain, "key-refresh-3")),
        );
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(arrived);
        yield* auth.open({ provider: "apikey", params: { key: "service-key" } });
        yield* Deferred.succeed(release, undefined);

        expect(reveal(yield* Fiber.join(refreshing))).toBe(signedInAgain);
        expect(yield* serverSignOuts(fake, 1)).toStrictEqual([]);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: signedInAgain, refreshToken: "key-refresh-3" }),
        );
      }),
    ));

  it("does not sign another account out when a stale refresh is refused", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, Reply.Success({ value: { tokens: null } }));
        const sam = jwtExpiringAt(START + 3_600_000, "sam");
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.open({ provider: "apikey", params: { key: "sam-key" } });
        yield* Deferred.succeed(gate.release, undefined);

        expect(reveal(yield* Fiber.join(refreshing))).toBe(sam);
        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("signs out on the server with a renewed token when the stored one expired", () =>
    withAuth(signedInWith(EXPIRED), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));

        yield* auth.signOut;

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${RENEWED}`,
        ]);
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("still signs out locally when storing the renewed token fails", () =>
    withAuth(signedInWith(EXPIRED), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        memory.failWrites(true);

        yield* auth.signOut;

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${RENEWED}`,
        ]);
        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());
      }),
    ));

  it("keeps the rotated refresh token in memory when storing it fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        memory.failWrites(true);

        const failure = yield* Effect.flip(auth.accessToken(false));

        expect(failure).toMatchObject({ _tag: "TokenStorageError", operation: "save" });
        expect(reveal(yield* auth.accessToken(false))).toBe(RENEWED);
        yield* Effect.exit(auth.accessToken(true));
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1", ROTATED]);
      }),
    ));

  it("stores the next renewal once storing works again", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const latest = jwtExpiringAt(START + 7_200_000, "alex-renewed");

        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        memory.failWrites(true);
        yield* Effect.exit(auth.accessToken(false));
        memory.failWrites(false);
        yield* fake.reply("auth:signIn", tokens(latest, "refresh-3"));

        expect(reveal(yield* auth.accessToken(true))).toBe(latest);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: latest, refreshToken: "refresh-3" }),
        );
      }),
    ));

  it("authorizes calls with the renewed token even when storing it fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("deviceAuth:status", Reply.Success({ value: { state: "pending" } }));
        memory.failWrites(true);
        const transport = yield* ConvexTransport.ConvexTransport;

        yield* transport.call("query", "deviceAuth:status", { deviceCode: "device-secret" });

        expect(
          (yield* fake.requestsTo("deviceAuth:status")).map((request) => request.authorization),
        ).toStrictEqual([`Bearer ${RENEWED}`]);
      }),
    ));

  it("signs out locally at once while the server is slow to renew the token", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const signingOut = yield* Effect.forkChild(auth.signOut);

        yield* Deferred.await(gate.arrived);

        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(memory.saved()).toStrictEqual(Option.none());

        yield* TestClock.adjust(60_000);
        yield* Fiber.join(signingOut);
      }),
    ));

  it("keeps a sign-in that lands while the server is ending the previous session", () =>
    withAuth(signedInWith(FRESH), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const sam = jwtExpiringAt(START + 3_600_000, "sam");

        yield* fake.reply("auth:signIn", tokens(sam, "sam-refresh"));
        yield* fake.handle("auth:signOut", () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            return Reply.Success({ value: null });
          }),
        );
        const signingOut = yield* Effect.forkChild(auth.signOut);

        yield* Deferred.await(arrived);
        yield* auth.open({ provider: "apikey", params: { key: "sam-key" } });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(signingOut);

        expect(yield* auth.currentStatus).toBe("signedIn");
        expect(reveal(yield* auth.accessToken(false))).toBe(sam);
        expect(memory.saved()).toStrictEqual(
          Option.some({ token: sam, refreshToken: "sam-refresh" }),
        );
      }),
    ));

  it("shares a refresh that got no answer with the callers waiting behind it", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        const callers = yield* Effect.forkChild(
          Effect.all([auth.accessToken(false), auth.accessToken(false), auth.accessToken(false)], {
            concurrency: "unbounded",
          }),
        );

        yield* Deferred.await(gate.arrived);
        yield* TestClock.adjust(30_001);
        yield* TestClock.withLive(Effect.sleep(50));

        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
        expect((yield* Fiber.join(callers)).map(reveal)).toStrictEqual([
          EXPIRING,
          EXPIRING,
          EXPIRING,
        ]);
      }),
    ));

  it("drops a refused session from memory even when clearing storage fails", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", Reply.Success({ value: { tokens: null } }));
        memory.failClears(true);

        yield* Effect.exit(auth.accessToken(false));

        expect(yield* auth.currentStatus).toBe("signedOut");
        expect(yield* auth.accessToken(false)).toStrictEqual(Option.none());
        expect(yield* refreshRequests(fake)).toStrictEqual(["refresh-1"]);
      }),
    ));

  it("ends on the server a session renewed after sign-out forgot it", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        const gate = yield* gateRefresh(fake, tokens(RENEWED, ROTATED));

        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        const refreshing = yield* Effect.forkChild(auth.accessToken(true));

        yield* Deferred.await(gate.arrived);
        yield* auth.signOut;
        yield* Deferred.succeed(gate.release, undefined);

        expect(yield* Fiber.join(refreshing)).toStrictEqual(Option.none());

        for (let tries = 0; tries < 20; tries += 1) {
          if ((yield* fake.requestsTo("auth:signOut")).length >= 2) break;
          yield* TestClock.withLive(Effect.sleep(20));
        }

        expect((yield* fake.requestsTo("auth:signOut")).map((r) => r.authorization)).toStrictEqual([
          `Bearer ${FRESH}`,
          `Bearer ${RENEWED}`,
        ]);
      }),
    ));

  it("retries a sign-out the server could not confirm, with a store only this client owns", () =>
    withAuth(signedInWith(FRESH), ({ fake, auth }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signOut", Reply.Failure({ code: "internal", message: "Down" }));
        yield* auth.signOut;
        yield* fake.reply("auth:signOut", Reply.Success({ value: null }));
        yield* TestClock.adjust(2_000);

        expect(yield* serverSignOuts(fake, 2)).toStrictEqual([
          `Bearer ${FRESH}`,
          `Bearer ${FRESH}`,
        ]);
        expect(yield* auth.currentStatus).toBe("signedOut");
      }),
    ));

  it("renews for a caller whose token was rejected even after another refresh kept it", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, auth }) =>
      Effect.gen(function* () {
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const count = yield* Ref.make(0);

        yield* fake.handle("auth:signIn", () =>
          Effect.gen(function* () {
            const index = yield* Ref.getAndUpdate(count, (n) => n + 1);

            if (index > 0) return tokens(RENEWED, ROTATED);
            yield* Deferred.succeed(arrived, undefined);
            yield* Deferred.await(release);

            return Reply.Drop();
          }),
        );

        const expiring = yield* Effect.forkChild(auth.accessToken(false));

        yield* Deferred.await(arrived);
        const rejected = yield* Effect.forkChild(auth.accessToken(true));

        yield* TestClock.withLive(Effect.sleep(20));
        yield* Deferred.succeed(release, undefined);

        expect(reveal(yield* Fiber.join(expiring))).toBe(EXPIRING);
        expect(reveal(yield* Fiber.join(rejected))).toBe(RENEWED);
      }),
    ));

  it("logs a token storage failure without its cause", () =>
    withAuth(signedInWith(EXPIRING), ({ fake, memory, logs }) =>
      Effect.gen(function* () {
        yield* fake.reply("auth:signIn", tokens(RENEWED, ROTATED));
        yield* fake.reply("deviceAuth:status", Reply.Success({ value: { state: "pending" } }));
        memory.failWrites(true);
        const transport = yield* ConvexTransport.ConvexTransport;

        yield* transport.call("query", "deviceAuth:status", { deviceCode: "device-secret" });

        const warnings = logs().filter((entry) => entry.includes("Auth.tokenStorageFailed"));

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain(RENEWED);
        expect(warnings[0]).not.toContain(ROTATED);
      }),
    ));
});
