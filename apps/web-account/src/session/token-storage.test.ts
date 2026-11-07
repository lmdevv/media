import { TokenStorage as Storage } from "@media/sdk/effect";
import { openIndexedDb } from "@media/sdk/promise";
import type { SharedStore } from "@media/sdk/promise";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { Context, Effect, Exit, Layer, Option, Redacted } from "effect";
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { makeBrowserTabs } from "./testing/browser-tabs";
import { DAY, onClockSkewedBy } from "./testing/clock";
import type { BrowserTabs } from "./testing/browser-tabs";

const sessionAs = (subject: string, refreshToken = `refresh-${subject}`) => ({
  token: Redacted.make(jwtExpiringAt(Date.now() + 3_600_000, subject)),
  refreshToken: Redacted.make(refreshToken),
});

const ada = sessionAs("ada|session-1", "refresh-1");

const adaRenewed = sessionAs("ada|session-1", "refresh-2");

const bo = sessionAs("bo|session-2", "refresh-3");

/** Where the core bound a session: on `deviceId`, `sequence`th, from the device `basedOn`. */
const boundOn = (
  deviceId: string,
  sequence: number,
  basedOn: string | null = deviceId,
): Storage.DeviceOrder => ({ deviceId, code: `dv_${deviceId}.secret`, sequence, basedOn });

const refreshTokenOf = (loaded: Option.Option<{ readonly refreshToken: Redacted.Redacted }>) =>
  Option.map(loaded, (held) => Redacted.value(held.refreshToken));

const storageOf = (store: SharedStore) =>
  Effect.scoped(Layer.build(Storage.layerShared(store))).pipe(
    Effect.map((context) => Context.get(context, Storage.TokenStorage)),
  );

const keep = (store: SharedStore, session: Storage.StoredSession, order: Storage.DeviceOrder) =>
  Effect.promise(() => Storage.keepSession(store, session, order));

/** The session a tab's storage loads, as its token's subject. */
const loadedIn = (storage: Storage.Interface) =>
  Effect.map(storage.load, (loaded) => Option.flatMap(loaded, Storage.sessionOf));

const tabsOf = (count: number) =>
  Effect.promise(() => makeBrowserTabs({ count, delivery: "at once" }));

const keysOf = (tabs: BrowserTabs) => Effect.promise(async () => [...(await tabs.items()).keys()]);

