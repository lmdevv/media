import { TokenStorage } from "@media/sdk/effect";
import { openIndexedDb, slotHolding } from "@media/sdk/promise";
import type { SharedStore } from "@media/sdk/promise";
import { jwtExpiringAt } from "@media/sdk/testing/fake-convex";
import { Brand, Context, Effect, Layer, Option, Redacted } from "effect";
import { IDBFactory } from "fake-indexeddb";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { newSlot, openOriginStore } from "./origin";
import type { OriginStore } from "./origin";
import type { UserId } from "./platform-types";
import { settleSignIn } from "./sign-in";
import { DAY, onClockSkewedBy } from "./testing/clock";

const userId = Brand.nominal<UserId>();

const ada = userId("user-ada");

const bo = userId("user-bo");

/** The `sequence`th join of a session to this browser's device, as the core answers enroll. */
/** The device the test tabs keep, at epoch 1, unless a test starts with none. */
const DEVICE_CODE = "dv_device-1.secret";

/** The `sequence`th join to the kept device, as the core answers enroll. */
const joinedAs = (sequence: number, deviceId = "device-1", epoch = 1) => ({
  deviceId,
  epoch,
  sequence,
});

/**
 * Tabs of one origin over one fake IndexedDB. A tab hears another tab's commit only when
 * `deliver` runs, as a `BroadcastChannel` message arrives later.
 */
const cy = userId("user-cy");

/** A tile the core opened as the `sequence`th taking of the kept device, staged in `from`. */
const tileAs = (
  person: UserId,
  session: string,
  sequence: number,
  from: ReturnType<typeof newSlot>,
) => ({ userId: person, session, deviceId: "device-1", epoch: 1, sequence, from });

