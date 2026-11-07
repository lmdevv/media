import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Scope,
} from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Platform, TokenStorage } from "@media/sdk/effect";
import type { SharedStore } from "@media/sdk/promise";
import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { jwtExpiringAt, Reply } from "@media/sdk/testing/fake-convex";

import * as BrowserTabs from "./testing/browser-tabs";

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
const fakeCore = (tokenLifetime = 3_600_000) =>
  Effect.gen(function* () {
    const fake = yield* FakeConvex.make;

    const sessions = new Map<
      string,
      { live: boolean; refreshTokens: Set<string>; used: Set<string> }
    >();

    const down = yield* Ref.make(false);
    let issued = 0;

    const issue = (subject: string) => {
      issued += 1;
      const refreshToken = `refresh-${issued}`;

      sessions.get(subject)?.refreshTokens.add(refreshToken);

      return Reply.Success({
        value: {
          tokens: {
            token: jwtExpiringAt(Date.now() + tokenLifetime + issued * 1000, subject),
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
          const presented = String(args.refreshToken);

          const found = [...sessions].find(
            ([, held]) => held.live && held.refreshTokens.has(presented),
          );

          // As Convex Auth does past its reuse window, a spent token is refused and the session kept.
          if (found === undefined || found[1].used.has(presented)) {
            return Reply.Success({ value: { tokens: null } });
          }

          found[1].used.add(presented);

          return issue(found[0]);
        }

        const username =
          Predicate.hasProperty(args, "params") && Predicate.hasProperty(args.params, "username")
            ? String(args.params.username)
            : "someone";

        const subject = `${username}|session-${issued + 1}`;

        sessions.set(subject, { live: true, refreshTokens: new Set(), used: new Set() });

        return issue(subject);
      }),
    );

    yield* answerSignIns;
    yield* fake.handle("core/auth/sessions:revoke", (request) =>
      Effect.gen(function* () {
        if (yield* Ref.get(down)) return Reply.Failure({ code: "internal", message: "Down" });

        const presented = Predicate.hasProperty(request.args, "refreshToken")
          ? String(request.args.refreshToken)
          : "";

        for (const held of sessions.values()) {
          if (held.refreshTokens.has(presented)) held.live = false;
        }

        return Reply.Success({ value: { confirmed: true } });
      }),
    );
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

const openClient = (fake: FakeConvex.FakeConvex, store: SharedStore, key: string = KEY) =>
  Layer.build(
    Platform.layer({
      url: fake.url,
      connection: "http",
      storage: TokenStorage.layerShared(store, key),
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

/** The sign-outs the core was asked for: each a refresh token to revoke. */
const signedOutRequests = (fake: FakeConvex.FakeConvex) =>
  fake.requestsTo("core/auth/sessions:revoke");

const sameSubject = Option.makeEquivalence<string>((a, b) => a === b);

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(body));

const tabsOf = (count: number, delivery: "manual" | "at once") =>
  Effect.promise(() => BrowserTabs.makeBrowserTabs({ count, delivery }));

const keysOf = (tabs: BrowserTabs.BrowserTabs) =>
  Effect.promise(async () => [...(await tabs.items()).keys()]);

/** Gates the next refresh at the server until `release`, so another tab can act meanwhile. */
const gateRefresh = (fake: FakeConvex.FakeConvex, renewal: string) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();

    yield* fake.handle("auth:signIn", () =>
      Deferred.await(release).pipe(
        Effect.as(
          Reply.Success({ value: { tokens: { token: renewal, refreshToken: "refresh-late" } } }),
        ),
      ),
    );

    return release;
  });

describe("clients sharing one session store", () => {
  it("follows the other client's refresh without spending the old refresh token", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake } = yield* fakeCore();
        const tabs = yield* tabsOf(2, "at once");
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
        const { fake } = yield* fakeCore();
        const tabs = yield* tabsOf(2, "at once");
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

  it("drops a renewal that lands after another tab's failed sign-out, and ends it on the server", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down, live, answerSignIns } = yield* fakeCore();
        const tabs = yield* tabsOf(3, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        const ada = yield* bearerOf(second, fake);

        const release = yield* gateRefresh(
          fake,
          jwtExpiringAt(
            Date.now() + 9_000_000,
            Option.getOrElse(ada, () => ""),
          ),
        );

        const refreshing = yield* Effect.forkChild(refreshOnce(second));

        yield* settle;
        yield* Ref.set(down, true);
        yield* first.session.signOut;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refreshing);
        yield* answerSignIns;
        yield* Ref.set(down, false);
        tabs.deliver();
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(2));

        return {
          second: Option.isNone(yield* bearerOf(second, fake)),
          observer: yield* observer.session.currentStatus,
          ended: yield* eventually(
            Effect.sync(() => Option.exists(ada, (subject) => !live(subject))),
            10_000,
          ),
        };
      }),
    );

    expect(answer).toStrictEqual({ second: true, observer: "signedOut", ended: true });
  }, 15_000);

  it("keeps both sign-outs when two sessions on one key sign out at once", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down } = yield* fakeCore();
        const tabs = yield* tabsOf(4, "manual");
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

  it("never brings back a session whose sign-out could only delete it, whatever renewal lands later", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down, answerSignIns } = yield* fakeCore();
        const tabs = yield* tabsOf(3, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        const ada = yield* bearerOf(second, fake);

        const release = yield* gateRefresh(
          fake,
          jwtExpiringAt(
            Date.now() + 9_000_000,
            Option.getOrElse(ada, () => ""),
          ),
        );

        const refreshing = yield* Effect.forkChild(refreshOnce(second));

        yield* settle;
        yield* Ref.set(down, true);
        tabs.fill(true);
        yield* Effect.ignore(first.session.signOut);
        tabs.fill(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(refreshing);
        yield* answerSignIns;
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(2));

        return {
          observer: Option.isSome(yield* bearerOf(observer, fake)),
          second: Option.isSome(yield* bearerOf(second, fake)),
        };
      }),
    );

    expect(answer).toStrictEqual({ observer: false, second: false });
  });

  it("keeps a sign-in another tab made on the same key while this tab signed out", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake } = yield* fakeCore();
        const tabs = yield* tabsOf(3, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        yield* second.session.signIn(password("bo"));
        yield* first.session.signOut;
        tabs.deliver();
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(2));

        return {
          second: Option.map(yield* bearerOf(second, fake), (subject) => subject.split("|")[0]),
          observer: Option.map(yield* bearerOf(observer, fake), (subject) => subject.split("|")[0]),
        };
      }),
    );

    expect(answer).toStrictEqual({ second: Option.some("bo"), observer: Option.some("bo") });
  });
});

