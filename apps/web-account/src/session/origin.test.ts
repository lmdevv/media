import { TokenStorage } from "@media/sdk/effect";
import { openIndexedDb } from "@media/sdk/promise";
import type { SharedStore } from "@media/sdk/promise";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { Brand, Context, Effect, Layer, Option, Redacted } from "effect";
import { IDBFactory } from "fake-indexeddb";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { newSlot, openOriginStore } from "./origin";
import type { OriginStore } from "./origin";
import type { UserId } from "./platform-types";

const userId = Brand.nominal<UserId>();

const ada = userId("user-ada");

const bo = userId("user-bo");

/**
 * Tabs of one origin over one fake IndexedDB. A tab hears another tab's commit only when
 * `deliver` runs, as a `BroadcastChannel` message arrives later.
 */
const tabs = async (count: number) => {
  const indexedDB = new IDBFactory();
  const listeners: Array<() => void> = [];
  const queued: Array<Array<() => void>> = Array.from({ length: count }, () => []);

  const shared = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      openIndexedDb({
        indexedDB,
        name: "media",
        channel: (_name, onMessage) => {
          listeners[index] = onMessage;

          return {
            post: () => {
              for (const [other, waiting] of queued.entries()) {
                if (other !== index) waiting.push(() => listeners[other]?.());
              }
            },
            close: () => undefined,
          };
        },
      }),
    ),
  );

  const stores = await Promise.all(shared.map((store) => openOriginStore(store)));

  return {
    stores,
    shared,
    deliver: async () => {
      for (const waiting of queued) for (const notify of waiting.splice(0)) notify();

      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
};

const one = async (): Promise<{ store: OriginStore; shared: SharedStore }> => {
  const { stores, shared } = await tabs(1);
  const [store] = stores;
  const [first] = shared;

  if (store === undefined || first === undefined) throw new Error("No tab");

  return { store, shared: first };
};

const keysOf = (shared: SharedStore) => shared.read((tx) => tx.keys());

/** A session as the core signs it in: its token's subject names the person and the session. */
const sessionAs = (subject: string) => ({
  token: Redacted.make(jwtExpiringAt(Date.now() + 3_600_000, subject)),
  refreshToken: Redacted.make(`refresh-${subject}`),
});

/** The SDK's session store for `slot`, as a tab's client holds it. */
const sessionsOf = (shared: SharedStore, store: OriginStore, slot: ReturnType<typeof newSlot>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(TokenStorage.layerShared(shared, store.sessionKey(slot)))).pipe(
      Effect.map((context) => Context.get(context, TokenStorage.TokenStorage)),
    ),
  );

/** Signs `subject` in on `slot` through the SDK, as a tab's client does before promoting it. */
const signIn = async (
  shared: SharedStore,
  store: OriginStore,
  slot: ReturnType<typeof newSlot>,
  subject: string,
) => {
  const sessions = await sessionsOf(shared, store, slot);

  await Effect.runPromise(sessions.save(sessionAs(subject)));
};

const refreshOf = (loaded: Option.Option<{ readonly refreshToken: Redacted.Redacted }>) =>
  Option.map(loaded, (held) => Redacted.value(held.refreshToken));