const tabs = async (count: number, { device = true }: { readonly device?: boolean } = {}) => {
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

  if (device) await stores[0]?.claimDevice(DEVICE_CODE, "device-1");

  return {
    stores,
    shared,
    deliver: async () => {
      for (const waiting of queued) for (const notify of waiting.splice(0)) notify();

      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
};

const one = async (
  options: { readonly device?: boolean } = {},
): Promise<{ store: OriginStore; shared: SharedStore }> => {
  const { stores, shared } = await tabs(1, options);
  const [store] = stores;
  const [first] = shared;

  if (store === undefined || first === undefined) throw new Error("No tab");

  return { store, shared: first };
};

const keysOf = (shared: SharedStore) => shared.read((tx) => tx.keys());

/** The session `slot` holds now, as a client of that slot holds it; null for none. */
const sessionIn = async (store: OriginStore, slot: ReturnType<typeof newSlot>) =>
  Option.match(await store.sessions.read((tx) => slotHolding(tx, store.sessionKey(slot))), {
    onNone: () => null,
    onSome: (held) => held.session,
  });

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

/** Two tabs that each saved a sign-in of Ada, each on its own slot, before either promoted. */
const twoSignIns = async () => {
  const {
    stores: [first, second],
    shared: [firstDb, secondDb],
    deliver,
  } = await tabs(2);

  if (
    first === undefined ||
    second === undefined ||
    firstDb === undefined ||
    secondDb === undefined
  ) {
    throw new Error("No tab");
  }

  const firstSlot = newSlot();
  const secondSlot = newSlot();
  const firstSessions = await sessionsOf(firstDb, first, firstSlot);
  const secondSessions = await sessionsOf(secondDb, second, secondSlot);

  await Effect.runPromise(firstSessions.save(sessionAs("user-ada|session-1")));
  await Effect.runPromise(secondSessions.save(sessionAs("user-ada|session-2")));

  return { first, second, firstSlot, secondSlot, firstSessions, secondSessions, deliver };
};

describe("the origin store", () => {
  it("makes a signed-in slot its person's and the active one", async () => {
    const { store, shared } = await one();
    const slot = newSlot();

    await signIn(shared, store, slot, "user-ada|s1");
    await store.promote(slot, { userId: ada, session: "user-ada|s1", joined: joinedAs(1) });

    expect(store.read()).toStrictEqual({
      device: DEVICE_CODE,
      active: slot,
      people: new Map([[ada, slot]]),
    });
  });

  it("keeps the same snapshot until something changes", async () => {
    const { store } = await one({ device: false });
    const before = store.read();

    expect(store.read()).toBe(before);

    await store.claimDevice("dv_1.secret", "1");

    expect(store.read()).not.toBe(before);
    expect(store.read().device).toBe("dv_1.secret");
  });

  it("drops a person's older session when they sign in on another slot", async () => {
    const { store, shared } = await one();
    const first = newSlot();
    const second = newSlot();

    await signIn(shared, store, first, "user-ada|s1");
    await store.promote(first, { userId: ada, session: "user-ada|s1", joined: joinedAs(1) });
    await signIn(shared, store, second, "user-ada|s2");
    await store.promote(second, { userId: ada, session: "user-ada|s2", joined: joinedAs(2) });

    expect(await keysOf(shared)).not.toContain(store.sessionKey(first));
    expect(store.read().people).toStrictEqual(new Map([[ada, second]]));
  });

  it("puts each tile in the device's one tile slot, ending the tile it replaced", async () => {
    const { store, shared } = await one();
    const adaStaging = newSlot();
    const boStaging = newSlot();

    await signIn(shared, store, adaStaging, "user-ada|tile-2");
    const first = await store.installTile(tileAs(ada, "user-ada|tile-2", 2, adaStaging));
    const tileSlot = store.read().active;

    await signIn(shared, store, boStaging, "user-bo|tile-3");
    const second = await store.installTile(tileAs(bo, "user-bo|tile-3", 3, boStaging));

    if (tileSlot === null) throw new Error("No tile slot");

    expect({
      first,
      second,
      origin: store.read(),
      loaded: refreshOf(await Effect.runPromise((await sessionsOf(shared, store, tileSlot)).load)),
      keys: (await keysOf(shared)).filter((key) => key.includes("|tile-")).toSorted(),
      again: await Effect.runPromise(
        (await sessionsOf(shared, store, newSlot())).save(sessionAs("user-ada|tile-2")),
      ),
    }).toStrictEqual({
      first: true,
      second: true,
      origin: { device: DEVICE_CODE, active: tileSlot, people: new Map([[bo, tileSlot]]) },
      loaded: Option.some("refresh-user-bo|tile-3"),
      keys: [
        "media.revoked:user-ada|tile-2",
        `${store.sessionKey(tileSlot)}:user-bo|tile-3`,
      ].toSorted(),
      again: false,
    });
  });

  it("keeps the tile the core opened last, whoever's, whatever order three tabs install in", async () => {
    const {
      stores: [holding, opening, late],
      shared: [holdingDb, openingDb, lateDb],
      deliver,
    } = await tabs(3);

    if (
      holding === undefined ||
      opening === undefined ||
      late === undefined ||
      holdingDb === undefined ||
      openingDb === undefined ||
      lateDb === undefined
    ) {
      throw new Error("No tab");
    }

    const x = newSlot();
    const y = newSlot();
    const z = newSlot();

    // Every tab holds Ada's tile X; Bo's Y and Cy's Z open, Z after Y on the core.
    await signIn(holdingDb, holding, x, "user-ada|tile-2");
    await holding.installTile(tileAs(ada, "user-ada|tile-2", 2, x));
    await deliver();
    await signIn(openingDb, opening, y, "user-bo|tile-3");
    await signIn(lateDb, late, z, "user-cy|tile-4");

    const installed = {
      y: await opening.installTile(tileAs(bo, "user-bo|tile-3", 3, y)),
      z: await late.installTile(tileAs(cy, "user-cy|tile-4", 4, z)),
    };

    await deliver();
    const tileSlot = holding.read().active;

    if (tileSlot === null) throw new Error("No tile slot");

    const tokens = (await keysOf(holdingDb)).filter((key) => /^media\.session\.[^:]+:/u.test(key));

    expect({ installed, people: holding.read().people, tokens }).toStrictEqual({
      installed: { y: true, z: true },
      people: new Map([[cy, tileSlot]]),
      tokens: [`${holding.sessionKey(tileSlot)}:user-cy|tile-4`],
    });
  });

  it("drops a tile the core opened before the one installed, though it installs after", async () => {
    const { store, shared } = await one();
    const older = newSlot();
    const newer = newSlot();

    await signIn(shared, store, older, "user-bo|tile-3");
    await signIn(shared, store, newer, "user-cy|tile-4");
    await store.installTile(tileAs(cy, "user-cy|tile-4", 4, newer));

    const late = await store.installTile(tileAs(bo, "user-bo|tile-3", 3, older));
    const tokens = (await keysOf(shared)).filter((key) => /^media\.session\.[^:]+:/u.test(key));

    expect({
      late,
      people: store.read().people,
      tokens: tokens.length,
      revoked: (await keysOf(shared)).includes("media.revoked:user-bo|tile-3"),
    }).toStrictEqual({
      late: false,
      people: new Map([[cy, store.read().active]]),
      tokens: 1,
      revoked: true,
    });
  });

  it("drops a join from a device this browser left, though its tab promotes after the new device's", async () => {
    const {
      stores: [suspended, current],
      shared: [suspendedDb, currentDb],
      deliver,
    } = await tabs(2, { device: false });

    if (
      suspended === undefined ||
      current === undefined ||
      suspendedDb === undefined ||
      currentDb === undefined
    ) {
      throw new Error("No tab");
    }

    const oldSlot = newSlot();
    const newSlotHere = newSlot();

    // The suspended tab enrolled device 1 and joined there; then device 1 is removed.
    await suspended.claimDevice("dv_d1.secret", "d1");
    await signIn(suspendedDb, suspended, oldSlot, "user-ada|session-d1");
    await current.clearDevice();

    // Another tab enrolls device 2, and Ada's new session there promotes.
    const kept = await current.claimDevice("dv_d2.secret", "d2");

    await signIn(currentDb, current, newSlotHere, "user-ada|session-d2");
    await settleSignIn(current, newSlotHere, {
      userId: ada,
      session: "user-ada|session-d2",
      joined: { deviceId: "d2", epoch: kept.epoch, sequence: 1 },
    });

    // The suspended tab resumes with its device 1 result.
    const settled = await settleSignIn(suspended, oldSlot, {
      userId: ada,
      session: "user-ada|session-d1",
      joined: { deviceId: "d1", epoch: 1, sequence: 5 },
    });

    await deliver();

    expect({
      settled,
      origin: current.read(),
      kept: (await keysOf(currentDb)).includes(current.sessionKey(newSlotHere)),
    }).toStrictEqual({
      settled: false,
      origin: {
        device: "dv_d2.secret",
        active: newSlotHere,
        people: new Map([[ada, newSlotHere]]),
      },
      kept: true,
    });
  });

  it("drops a forgotten slot's tokens but keeps the sessions' revocations", async () => {
    const { store, shared } = await one();
    const slot = newSlot();
    const key = store.sessionKey(slot);

    await signIn(shared, store, slot, "user-ada|s1");
    await store.promote(slot, { userId: ada, session: "user-ada|s1", joined: joinedAs(1) });
    await shared.write(async (tx) => {
      await tx.set(`${key}:user-ada|s0`, "older tokens");
      await tx.set("media.revoked:user-ada|s0", "revoked");
      await tx.set("media.signOut:user-ada|s0", "pending");
    });
    await store.forget(slot, "user-ada|s1");

    expect((await keysOf(shared)).toSorted()).toStrictEqual([
      "media.device",
      "media.deviceEpoch",
      "media.deviceId",
      "media.joined.user-ada",
      "media.personal.device-1",
      "media.revoked:user-ada|s0",
      "media.signOut:user-ada|s0",
    ]);
  });

  it("forgets one person and leaves the others signed in here", async () => {
    const { store, shared } = await one();
    const adaSlot = newSlot();
    const boSlot = newSlot();

    await signIn(shared, store, adaSlot, "user-ada|s1");
    await store.promote(adaSlot, { userId: ada, session: "user-ada|s1", joined: joinedAs(1) });
    await signIn(shared, store, boSlot, "user-bo|s2");
    await store.promote(boSlot, { userId: bo, session: "user-bo|s2", joined: joinedAs(2) });
    await store.forget(boSlot, "user-bo|s2");

    expect(store.read()).toStrictEqual({
      device: DEVICE_CODE,
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
    await signingOut.promote(old, { userId: ada, session: "user-ada|s1", joined: joinedAs(1) });
    await deliver();
    await signIn(store, signingIn, fresh, "user-ada|s2");
    await signingIn.promote(fresh, { userId: ada, session: "user-ada|s2", joined: joinedAs(2) });

    expect(signingOut.read().active).toBe(old);

    await signingOut.forget(old, "user-ada|s1");
    await deliver();

    expect({ here: signingOut.read(), there: signingIn.read() }).toStrictEqual({
      here: { device: DEVICE_CODE, active: fresh, people: new Map([[ada, fresh]]) },
      there: { device: DEVICE_CODE, active: fresh, people: new Map([[ada, fresh]]) },
    });
    expect(await keysOf(store)).toContain(signingOut.sessionKey(fresh));
  });

  it("keeps the first device two tabs enroll at once, and tells both which one it is", async () => {
    const {
      stores: [here, there],
    } = await tabs(2, { device: false });

    if (here === undefined || there === undefined) throw new Error("No tab");

    const kept = await Promise.all([
      here.claimDevice("dv_1.first", "1"),
      there.claimDevice("dv_2.second", "2"),
    ]);

    expect({ kept, stored: here.read().device }).toStrictEqual({
      kept: [kept[0], kept[0]],
      stored: kept[0].code,
    });
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
    await expect(
      store.promote(newSlot(), { userId: ada, session: "user-ada|s1", joined: joinedAs(1) }),
    ).rejects.toThrow("can't keep a sign-in");
    await expect(store.sessions.read((tx) => tx.keys())).rejects.toThrow();
  });

  it("keeps the sign-in that joined the device last, though its tab saved first and promotes last", async () => {
    const { first, second, firstSlot, secondSlot, firstSessions, secondSessions, deliver } =
      await twoSignIns();

    // The second tab enrolls and promotes; then the first tab's enrollment ends that session.
    expect(
      await second.promote(secondSlot, {
        userId: ada,
        session: "user-ada|session-2",
        joined: joinedAs(1),
      }),
    ).toBe(true);
    expect(
      await first.promote(firstSlot, {
        userId: ada,
        session: "user-ada|session-1",
        joined: joinedAs(2),
      }),
    ).toBe(true);
    await deliver();

    expect({
      here: first.read(),
      there: second.read(),
      kept: refreshOf(await Effect.runPromise(firstSessions.load)),
      ended: refreshOf(await Effect.runPromise(secondSessions.load)),
    }).toStrictEqual({
      here: { device: DEVICE_CODE, active: firstSlot, people: new Map([[ada, firstSlot]]) },
      there: { device: DEVICE_CODE, active: firstSlot, people: new Map([[ada, firstSlot]]) },
      kept: Option.some("refresh-user-ada|session-1"),
      ended: Option.none(),
    });
  });

  it("does not promote a sign-in that joined the device before the one promoted", async () => {
    const { first, second, firstSlot, secondSlot, secondSessions, deliver } = await twoSignIns();

    expect(
      await second.promote(secondSlot, {
        userId: ada,
        session: "user-ada|session-2",
        joined: joinedAs(2),
      }),
    ).toBe(true);
    expect(
      await first.promote(firstSlot, {
        userId: ada,
        session: "user-ada|session-1",
        joined: joinedAs(1),
      }),
    ).toBe(false);
    await deliver();

    expect({
      origin: first.read(),
      kept: refreshOf(await Effect.runPromise(secondSessions.load)),
    }).toStrictEqual({
      origin: { device: DEVICE_CODE, active: secondSlot, people: new Map([[ada, secondSlot]]) },
      kept: Option.some("refresh-user-ada|session-2"),
    });
  });

  it("promotes a join on the device kept now, though the last promoted was higher on the one before", async () => {
    const { first, second, firstSlot, secondSlot } = await twoSignIns();

    await second.promote(secondSlot, {
      userId: ada,
      session: "user-ada|session-2",
      joined: joinedAs(5),
    });
    await first.clearDevice();
    const kept = await first.claimDevice("dv_device-2.secret", "device-2");

    expect(
      await first.promote(firstSlot, {
        userId: ada,
        session: "user-ada|session-1",
        joined: joinedAs(1, "device-2", kept.epoch),
      }),
    ).toBe(true);
    expect(first.read().people).toStrictEqual(new Map([[ada, firstSlot]]));
  });

  it("keeps a sign-out's last join, so an ended session that answers late is not promoted", async () => {
    const { first, second, firstSlot, secondSlot } = await twoSignIns();

    await second.promote(secondSlot, {
      userId: ada,
      session: "user-ada|session-2",
      joined: joinedAs(2),
    });
    await second.forget(secondSlot, "user-ada|session-2");

    expect(
      await first.promote(firstSlot, {
        userId: ada,
        session: "user-ada|session-1",
        joined: joinedAs(1),
      }),
    ).toBe(false);
    expect(first.read().people).toStrictEqual(new Map());
  });

  it("forgets only its own session when it lost, though the slot took and renewed another since", async () => {
    const {
      stores: [lost, kept, renewing],
      shared: [lostDb, keptDb, renewingDb],
    } = await tabs(3);

    if (
      lost === undefined ||
      kept === undefined ||
      renewing === undefined ||
      lostDb === undefined ||
      keptDb === undefined ||
      renewingDb === undefined
    ) {
      throw new Error("No tab");
    }

    const slot = newSlot();
    const first = sessionAs("user-ada|session-1");
    const second = sessionAs("user-ada|session-2");

    // The first sign-in saves and joins at 1; its enrollment answer is held.
    const lostSessions = await sessionsOf(lostDb, lost, slot);

    await Effect.runPromise(lostSessions.save(first));

    // The slot takes no other sign-in while it holds the first session; once that is signed out
    // here, the second signs into the slot, joins at 2, and promotes.
    const keptSessions = await sessionsOf(keptDb, kept, slot);
    const refusedWhileLive = await Effect.runPromise(keptSessions.save(second));

    await Effect.runPromise(lostSessions.revoke(first));
    await Effect.runPromise(keptSessions.save(second));
    await settleSignIn(kept, slot, {
      userId: ada,
      session: "user-ada|session-2",
      joined: joinedAs(2),
    });

    // A third tab renews the second session.
    const renewed = { ...second, refreshToken: Redacted.make("refresh-user-ada|session-2b") };

    await Effect.runPromise((await sessionsOf(renewingDb, renewing, slot)).renew(second, renewed));

    // The first sign-in's answer lands: it lost, and must forget only its own session.
    const settled = await settleSignIn(lost, slot, {
      userId: ada,
      session: "user-ada|session-1",
      joined: joinedAs(1),
    });

    expect({
      refusedWhileLive,
      settled,
      people: lost.read().people,
      loaded: refreshOf(await Effect.runPromise(keptSessions.load)),
    }).toStrictEqual({
      refusedWhileLive: false,
      settled: false,
      people: new Map([[ada, slot]]),
      loaded: Option.some("refresh-user-ada|session-2b"),
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
    await signingOut.promote(slot, {
      userId: ada,
      session: "user-ada|session-1",
      joined: joinedAs(1),
    });
    await Effect.runPromise(here.revoke(adaSession));
    await Effect.runPromise(there.save(sessionAs("user-bo|session-2")));
    await opening.promote(slot, { userId: bo, session: "user-bo|session-2", joined: joinedAs(2) });
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
  | { readonly kind: "join"; readonly pick: number }
  | { readonly kind: "promote"; readonly pick: number }
  | { readonly kind: "renew"; readonly tab: number; readonly pick: number }
  | { readonly kind: "signOut"; readonly tab: number }
  | { readonly kind: "forget"; readonly pick: number }
  | { readonly kind: "lateAnswer"; readonly pick: number }
  | { readonly kind: "openTile"; readonly tab: number; readonly person: "cy" | "dee" }
  | { readonly kind: "install"; readonly pick: number }
  | { readonly kind: "replaceDevice"; readonly tab: number }
  | { readonly kind: "deliver" };

const TABS = 3;

// Sign-ins, joins, and promotions come most often, so sign-ins overtake each other on one slot.
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("signIn" as const),
      tab: fc.integer({ min: 0, max: TABS - 1 }),
      person: fc.constantFrom("ada" as const, "bo" as const),
      reuse: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("join" as const), pick: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("promote" as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("renew" as const),
      tab: fc.integer({ min: 0, max: TABS - 1 }),
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("signOut" as const),
      tab: fc.integer({ min: 0, max: TABS - 1 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("forget" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("lateAnswer" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("deliver" as const) }) },
  // Several people's tiles race on the device, and the device may be removed and enrolled again
  // while joins and tiles wait to be promoted.
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("openTile" as const),
      tab: fc.integer({ min: 0, max: TABS - 1 }),
      person: fc.constantFrom("cy" as const, "dee" as const),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("install" as const), pick: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("replaceDevice" as const),
      tab: fc.integer({ min: 0, max: TABS - 1 }),
    }),
  },
);

const dee = userId("user-dee");

const PEOPLE = { ada, bo, cy, dee } as const;

const SESSION_PREFIX = "media.session.";

type Joining = ReturnType<typeof joinedAs>;

/** Runs `body` as one Effect, so its steps run in order without awaiting inside a loop. */
const sequence = <A, E>(body: Effect.Effect<A, E>) => Effect.runPromise(body);

const later = <A>(work: () => Promise<A>) => Effect.promise(work);

describe("any interleaving of sign-ins, joins, tiles, device changes, sign-outs, and forgets across tabs", () => {
  it("never loads a signed-out or ended session, and keeps the sessions the core kept", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 4, maxLength: 30 }),
        // Each tab's clock runs up to 60 days off; nothing in the store may depend on it.
        fc.array(fc.integer({ min: -60 * DAY, max: 60 * DAY }), {
          minLength: TABS,
          maxLength: TABS,
        }),
        async (steps, skews) => {
          const { stores, shared, deliver } = await tabs(TABS);

          const on = (tab: number) => onClockSkewedBy(skews[tab] ?? 0);

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

              const joining: Array<{
                tab: number;
                person: "ada" | "bo";
                slot: ReturnType<typeof newSlot>;
                session: string;
              }> = [];

              const promotions: Array<{
                tab: number;
                person: "ada" | "bo";
                slot: ReturnType<typeof newSlot>;
                session: string;
                joined: Joining;
              }> = [];

              // The core's order: each device counts every join and tile; a join ends the
              // person's earlier session there, a tile the tile before it, whoever's.
              const joined: Array<{
                person: "ada" | "bo";
                slot: ReturnType<typeof newSlot>;
                session: string;
                joined: Joining;
              }> = [];

              const counts = new Map<string, number>();

              const tileHeld = new Map<
                string,
                { person: "cy" | "dee"; session: string; epoch: number; sequence: number }
              >();

              // A device is personal or shared; switching ends everyone on it. So a tile after a
              // personal join, or a join after a tile, ends what came before on that device.
              const lastJoinOn = new Map<string, number>();

              const endedTiles = new Set<string>();

              const installs: Array<Parameters<OriginStore["installTile"]>[0] & { tab: number }> =
                [];

              let devicesMade = 1;

              const numberOn = (deviceId: string) => {
                const next = (counts.get(deviceId) ?? 0) + 1;

                counts.set(deviceId, next);

                return next;
              };

              /** The device a tab's store keeps, or a new one it enrolls and keeps. */
              const keptBy = (tab: number) =>
                later(async () => {
                  const { store } = at(tab);
                  const kept = await store.currentDevice();

                  if (kept !== null) return kept;
                  devicesMade += 1;

                  return store.claimDevice(
                    `dv_device-${devicesMade}.secret`,
                    `device-${devicesMade}`,
                  );
                });

              const forgets: Array<{
                tab: number;
                slot: ReturnType<typeof newSlot>;
                session: string | null;
              }> = [];

              const revoked = new Set<string>();
              const lastSaved = new Map<string, string>();
              const found: Array<string> = [];
              let made = 0;

              const runJoin = (index: number) =>
                Effect.gen(function* () {
                  const [join] = joining.splice(index % joining.length, 1);

                  if (join === undefined) return;
                  const kept = yield* keptBy(join.tab);
                  const numbered = joinedAs(numberOn(kept.deviceId), kept.deviceId, kept.epoch);

                  lastJoinOn.set(kept.deviceId, numbered.sequence);
                  joined.push({ ...join, joined: numbered });
                  promotions.push({ ...join, joined: numbered });
                });

              const runInstall = (index: number) =>
                Effect.gen(function* () {
                  const [tile] = installs.splice(index % installs.length, 1);

                  if (tile === undefined) return;
                  yield* later(() => at(tile.tab).store.installTile(tile));
                });

              const runPromotion = (index: number) =>
                Effect.gen(function* () {
                  const [promotion] = promotions.splice(index % promotions.length, 1);

                  if (promotion === undefined) return;
                  const { store } = at(promotion.tab);

                  // The account client's own settling of a finished sign-in.
                  yield* later(() =>
                    settleSignIn(store, promotion.slot, {
                      userId: PEOPLE[promotion.person],
                      session: promotion.session,
                      joined: promotion.joined,
                    }),
                  );
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

                    if (yield* on(next.tab)((yield* storage(next.tab, slot)).save(tokens))) {
                      signedIn.push({ person: next.person, slot, session });
                      lastSaved.set(slot, session);
                      joining.push({ tab: next.tab, person: next.person, slot, session });
                    }

                    break;
                  }

                  case "join":
                    if (joining.length > 0) yield* runJoin(next.pick);
                    break;
                  case "openTile": {
                    const kept = yield* keptBy(next.tab);
                    const sequenceHere = numberOn(kept.deviceId);

                    made += 1;
                    const session = `user-${next.person}|t${made}`;
                    const tokens = sessionAs(session);
                    const staging = newSlot();
                    const before = tileHeld.get(kept.deviceId);

                    sessions.set(session, tokens);

                    if (before !== undefined) endedTiles.add(before.session);
                    tileHeld.set(kept.deviceId, {
                      person: next.person,
                      session,
                      epoch: kept.epoch,
                      sequence: sequenceHere,
                    });

                    if (yield* on(next.tab)((yield* storage(next.tab, staging)).save(tokens))) {
                      installs.push({
                        tab: next.tab,
                        userId: PEOPLE[next.person],
                        session,
                        deviceId: kept.deviceId,
                        epoch: kept.epoch,
                        sequence: sequenceHere,
                        from: staging,
                      });
                    }

                    break;
                  }

                  case "install":
                    if (installs.length > 0) yield* runInstall(next.pick);
                    break;
                  case "replaceDevice":
                    // The core forgets the device and every session on it; this tab's client
                    // hears the device is unknown and clears it, as the gate does.
                    yield* later(() => at(next.tab).store.clearDevice());
                    break;
                  case "promote":
                    if (promotions.length > 0) yield* runPromotion(next.pick);
                    break;
                  case "renew": {
                    const renewing = signedIn[next.pick % Math.max(signedIn.length, 1)];

                    const tokens =
                      renewing === undefined ? undefined : sessions.get(renewing.session);

                    if (renewing === undefined || tokens === undefined) break;
                    made += 1;

                    const renewed = { ...tokens, refreshToken: Redacted.make(`refresh-r${made}`) };
                    const renewer = yield* storage(next.tab, renewing.slot);

                    if (yield* on(next.tab)(renewer.renew(tokens, renewed))) {
                      sessions.set(renewing.session, renewed);
                    }

                    break;
                  }

                  case "signOut": {
                    const { store } = at(next.tab);
                    const slot = store.read().active;

                    if (slot === null) break;
                    const session = yield* later(() => sessionIn(store, slot));
                    const tokens = session === null ? undefined : sessions.get(session);

                    if (session === null || tokens === undefined) break;
                    yield* on(next.tab)((yield* storage(next.tab, slot)).revoke(tokens));
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

                    if (yield* on(0)((yield* storage(0, where.slot)).save(tokens))) {
                      found.push(`a late answer stored ${where.session} again`);
                    }

                    break;
                  }

                  case "deliver":
                    yield* later(deliver);
                    break;
                }
              }

              while (joining.length > 0) yield* runJoin(0);

              while (promotions.length > 0) yield* runPromotion(0);

              while (installs.length > 0) yield* runInstall(0);

              while (forgets.length > 0) yield* runForget(0);
              yield* later(deliver);

              const { store } = at(0);

              for (const { slot } of signedIn) {
                const loaded = yield* on(0)((yield* storage(0, slot)).load);
                const held = yield* later(() => sessionIn(store, slot));

                if (Option.isSome(loaded) && held !== null && revoked.has(held)) {
                  found.push(`slot ${slot} loads signed-out ${held}`);
                }
              }

              const finalDevice = yield* later(() => store.currentDevice());
              const keys = yield* later(() => keysOf(at(0).db));

              const onFinalDevice = (join: Joining) =>
                finalDevice !== null &&
                join.deviceId === finalDevice.deviceId &&
                join.epoch === finalDevice.epoch;

              for (const ended of endedTiles) {
                if (
                  keys.some((key) => key.startsWith(SESSION_PREFIX) && key.endsWith(`:${ended}`))
                ) {
                  found.push(`the ended tile ${ended} keeps its tokens`);
                }
              }

              const liveTile =
                finalDevice === null ? undefined : tileHeld.get(finalDevice.deviceId);

              if (
                finalDevice !== null &&
                liveTile !== undefined &&
                liveTile.epoch === finalDevice.epoch &&
                liveTile.sequence > (lastJoinOn.get(finalDevice.deviceId) ?? 0) &&
                !revoked.has(liveTile.session)
              ) {
                const slot = store.read().people.get(PEOPLE[liveTile.person]);
                const held = slot === undefined ? null : yield* later(() => sessionIn(store, slot));

                if (held !== liveTile.session) {
                  found.push(`the live tile ${liveTile.session} is not ${liveTile.person}'s`);
                }
              }

              for (const person of ["ada", "bo"] as const) {
                const newest = joined.findLast(
                  (each) => each.person === person && onFinalDevice(each.joined),
                );

                // A tile opened on the device after it ended it, as switching modes does.
                if (
                  newest !== undefined &&
                  (tileHeld.get(newest.joined.deviceId)?.sequence ?? 0) > newest.joined.sequence
                ) {
                  continue;
                }

                // Only a later sign-in on the same slot, or signing this one out, may take it away.
                if (newest === undefined || revoked.has(newest.session)) continue;

                if (lastSaved.get(newest.slot) !== newest.session) continue;
                const held = yield* later(() => sessionIn(store, newest.slot));

                if (
                  held !== newest.session ||
                  store.read().people.get(PEOPLE[person]) !== newest.slot
                ) {
                  found.push(`${person}'s live session ${newest.session} lost its slot`);
                }
              }

              return found;
            }),
          );

          expect(violations).toStrictEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  }, 120_000);
});
