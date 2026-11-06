import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
} from "effect";
import type { Scope } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as BrowserTabs from "../testing/browser-tabs";
import * as FakeConvex from "../testing/fake-convex";
import { jwtExpiringAt, Reply } from "../testing/fake-convex";
import * as TokenStorage from "../token-storage";
import * as Platform from "./platform";

const KEY = "media.session.slot";

const SERVER = { name: "[media]", version: "0.2.0", hasOwner: true };

const subjectOf = (authorization: string | undefined): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(authorization?.replace(/^Bearer /u, "")), (token) =>
    TokenStorage.sessionOf({ token: Redacted.make(token), refreshToken: Redacted.make("") }),
  );

/**
 * A core that keeps sessions: a password sign-in starts one, a refresh renews a live one and
 * refuses an ended one, and a sign-out ends one unless the server is down.
 */
const fakeCore = Effect.gen(function* () {
  const fake = yield* FakeConvex.make;
  const sessions = new Map<string, { live: boolean; refreshTokens: Set<string> }>();
  const down = yield* Ref.make(false);
  let issued = 0;

  const issue = (subject: string) => {
    issued += 1;
    const refreshToken = `refresh-${issued}`;

    sessions.get(subject)?.refreshTokens.add(refreshToken);

    return Reply.Success({
      value: {
        tokens: {
          token: jwtExpiringAt(Date.now() + 3_600_000 + issued * 1000, subject),
          refreshToken,
        },
      },
    });
  };

  yield* fake.reply("core/server:info", Reply.Success({ value: SERVER }));
  yield* fake.reply(
    "core/accounts/me:changePassword",
    Reply.Failure({ code: "unauthenticated", message: "Token expired" }),
  );

  const answerSignIns = fake.handle("auth:signIn", (request) =>
    Effect.sync(() => {
      const { args } = request;

      if (Predicate.hasProperty(args, "refreshToken")) {
        const found = [...sessions].find(
          ([, held]) => held.live && held.refreshTokens.has(String(args.refreshToken)),
        );

        return found === undefined ? Reply.Success({ value: { tokens: null } }) : issue(found[0]);
      }

      const username =
        Predicate.hasProperty(args, "params") && Predicate.hasProperty(args.params, "username")
          ? String(args.params.username)
          : "someone";

      const subject = `${username}|session-${issued + 1}`;

      sessions.set(subject, { live: true, refreshTokens: new Set() });

      return issue(subject);
    }),
  );

  yield* answerSignIns;
  yield* fake.handle("auth:signOut", (request) =>
    Effect.gen(function* () {
      if (yield* Ref.get(down)) return Reply.Failure({ code: "internal", message: "Down" });

      for (const subject of Option.toArray(subjectOf(request.authorization))) {
        const held = sessions.get(subject);

        if (held !== undefined) held.live = false;
      }

      return Reply.Success({ value: null });
    }),
  );

  const live = (subject: string) => sessions.get(subject)?.live === true;

  return { fake, down, live, answerSignIns };
});

const openClient = (fake: FakeConvex.FakeConvex, store: TokenStorage.KeyValueStore) =>
  Layer.build(
    Platform.layer({
      url: fake.url,
      connection: "http",
      storage: TokenStorage.layerKeyValue(store, KEY),
    }),
  ).pipe(Effect.map((context) => Context.get(context, Platform.Platform)));

const password = (username: string) =>
  Platform.Credentials.Password({ username, password: Redacted.make("secret") });

/** The session a call from `platform` authorizes as now, if any. */
const bearerOf = (platform: Platform.Interface, fake: FakeConvex.FakeConvex) =>
  Effect.gen(function* () {
    yield* platform.core.server.info();
    const calls = yield* fake.requestsTo("core/server:info");

    return subjectOf(calls.at(-1)?.authorization);
  });

/** A call the server refuses as unauthenticated, so the client refreshes once and retries. */
const refreshOnce = (platform: Platform.Interface) =>
  Effect.ignore(
    platform.core.accounts.me.changePassword({ currentPassword: "old", newPassword: "new-one" }),
  );

const settle = Effect.sleep(20);

const eventually = <E>(check: Effect.Effect<boolean, E>, within = 1_000) =>
  check.pipe(
    Effect.repeat({ until: (done) => done, schedule: Schedule.spaced(10) }),
    Effect.timeoutOption(within),
    Effect.map(Option.isSome),
  );

const signedOutRequests = (fake: FakeConvex.FakeConvex) =>
  Effect.map(fake.requestsTo("auth:signOut"), (requests) =>
    requests.flatMap((request) => Option.toArray(subjectOf(request.authorization))),
  );

const sameSubject = Option.makeEquivalence<string>((a, b) => a === b);

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(body));