describe("a sign-in answered late", () => {
  it("never stores a session another tab signed out while the answer was on its way", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake } = yield* fakeCore();
        const tabs = yield* tabsOf(3, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));
        const shared = jwtExpiringAt(Date.now() + 3_600_000, "user-ada|session-tile");
        const late = yield* Deferred.make<void>();
        const answered = yield* Ref.make(0);

        // Both tabs redeem the same approved tile opening, so the core answers both with one session.
        yield* fake.handle("auth:signIn", () =>
          Effect.gen(function* () {
            if ((yield* Ref.getAndUpdate(answered, (count) => count + 1)) > 0) {
              yield* Deferred.await(late);
            }

            return Reply.Success({
              value: { tokens: { token: shared, refreshToken: "refresh-tile" } },
            });
          }),
        );

        yield* first.session.signIn(password("ada"));

        const signingIn = yield* Effect.forkChild(
          Effect.exit(second.session.signIn(password("ada"))),
        );

        yield* settle;
        yield* first.session.signOut;
        yield* Deferred.succeed(late, undefined);
        const signedIn = yield* Fiber.join(signingIn);

        tabs.deliver();
        yield* settle;

        const observer = yield* openClient(fake, tabs.tab(2));

        return {
          refused: Exit.isFailure(signedIn),
          storedAgain: (yield* keysOf(tabs)).includes(`${KEY}:user-ada|session-tile`),
          second: yield* second.session.currentStatus,
          secondCalls: Option.isNone(yield* bearerOf(second, fake)),
          observer: yield* observer.session.currentStatus,
        };
      }),
    );

    expect(answer).toStrictEqual({
      refused: true,
      storedAgain: false,
      second: "signedOut",
      secondCalls: true,
      observer: "signedOut",
    });
  });
});

describe("a sign-out the server could not confirm", () => {
  it.each(["the same tab", "another tab"] as const)(
    "is finished from %s after the slot is forgotten and its client disposed",
    async (where) => {
      const answer = await run(
        Effect.gen(function* () {
          const { fake, down, live } = yield* fakeCore();
          const tabs = yield* tabsOf(2, "at once");
          const signingOut = yield* Scope.make();
          const first = yield* openClient(fake, tabs.tab(0)).pipe(Scope.provide(signingOut));

          yield* first.session.signIn(password("ada"));
          const ada = yield* bearerOf(first, fake);

          yield* Ref.set(down, true);
          yield* first.session.signOut;
          yield* Scope.close(signingOut, Exit.void);

          yield* Effect.promise(() =>
            tabs.tab(0).write(async (tx) => {
              const slotKeys = (await tx.keys()).filter(
                (key) => key === KEY || key.startsWith(`${KEY}:`),
              );

              await Promise.all(slotKeys.map((key) => tx.remove(key)));
            }),
          );

          yield* Ref.set(down, false);

          const next = yield* openClient(
            fake,
            tabs.tab(where === "the same tab" ? 0 : 1),
            "media.session.another-slot",
          );

          return {
            ended: yield* eventually(
              Effect.sync(() => Option.exists(ada, (subject) => !live(subject))),
              5_000,
            ),
            next: yield* next.session.currentStatus,
            pendingLeft: yield* eventually(
              Effect.map(
                keysOf(tabs),
                (keys) => !keys.some((key) => key.startsWith("media.signOut:")),
              ),
            ),
            usedAfterSignOut: (yield* fake.requestsTo("core/server:info")).filter((call) =>
              sameSubject(subjectOf(call.authorization), ada),
            ).length,
          };
        }),
      );

      expect(answer).toStrictEqual({
        ended: true,
        next: "signedOut",
        pendingLeft: true,
        usedAfterSignOut: 1,
      });
    },
    15_000,
  );
});