describe("the origin store", () => {
  it("makes a signed-in slot its person's and the active one", async () => {
    const { store, shared } = await one();
    const slot = newSlot();

    await signIn(shared, store, slot, "user-ada|s1");
    await store.promote(slot, ada);

    expect(store.read()).toStrictEqual({
      device: null,
      active: slot,
      people: new Map([[ada, slot]]),
    });
  });

  it("keeps the same snapshot until something changes", async () => {
    const { store } = await one();
    const before = store.read();

    expect(store.read()).toBe(before);

    await store.setDevice("dv_1.secret");

    expect(store.read()).not.toBe(before);
    expect(store.read().device).toBe("dv_1.secret");
  });

  it("drops a person's older session when they sign in on another slot", async () => {
    const { store, shared } = await one();
    const first = newSlot();
    const second = newSlot();

    await signIn(shared, store, first, "user-ada|s1");
    await store.promote(first, ada);
    await signIn(shared, store, second, "user-ada|s2");
    await store.promote(second, ada);

    expect(await keysOf(shared)).not.toContain(store.sessionKey(first));
    expect(store.read().people).toStrictEqual(new Map([[ada, second]]));
  });

  it("gives a shared device's one slot to the tile opened last", async () => {
    const { store, shared } = await one();
    const slot = newSlot();

    await signIn(shared, store, slot, "user-ada|s1");
    await store.promote(slot, ada);
    await signIn(shared, store, slot, "user-bo|s2");
    await store.promote(slot, bo);

    expect(store.read().people).toStrictEqual(new Map([[bo, slot]]));
  });

  it("drops a forgotten slot's tokens but keeps the sessions' revocations", async () => {
    const { store, shared } = await one();
    const slot = newSlot();
    const key = store.sessionKey(slot);

    await signIn(shared, store, slot, "user-ada|s1");
    await store.promote(slot, ada);
    await shared.write(async (tx) => {
      await tx.set(`${key}:user-ada|s0`, "older tokens");
      await tx.set("media.revoked:user-ada|s0", "revoked");
      await tx.set("media.signOut:user-ada|s0", "pending");
    });
    await store.forget(slot, "user-ada|s1");

    expect((await keysOf(shared)).toSorted()).toStrictEqual([
      "media.generation:user-ada",
      "media.revoked:user-ada|s0",
      "media.signOut:user-ada|s0",
    ]);
  });

  it("forgets one person and leaves the others signed in here", async () => {
    const { store, shared } = await one();
    const adaSlot = newSlot();
    const boSlot = newSlot();

    await signIn(shared, store, adaSlot, "user-ada|s1");
    await store.promote(adaSlot, ada);
    await signIn(shared, store, boSlot, "user-bo|s2");
    await store.promote(boSlot, bo);
    await store.forget(boSlot, "user-bo|s2");

    expect(store.read()).toStrictEqual({
      device: null,
      active: null,
      people: new Map([[ada, adaSlot]]),
    });
    expect(await keysOf(shared)).toContain(store.sessionKey(adaSlot));
  });

  it("forgets only what still points at the slot, though this tab has not heard of a newer one", async () => {
    const {
      stores: [signingOut, signingIn],
      shared: [store],
      deliver,
    } = await tabs(2);

    if (signingOut === undefined || signingIn === undefined || store === undefined) {
      throw new Error("No tab");
    }

    const old = newSlot();
    const fresh = newSlot();

    await signIn(store, signingOut, old, "user-ada|s1");
    await signingOut.promote(old, ada);
    await deliver();
    await signIn(store, signingIn, fresh, "user-ada|s2");
    await signingIn.promote(fresh, ada);

    expect(signingOut.read().active).toBe(old);

    await signingOut.forget(old, "user-ada|s1");
    await deliver();

    expect({ here: signingOut.read(), there: signingIn.read() }).toStrictEqual({
      here: { device: null, active: fresh, people: new Map([[ada, fresh]]) },
      there: { device: null, active: fresh, people: new Map([[ada, fresh]]) },
    });
    expect(await keysOf(store)).toContain(signingOut.sessionKey(fresh));
  });

  it("tells this tab of another tab's switch once its notification arrives", async () => {
    const {
      stores: [here, there],
      deliver,
    } = await tabs(2);

    if (here === undefined || there === undefined) throw new Error("No tab");

    const seen: Array<string | null> = [];
    const slot = newSlot();

    here.subscribe(() => seen.push(here.read().active));
    await there.activate(slot);
    await deliver();

    expect(seen).toStrictEqual([slot]);
  });

  it("holds nothing and refuses every change without IndexedDB", async () => {
    const store = await openOriginStore(null);

    expect(store.read()).toStrictEqual({ device: null, active: null, people: new Map() });
    await expect(store.promote(newSlot(), ada)).rejects.toThrow("can't keep a sign-in");
    await expect(store.sessions.read((tx) => tx.keys())).rejects.toThrow();
  });

  it("does not promote a sign-in that a newer one for the same person overtook", async () => {
    const {
      stores: [slow, fast],
      shared: [first, second],
      deliver,
    } = await tabs(2);

    if (slow === undefined || fast === undefined || first === undefined || second === undefined) {
      throw new Error("No tab");
    }

    const slowSlot = newSlot();
    const fastSlot = newSlot();
    const slowSessions = await sessionsOf(first, slow, slowSlot);
    const fastSessions = await sessionsOf(second, fast, fastSlot);

    await Effect.runPromise(slowSessions.save(sessionAs("user-ada|session-1")));
    await Effect.runPromise(fastSessions.save(sessionAs("user-ada|session-2")));
    await fast.promote(fastSlot, ada);
    await slow.promote(slowSlot, ada);
    await deliver();

    expect({
      origin: slow.read(),
      fastSession: refreshOf(await Effect.runPromise(fastSessions.load)),
    }).toStrictEqual({
      origin: { device: null, active: fastSlot, people: new Map([[ada, fastSlot]]) },
      fastSession: Option.some("refresh-user-ada|session-2"),
    });
  });

  it("does not forget a slot that took a newer session since the sign-out began", async () => {
    const {
      stores: [signingOut, opening],
      shared: [first, second],
    } = await tabs(2);

    if (
      signingOut === undefined ||
      opening === undefined ||
      first === undefined ||
      second === undefined
    ) {
      throw new Error("No tab");
    }

    const slot = newSlot();
    const here = await sessionsOf(first, signingOut, slot);
    const there = await sessionsOf(second, opening, slot);
    const adaSession = sessionAs("user-ada|session-1");

    await Effect.runPromise(here.save(adaSession));
    await signingOut.promote(slot, ada);
    await Effect.runPromise(here.revoke(adaSession));
    await Effect.runPromise(there.save(sessionAs("user-bo|session-2")));
    await opening.promote(slot, bo);
    await signingOut.forget(slot, "user-ada|session-1");

    expect({
      people: opening.read().people,
      loaded: refreshOf(await Effect.runPromise(there.load)),
    }).toStrictEqual({
      people: new Map([[bo, slot]]),
      loaded: Option.some("refresh-user-bo|session-2"),
    });
  });
});