describe("clients sharing one session store", () => {
  it("follows the other client's refresh without spending the old refresh token", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake } = yield* fakeCore;

        const tabs = BrowserTabs.makeBrowserTabs({
          count: 2,
          processes: "shared",
          delivery: "at once",
        });

        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        yield* settle;
        yield* refreshOnce(first);
        yield* settle;

        const refreshes = yield* Effect.map(fake.requestsTo("auth:signIn"), (requests) =>
          requests.filter((request) => Predicate.hasProperty(request.args, "refreshToken")),
        );

        return {
          same: sameSubject(yield* bearerOf(first, fake), yield* bearerOf(second, fake)),
          refreshes: refreshes.length,
        };
      }),
    );

    expect(answer).toStrictEqual({ same: true, refreshes: 1 });
  });

  it("signs out when the other client signs out, leaving the server to it", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake } = yield* fakeCore;

        const tabs = BrowserTabs.makeBrowserTabs({
          count: 2,
          processes: "shared",
          delivery: "at once",
        });

        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        yield* settle;
        yield* first.session.signOut;
        yield* Effect.sleep(1_500);

        return {
          second: yield* second.session.currentStatus,
          signOuts: (yield* signedOutRequests(fake)).length,
        };
      }),
    );

    expect(answer).toStrictEqual({ second: "signedOut", signOuts: 1 });
  });

  it.each(["shared", "separate"] as const)(
    "drops a renewal that lands after another tab's failed sign-out, and ends it on the server (%s processes)",
    async (processes) => {
      const answer = await run(
        Effect.gen(function* () {
          const { fake, down, live } = yield* fakeCore;
          const tabs = BrowserTabs.makeBrowserTabs({ count: 3, processes, delivery: "manual" });
          const first = yield* openClient(fake, tabs.tab(0));
          const second = yield* openClient(fake, tabs.tab(1));

          yield* first.session.signIn(password("ada"));
          tabs.deliver();
          yield* settle;
          const ada = yield* bearerOf(second, fake);

          yield* Ref.set(down, true);
          yield* first.session.signOut;
          yield* refreshOnce(second);
          const renewed = yield* bearerOf(second, fake);

          yield* Ref.set(down, false);
          tabs.deliver();
          yield* settle;

          const observer = yield* openClient(fake, tabs.tab(2));

          return {
            heldAda: Option.isSome(ada),
            second: yield* eventually(
              Effect.map(second.session.currentStatus, (status) => status === "signedOut"),
            ),
            secondCalls: Option.isNone(yield* bearerOf(second, fake)),
            observer: yield* observer.session.currentStatus,
            renewedSameSession: sameSubject(renewed, ada) || Option.isNone(renewed),
            endedOnServer: yield* eventually(
              Effect.sync(() => Option.exists(ada, (subject) => !live(subject))),
              5_000,
            ),
          };
        }),
      );

      expect(answer).toStrictEqual({
        heldAda: true,
        second: true,
        secondCalls: true,
        observer: "signedOut",
        renewedSameSession: true,
        endedOnServer: true,
      });
    },
  );

  it("keeps both sign-outs when two sessions on one key sign out at once", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down } = yield* fakeCore;

        const tabs = BrowserTabs.makeBrowserTabs({
          count: 4,
          processes: "separate",
          delivery: "manual",
        });

        const ada = yield* openClient(fake, tabs.tab(0));
        const bo = yield* openClient(fake, tabs.tab(1));
        const late = yield* openClient(fake, tabs.tab(2));

        yield* ada.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        yield* bo.session.signIn(password("bo"));
        yield* Ref.set(down, true);
        yield* ada.session.signOut;
        yield* bo.session.signOut;
        yield* refreshOnce(late);
        tabs.deliver();
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(3));

        return {
          observer: yield* observer.session.currentStatus,
          late: Option.isNone(yield* bearerOf(late, fake)),
        };
      }),
    );

    expect(answer).toStrictEqual({ observer: "signedOut", late: true });
  });

  /**
   * Tab 1's refresh reads the stored session, tab 0 signs out, then tab 1's read settles and it
   * writes the renewal: the window an asynchronous store leaves between a check and a write.
   */
  const renewalAcrossSignOut = Effect.gen(function* () {
    const { fake, down, answerSignIns } = yield* fakeCore;
    const tabs = BrowserTabs.makeBrowserTabs({ count: 3, processes: "shared", delivery: "manual" });
    const first = yield* openClient(fake, tabs.tab(0));
    const second = yield* openClient(fake, tabs.tab(1));
    const answered = yield* Deferred.make<void>();

    yield* first.session.signIn(password("ada"));
    tabs.deliver();
    yield* settle;
    const ada = yield* bearerOf(second, fake);

    const renewal = jwtExpiringAt(
      Date.now() + 9_000_000,
      Option.getOrElse(ada, () => ""),
    );

    yield* fake.handle("auth:signIn", () =>
      Deferred.await(answered).pipe(
        Effect.as(
          Reply.Success({ value: { tokens: { token: renewal, refreshToken: "refresh-late" } } }),
        ),
      ),
    );

    const refreshing = yield* Effect.forkChild(refreshOnce(second));

    yield* settle;
    const release = tabs.hold(1, (key) => key !== KEY);

    yield* Deferred.succeed(answered, undefined);
    yield* settle;
    yield* Ref.set(down, true);
    yield* first.session.signOut;
    release();
    yield* Fiber.join(refreshing);
    yield* answerSignIns;
    yield* settle;

    return { fake, tabs, first, second, ada, renewal };
  });

  it("returns no token renewed for a session another tab signed out meanwhile", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, second, ada, renewal } = yield* renewalAcrossSignOut;
        const calls = yield* fake.requestsTo("core/accounts/me:changePassword");

        return {
          usedRenewal: calls.some((call) => call.authorization === `Bearer ${renewal}`),
          callsAsAda: sameSubject(yield* bearerOf(second, fake), ada),
        };
      }),
    );

    expect(answer).toStrictEqual({ usedRenewal: false, callsAsAda: false });
  });

  it("never deletes a later sign-in because of what an earlier read found", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, tabs, first } = yield* renewalAcrossSignOut;
        const release = tabs.hold(2, () => true);
        const opening = yield* Effect.forkChild(openClient(fake, tabs.tab(2)));

        yield* settle;
        yield* first.session.signIn(password("bo"));
        release();
        yield* Fiber.join(opening);
        tabs.deliver();
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(2));

        return {
          first: Option.map(yield* bearerOf(first, fake), (subject) => subject.split("|")[0]),
          observer: Option.map(yield* bearerOf(observer, fake), (subject) => subject.split("|")[0]),
        };
      }),
    );

    expect(answer).toStrictEqual({ first: Option.some("bo"), observer: Option.some("bo") });
  });
});