describe("a sign-out that cannot be stored or confirmed at first", () => {
  it("leaves nothing that loads when storage is full, and ends the session once both recover", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down, live } = yield* fakeCore();
        const tabs = yield* tabsOf(3, "at once");
        const first = yield* openClient(fake, tabs.tab(0));

        yield* first.session.signIn(password("ada"));
        const ada = yield* bearerOf(first, fake);

        yield* Ref.set(down, true);
        tabs.fill(true);
        yield* Effect.ignore(first.session.signOut);
        tabs.fill(false);

        const other = yield* openClient(fake, tabs.tab(1));
        const otherStatus = yield* other.session.currentStatus;

        yield* Ref.set(down, false);

        return {
          first: yield* first.session.currentStatus,
          other: otherStatus,
          ended: yield* eventually(
            Effect.sync(() => Option.exists(ada, (subject) => !live(subject))),
            10_000,
          ),
          pendingLeft: yield* eventually(
            Effect.map(
              keysOf(tabs),
              (keys) => !keys.some((key) => key.startsWith("media.signOut:")),
            ),
          ),
        };
      }),
    );

    expect(answer).toStrictEqual({
      first: "signedOut",
      other: "signedOut",
      ended: true,
      pendingLeft: true,
    });
  }, 15_000);

  it("returns no token from memory once another tab's failed sign-out deleted the stored credentials", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down } = yield* fakeCore();
        const tabs = yield* tabsOf(2, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        const before = yield* bearerOf(second, fake);

        yield* Ref.set(down, true);
        tabs.fill(true);
        yield* Effect.ignore(first.session.signOut);

        return {
          before: Option.isSome(before),
          after: Option.isSome(yield* bearerOf(second, fake)),
        };
      }),
    );

    expect(answer).toStrictEqual({ before: true, after: false });
  });

  it("ends the session with the refresh token it signed out with, though other tabs rotated it since", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const { fake, down, live } = yield* fakeCore(45_000);
        const tabs = yield* tabsOf(2, "manual");
        const first = yield* openClient(fake, tabs.tab(0));
        const second = yield* openClient(fake, tabs.tab(1));

        yield* first.session.signIn(password("ada"));
        tabs.deliver();
        yield* settle;
        const ada = yield* bearerOf(second, fake);

        yield* refreshOnce(second);
        yield* refreshOnce(second);
        yield* Ref.set(down, true);
        yield* Effect.ignore(first.session.signOut);
        yield* Ref.set(down, false);

        return {
          ended: yield* eventually(
            Effect.sync(() => Option.exists(ada, (subject) => !live(subject))),
            10_000,
          ),
        };
      }),
    );

    expect(answer).toStrictEqual({ ended: true });
  }, 15_000);
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
  it("never authorizes as a session once it was signed out, and never loses the last sign-in", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 4, maxLength: 14 }), async (steps) => {
        const outcome = await run(
          Effect.gen(function* () {
            const { fake, down, live } = yield* fakeCore();
            const tabs = yield* tabsOf(TABS + 1, "manual");

            const clients = yield* Effect.forEach(
              Array.from({ length: TABS }, (_, index) => index),
              (index) => openClient(fake, tabs.tab(index)),
            );

            const revoked = new Set<string>();
            const violations: Array<string> = [];
            let lastSignIn: Option.Option<string> = Option.none();

            const check = (tab: number, subject: Option.Option<string>) => {
              for (const held of Option.toArray(subject)) {
                if (revoked.has(held)) violations.push(`tab ${tab} used ${held}`);
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
                    revoked.add(subject);

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

            const keys = yield* keysOf(tabs);
            const observer = yield* openClient(fake, tabs.tab(TABS));

            return {
              violations,
              observer: yield* bearerOf(observer, fake),
              // A refused stale refresh may revoke the last sign-in on purpose; only one the
              // store and the core both still hold must survive.
              lastSignIn: Option.filter(
                lastSignIn,
                (subject) => live(subject) && !keys.includes(`media.revoked:${subject}`),
              ),
            };
          }),
        );

        expect(outcome.violations).toStrictEqual([]);
        expect(outcome.observer).toStrictEqual(outcome.lastSignIn);
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
