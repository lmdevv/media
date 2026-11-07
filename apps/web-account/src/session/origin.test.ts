import { openIndexedDb } from "@media/sdk/promise";
import type { SharedStore } from "@media/sdk/promise";
import { Brand } from "effect";
import { IDBFactory } from "fake-indexeddb";
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

describe("the origin store", () => {
  it("makes a signed-in slot its person's and the active one", async () => {
    const { store } = await one();
    const slot = newSlot();

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

    await shared.write((tx) => tx.set(store.sessionKey(first), "ada|s1"));
    await store.promote(first, ada);
    await store.promote(second, ada);

    expect(await keysOf(shared)).not.toContain(store.sessionKey(first));
    expect(store.read().people).toStrictEqual(new Map([[ada, second]]));
  });

  it("gives a shared device's one slot to the tile opened last", async () => {
    const { store } = await one();
    const slot = newSlot();

    await store.promote(slot, ada);
    await store.promote(slot, bo);

    expect(store.read().people).toStrictEqual(new Map([[bo, slot]]));
  });

  it("drops a forgotten slot's tokens but keeps the sessions' revocations", async () => {
    const { store, shared } = await one();
    const slot = newSlot();
    const key = store.sessionKey(slot);

    await store.promote(slot, ada);
    await shared.write(async (tx) => {
      await tx.set(key, "ada|s1");
      await tx.set(`${key}:ada|s1`, "tokens");
      await tx.set("media.revoked:ada|s0", "revoked");
      await tx.set("media.signOut:ada|s0", "pending");
    });
    await store.forget(slot);

    expect((await keysOf(shared)).toSorted()).toStrictEqual([
      "media.revoked:ada|s0",
      "media.signOut:ada|s0",
    ]);
  });

  it("forgets one person and leaves the others signed in here", async () => {
    const { store, shared } = await one();
    const adaSlot = newSlot();
    const boSlot = newSlot();

    await shared.write((tx) => tx.set(store.sessionKey(adaSlot), "ada|s1"));
    await store.promote(adaSlot, ada);
    await store.promote(boSlot, bo);
    await store.forget(boSlot);

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

    await signingOut.promote(old, ada);
    await deliver();
    await store.write((tx) => tx.set(signingOut.sessionKey(fresh), "ada|s2"));
    await signingIn.promote(fresh, ada);

    expect(signingOut.read().active).toBe(old);

    await signingOut.forget(old);
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
    await expect(store.promote(newSlot(), ada)).rejects.toThrow("IndexedDB is unavailable");
    await expect(store.sessions.read((tx) => tx.keys())).rejects.toThrow();
  });
});