type Step =
  | { readonly kind: "signIn"; readonly tab: number; readonly person: "ada" | "bo" }
  | { readonly kind: "refresh"; readonly tab: number }
  | { readonly kind: "signOut"; readonly tab: number; readonly serverDown: boolean }
  | { readonly kind: "deliver"; readonly tab: number }
  | { readonly kind: "call"; readonly tab: number };

const TABS = 3;

const tabIndex = fc.integer({ min: 0, max: TABS - 1 });

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("signIn" as const),
    tab: tabIndex,
    person: fc.constantFrom("ada" as const, "bo" as const),
  }),
  fc.record({ kind: fc.constant("refresh" as const), tab: tabIndex }),
  fc.record({ kind: fc.constant("signOut" as const), tab: tabIndex, serverDown: fc.boolean() }),
  fc.record({ kind: fc.constant("deliver" as const), tab: tabIndex }),
  fc.record({ kind: fc.constant("call" as const), tab: tabIndex }),
);

describe("any interleaving of tabs sharing one session store", () => {
  it("never authorizes as a session a tab has read was signed out, and never loses the last sign-in", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("shared" as const, "separate" as const),
        fc.array(step, { minLength: 4, maxLength: 14 }),
        async (processes, steps) => {
          const outcome = await run(
            Effect.gen(function* () {
              const { fake, down } = yield* fakeCore;

              const tabs = BrowserTabs.makeBrowserTabs({
                count: TABS + 1,
                processes,
                delivery: "manual",
              });

              const clients = yield* Effect.forEach(
                Array.from({ length: TABS }, (_, index) => index),
                (index) => openClient(fake, tabs.tab(index)),
              );

              const revoked: Array<{ subject: string; by: number; at: number }> = [];
              const violations: Array<string> = [];
              let lastSignIn: Option.Option<string> = Option.none();

              const check = (tab: number, subject: Option.Option<string>) => {
                for (const held of Option.toArray(subject)) {
                  const read = revoked.find(
                    (each) =>
                      each.subject === held && (each.by === tab || tabs.seen(tab) >= each.at),
                  );

                  if (read !== undefined) violations.push(`tab ${tab} used ${held}`);
                }
              };

              for (const next of steps) {
                const client = clients[next.tab];

                if (client === undefined) continue;

                switch (next.kind) {
                  case "signIn": {
                    yield* Effect.ignore(client.session.signIn(password(next.person)));
                    lastSignIn = yield* bearerOf(client, fake);
                    break;
                  }

                  case "refresh":
                    yield* refreshOnce(client);
                    break;
                  case "signOut": {
                    const held = yield* bearerOf(client, fake);

                    check(next.tab, held);
                    yield* Ref.set(down, next.serverDown);
                    yield* Effect.ignore(client.session.signOut);

                    for (const subject of Option.toArray(held)) {
                      revoked.push({ subject, by: next.tab, at: tabs.writes() });

                      if (Option.contains(lastSignIn, subject)) lastSignIn = Option.none();
                    }

                    break;
                  }

                  case "deliver":
                    tabs.deliver(next.tab);
                    break;
                  case "call":
                    check(next.tab, yield* bearerOf(client, fake));
                    break;
                }

                yield* settle;
              }

              tabs.deliver();
              yield* settle;

              for (const [index, client] of clients.entries()) {
                check(index, yield* bearerOf(client, fake));
              }

              const observer = yield* openClient(fake, tabs.tab(TABS));

              return {
                violations,
                observer: yield* bearerOf(observer, fake),
                lastSignIn,
              };
            }),
          );

          expect(outcome.violations).toStrictEqual([]);
          expect(outcome.observer).toStrictEqual(outcome.lastSignIn);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