describe("the browser's one session, shared between tabs in IndexedDB", () => {
  it.each([
    ["the older sign-in keeps first", ["ada", "bo"]],
    ["the newer sign-in keeps first", ["bo", "ada"]],
  ] as const)(
    "keeps the session the core bound last on the device, and signs the other out: %s",
    async (_, order) => {
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const tabs = yield* tabsOf(2);
          const signIns = { ada: { session: ada, sequence: 4 }, bo: { session: bo, sequence: 5 } };

          const kept = yield* Effect.forEach(order, (who, tab) =>
            keep(tabs.tab(tab), signIns[who].session, boundOn("laptop", signIns[who].sequence)),
          );

          const reader = yield* storageOf(tabs.tab(0));

          return {
            kept,
            loaded: yield* loadedIn(reader),
            ada: yield* reader.revocation(ada),
            pending: (yield* reader.pendingSignOuts).flatMap((each) =>
              Option.toArray(Storage.sessionOf(each)),
            ),
          };
        }),
      );

      expect(answer).toStrictEqual({
        kept: order[0] === "ada" ? [true, true] : [true, false],
        loaded: Option.some("bo|session-2"),
        ada: "pending",
        pending: ["ada|session-1"],
      });
    },
  );

  it("refuses a session signed out here, however late its answer lands, and changes nothing for the one held", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(3);
        const tile = boundOn("tv", 7);
        const first = yield* storageOf(tabs.tab(0));

        // Two tabs redeemed one approved tile, which the core answers with one session.
        const again = yield* keep(tabs.tab(0), ada, tile);
        const twice = yield* keep(tabs.tab(1), ada, tile);

        yield* first.renew(ada, adaRenewed);
        const stale = yield* keep(tabs.tab(1), ada, tile);
        const renewed = refreshTokenOf(yield* first.load);

        yield* first.revoke(adaRenewed);
        const late = yield* keep(tabs.tab(2), ada, boundOn("tv", 9));

        return {
          kept: [again, twice, stale],
          renewed,
          late,
          loaded: yield* loadedIn(yield* storageOf(tabs.tab(2))),
        };
      }),
    );

    expect(answer).toStrictEqual({
      kept: [true, true, true],
      renewed: Option.some("refresh-2"),
      late: false,
      loaded: Option.none(),
    });
  });

  it("moves to a new device only from the device its sign-in began on", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(3);
        const cy = sessionAs("cy|session-3");
        const dee = sessionAs("dee|session-4");

        // Two tabs of a new browser enroll at once, each registering its own device.
        const fresh = yield* Effect.all([
          keep(tabs.tab(0), ada, boundOn("laptop", 1, null)),
          keep(tabs.tab(1), bo, boundOn("other", 1, null)),
        ]);

        // The core forgot the laptop, so a sign-in from it enrolled a new device.
        const moved = yield* keep(tabs.tab(2), cy, boundOn("new-laptop", 1, "laptop"));
        const stale = yield* keep(tabs.tab(0), dee, boundOn("newer-laptop", 1, "laptop"));

        return {
          fresh,
          moved,
          stale,
          device: yield* Effect.promise(() => Storage.readDevice(tabs.tab(0))),
          loaded: yield* loadedIn(yield* storageOf(tabs.tab(1))),
          signedOut: yield* Effect.forEach([ada, bo, dee], (each) =>
            Effect.flatMap(storageOf(tabs.tab(1)), (storage) => storage.revocation(each)),
          ),
        };
      }),
    );

    expect(answer).toStrictEqual({
      fresh: [true, false],
      moved: true,
      stale: false,
      device: { id: "new-laptop", code: "dv_new-laptop.secret", sequence: 1 },
      loaded: Option.some("cy|session-3"),
      signedOut: ["pending", "pending", "pending"],
    });
  });

  it("renews a session only while it still holds the tokens the renewal started from", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(1);
        const storage = yield* storageOf(tabs.tab(0));

        yield* keep(tabs.tab(0), ada, boundOn("laptop", 1));
        const stale = yield* storage.renew(adaRenewed, ada);
        const renewing = yield* storage.renew(ada, adaRenewed);

        return { stale, renewing, loaded: refreshTokenOf(yield* storage.load) };
      }),
    );

    expect(answer).toStrictEqual({
      stale: false,
      renewing: true,
      loaded: Option.some("refresh-2"),
    });
  });

  it("refuses a renewal of a revoked session, and loads none", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* storageOf(tabs.tab(0));
        const renewing = yield* storageOf(tabs.tab(1));

        yield* keep(tabs.tab(0), ada, boundOn("laptop", 1));
        yield* signingOut.revoke(ada);

        return {
          late: yield* renewing.renew(ada, adaRenewed),
          loaded: yield* renewing.load,
          revocation: yield* renewing.revocation(adaRenewed),
        };
      }),
    );

    expect(answer).toStrictEqual({ late: false, loaded: Option.none(), revocation: "pending" });
  });

  it("revokes all or nothing: a full store keeps no partial records, and the tokens go", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* storageOf(tabs.tab(0));
        const other = yield* storageOf(tabs.tab(1));

        yield* keep(tabs.tab(0), ada, boundOn("laptop", 1));
        tabs.fill(true);
        const revoked = yield* Effect.exit(signingOut.revoke(ada));

        tabs.fill(false);

        return {
          revoked: Exit.isFailure(revoked),
          keys: (yield* keysOf(tabs)).toSorted(),
          revocation: yield* other.revocation(ada),
          late: yield* other.renew(ada, adaRenewed),
        };
      }),
    );

    expect(answer).toStrictEqual({
      revoked: true,
      keys: ["media.device"],
      revocation: "missing",
      late: false,
    });
  });

  it("keeps a sign-out pending for any tab until the core confirms it, and never loads it", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(2);
        const signingOut = yield* storageOf(tabs.tab(0));
        const other = yield* storageOf(tabs.tab(1));

        yield* keep(tabs.tab(0), ada, boundOn("laptop", 1));
        yield* signingOut.revoke(ada);
        const pending = yield* other.pendingSignOuts;
        const whilePending = yield* other.signOutPending(ada);

        yield* keep(tabs.tab(1), bo, boundOn("laptop", 2));
        yield* other.confirmRevoked(ada);

        return {
          pending: pending.map((each) => Redacted.value(each.refreshToken)),
          whilePending,
          after: yield* other.pendingSignOuts,
          revocation: yield* signingOut.revocation(ada),
          loaded: yield* loadedIn(signingOut),
        };
      }),
    );

    expect(answer).toStrictEqual({
      pending: ["refresh-1"],
      whilePending: true,
      after: [],
      revocation: "confirmed",
      loaded: Option.some("bo|session-2"),
    });
  });

  it("refuses a bare save, which has no device order", async () => {
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const tabs = yield* tabsOf(1);
        const storage = yield* storageOf(tabs.tab(0));
        const exit = yield* Effect.exit(storage.save(ada));

        return { failed: Exit.isFailure(exit), loaded: yield* storage.load };
      }),
    );

    expect(saved).toStrictEqual({ failed: true, loaded: Option.none() });
  });
});