type Step =
  | {
      readonly kind: "signIn";
      readonly tab: number;
      readonly person: "ada" | "bo";
      readonly reuse: boolean;
    }
  | { readonly kind: "promote"; readonly pick: number }
  | { readonly kind: "signOut"; readonly tab: number }
  | { readonly kind: "forget"; readonly pick: number }
  | { readonly kind: "lateAnswer"; readonly pick: number }
  | { readonly kind: "deliver" };

const TABS = 3;

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("signIn" as const),
    tab: fc.integer({ min: 0, max: TABS - 1 }),
    person: fc.constantFrom("ada" as const, "bo" as const),
    reuse: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("promote" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("signOut" as const), tab: fc.integer({ min: 0, max: TABS - 1 }) }),
  fc.record({ kind: fc.constant("forget" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("lateAnswer" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("deliver" as const) }),
);

const PEOPLE = { ada, bo } as const;

/** Runs `body` as one Effect, so its steps run in order without awaiting inside a loop. */
const sequence = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body);

const later = <A>(work: () => Promise<A>) => Effect.promise(work);

describe("any interleaving of sign-ins, promotions, sign-outs, and forgets across tabs", () => {
  it("never loads a signed-out session, and keeps each person's newest sign-in", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 4, maxLength: 20 }), async (steps) => {
        const { stores, shared, deliver } = await tabs(TABS);

        const at = (tab: number) => {
          const store = stores[tab];
          const db = shared[tab];

          if (store === undefined || db === undefined) throw new Error("No tab");

          return { store, db };
        };

        const storage = (tab: number, slot: ReturnType<typeof newSlot>) =>
          later(() => sessionsOf(at(tab).db, at(tab).store, slot));

        const violations = await sequence(
          Effect.gen(function* () {
            const sessions = new Map<string, ReturnType<typeof sessionAs>>();

            const signedIn: Array<{
              person: "ada" | "bo";
              slot: ReturnType<typeof newSlot>;
              session: string;
            }> = [];

            const promotions: Array<{
              tab: number;
              person: "ada" | "bo";
              slot: ReturnType<typeof newSlot>;
              session: string;
            }> = [];

            const forgets: Array<{
              tab: number;
              slot: ReturnType<typeof newSlot>;
              session: string | null;
            }> = [];

            const revoked = new Set<string>();
            const lastSaved = new Map<string, string>();
            const found: Array<string> = [];
            let made = 0;

            const runPromotion = (index: number) =>
              Effect.gen(function* () {
                const [promotion] = promotions.splice(index % promotions.length, 1);

                if (promotion === undefined) return;
                const { store } = at(promotion.tab);

                const promoted = yield* later(() =>
                  store.promote(promotion.slot, PEOPLE[promotion.person]),
                );

                if (!promoted) yield* later(() => store.forget(promotion.slot, promotion.session));
              });

            const runForget = (index: number) =>
              Effect.gen(function* () {
                const [forget] = forgets.splice(index % forgets.length, 1);

                if (forget === undefined) return;
                yield* later(() => at(forget.tab).store.forget(forget.slot, forget.session));
              });

            for (const next of steps) {
              switch (next.kind) {
                case "signIn": {
                  const { store } = at(next.tab);
                  const slot = next.reuse ? (store.read().active ?? newSlot()) : newSlot();

                  made += 1;
                  const session = `user-${next.person}|s${made}`;
                  const tokens = sessionAs(session);

                  sessions.set(session, tokens);

                  if (yield* (yield* storage(next.tab, slot)).save(tokens)) {
                    signedIn.push({ person: next.person, slot, session });
                    lastSaved.set(slot, session);
                    promotions.push({ tab: next.tab, person: next.person, slot, session });
                  }

                  break;
                }

                case "promote":
                  if (promotions.length > 0) yield* runPromotion(next.pick);
                  break;
                case "signOut": {
                  const { store } = at(next.tab);
                  const slot = store.read().active;

                  if (slot === null) break;
                  const session = yield* later(() => store.sessionIn(slot));
                  const tokens = session === null ? undefined : sessions.get(session);

                  if (session === null || tokens === undefined) break;
                  yield* (yield* storage(next.tab, slot)).revoke(tokens);
                  revoked.add(session);
                  forgets.push({ tab: next.tab, slot, session });
                  break;
                }

                case "forget":
                  if (forgets.length > 0) yield* runForget(next.pick);
                  break;
                case "lateAnswer": {
                  const late = [...revoked][next.pick % Math.max(revoked.size, 1)];
                  const where = signedIn.find((each) => each.session === late);
                  const tokens = late === undefined ? undefined : sessions.get(late);

                  if (where === undefined || tokens === undefined) break;

                  if (yield* (yield* storage(0, where.slot)).save(tokens)) {
                    found.push(`a late answer stored ${where.session} again`);
                  }

                  break;
                }

                case "deliver":
                  yield* later(deliver);
                  break;
              }
            }

            while (promotions.length > 0) yield* runPromotion(0);

            while (forgets.length > 0) yield* runForget(0);
            yield* later(deliver);

            const { store } = at(0);

            for (const { slot } of signedIn) {
              const loaded = yield* (yield* storage(0, slot)).load;
              const held = yield* later(() => store.sessionIn(slot));

              if (Option.isSome(loaded) && held !== null && revoked.has(held)) {
                found.push(`slot ${slot} loads signed-out ${held}`);
              }
            }

            for (const person of ["ada", "bo"] as const) {
              const newest = signedIn.findLast((each) => each.person === person);

              // Only a later sign-in on the same slot, or signing this one out, may take it away.
              if (newest === undefined || revoked.has(newest.session)) continue;

              if (lastSaved.get(newest.slot) !== newest.session) continue;
              const held = yield* later(() => store.sessionIn(newest.slot));

              if (
                held !== newest.session ||
                store.read().people.get(PEOPLE[person]) !== newest.slot
              ) {
                found.push(`${person}'s newest sign-in ${newest.session} lost its slot`);
              }
            }

            return found;
          }),
        );

        expect(violations).toStrictEqual([]);
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