type Step =
  | { readonly kind: "signIn"; readonly tab: number }
  | { readonly kind: "keep"; readonly pick: number }
  | { readonly kind: "lateAnswer"; readonly pick: number; readonly tab: number }
  | { readonly kind: "renew"; readonly tab: number }
  | { readonly kind: "signOut"; readonly tab: number }
  | { readonly kind: "forgetDevice" };

const TABS = 3;

const tab = fc.integer({ min: 0, max: TABS - 1 });

// Sign-ins and keeps come most often, so answers overtake each other on the device.
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("signIn" as const), tab }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("keep" as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("lateAnswer" as const), pick: fc.nat(), tab }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("renew" as const), tab }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("signOut" as const), tab }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("forgetDevice" as const) }) },
);

interface Answer {
  readonly tab: number;
  readonly session: Storage.StoredSession;
  readonly id: string;
  readonly order: Storage.DeviceOrder;
}

describe("any interleaving of sign-ins, late answers, renewals, sign-outs, and device changes across tabs", () => {
  it("never loads a signed-out session, never goes back on a device, and signs out every session it does not hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 4, maxLength: 30 }),
        // Each tab's clock runs up to 60 days off; nothing in the store may depend on it.
        fc.array(fc.integer({ min: -60 * DAY, max: 60 * DAY }), {
          minLength: TABS,
          maxLength: TABS,
        }),
        async (steps, skews) => {
          const on = (index: number) => onClockSkewedBy(skews[index] ?? 0);

          const outcome = await Effect.runPromise(
            Effect.gen(function* () {
              const tabs = yield* tabsOf(TABS);

              const storages = yield* Effect.forEach(
                Array.from({ length: TABS }, (_, index) => index),
                (index) => storageOf(tabs.tab(index)),
              );

              const storageAt = (index: number) => {
                const storage = storages[index];

                if (storage === undefined) throw new Error(`No tab ${index}`);

                return storage;
              };

              // The core: the devices it knows, each counting the sessions bound to it, and the
              // sessions a later bind on their device ended.
              const counts = new Map<string, number>();
              const boundTo = new Map<string, Array<string>>();
              const superseded = new Set<string>();
              let devicesMade = 0;
              let made = 0;

              const waiting: Array<Answer> = [];
              const answered: Array<Answer> = [];
              const signedOut = new Set<string>();
              const violations: Array<string> = [];
              let last: Option.Option<Storage.BrowserDevice> = Option.none();

              const check = Effect.gen(function* () {
                for (const [index, storage] of storages.entries()) {
                  for (const id of Option.toArray(yield* on(index)(loadedIn(storage)))) {
                    if (signedOut.has(id)) violations.push(`tab ${index} loaded ${id}`);
                  }
                }

                const device = Option.fromNullishOr(
                  yield* Effect.promise(() => Storage.readDevice(tabs.tab(0))),
                );

                const wentBack =
                  Option.isSome(device) &&
                  Option.isSome(last) &&
                  device.value.id === last.value.id &&
                  device.value.sequence < last.value.sequence;

                if (wentBack) violations.push(`the device went back to ${device.value.sequence}`);
                last = device;
              });

              const keepAnswer = (answer: Answer) =>
                Effect.gen(function* () {
                  yield* keep(tabs.tab(answer.tab), answer.session, answer.order);
                  answered.push(answer);
                });

              for (const next of steps) {
                switch (next.kind) {
                  case "signIn": {
                    // The tab enrolls with the device it keeps; a device the core forgot, or
                    // none, gets a new one.
                    const kept = yield* Effect.promise(() =>
                      Storage.readDevice(tabs.tab(next.tab)),
                    );

                    const known = kept !== null && counts.has(kept.id);

                    if (!known) devicesMade += 1;
                    const deviceId = known ? kept.id : `device-${devicesMade}`;
                    const sequence = (counts.get(deviceId) ?? 0) + 1;

                    made += 1;
                    const id = `person-${made % 2}|s${made}`;

                    counts.set(deviceId, sequence);

                    for (const earlier of boundTo.get(deviceId) ?? []) superseded.add(earlier);
                    boundTo.set(deviceId, [id]);
                    waiting.push({
                      tab: next.tab,
                      session: sessionAs(id),
                      id,
                      order: boundOn(deviceId, sequence, kept?.id ?? null),
                    });

                    break;
                  }

                  case "keep": {
                    const [answer] = waiting.splice(next.pick % Math.max(waiting.length, 1), 1);

                    if (answer !== undefined) yield* keepAnswer(answer);

                    break;
                  }

                  case "lateAnswer": {
                    const answer = answered[next.pick % Math.max(answered.length, 1)];

                    if (answer !== undefined) yield* keepAnswer({ ...answer, tab: next.tab });

                    break;
                  }

                  case "renew": {
                    const storage = storageAt(next.tab);
                    const held = yield* on(next.tab)(storage.load);

                    for (const session of Option.toArray(held)) {
                      made += 1;

                      const renewed = {
                        token: session.token,
                        refreshToken: Redacted.make(`refresh-${made}`),
                      };

                      yield* on(next.tab)(storage.renew(session, renewed));
                    }

                    break;
                  }

                  case "signOut": {
                    const storage = storageAt(next.tab);
                    const held = yield* on(next.tab)(storage.load);

                    for (const session of Option.toArray(held)) {
                      yield* on(next.tab)(storage.revoke(session));

                      for (const id of Option.toArray(Storage.sessionOf(session))) {
                        signedOut.add(id);
                      }
                    }

                    break;
                  }

                  case "forgetDevice":
                    counts.clear();
                    boundTo.clear();
                    break;
                }

                yield* check;
              }

              for (const answer of waiting.splice(0)) yield* keepAnswer(answer);
              yield* check;

              const reader = storageAt(0);
              const held = yield* loadedIn(reader);
              const ids = new Set(answered.map((answer) => answer.id));

              const notSignedOut = yield* Effect.forEach([...ids], (id) =>
                Effect.map(reader.revocation(sessionAs(id)), (revocation) =>
                  revocation === "missing" ? [id] : [],
                ),
              );

              return {
                violations,
                heldSuperseded: Option.filter(held, (id) => superseded.has(id)),
                notSignedOut: notSignedOut.flat(),
              };
            }),
          );

          expect(outcome).toStrictEqual({
            violations: [],
            heldSuperseded: Option.none(),
            notSignedOut: [],
          });
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});

describe("opening IndexedDB", () => {
  it("gives up after five seconds when the open never finishes, as when another tab blocks it", async () => {
    vi.useFakeTimers();

    try {
      const opening = openIndexedDb({
        indexedDB: {
          open: () => ({
            get result(): never {
              throw new Error("A stalled open has no database");
            },
            error: undefined,
            addEventListener: () => undefined,
          }),
        },
        name: "media",
        channel: () => ({ post: () => undefined, close: () => undefined }),
      });

      const settled = expect(opening).rejects.toThrow("did not open in time");

      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
