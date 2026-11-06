import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { makeOriginStore, newSlot } from "./origin";
import type { UserId } from "./platform-types";

const userId = Brand.nominal<UserId>();

/** `localStorage` as one origin holds it: every tab shares the same items. */
class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** Another tab's write, as the browser reports it to this one. */
const storageEvent = (storage: Storage, key: string | null): Event =>
  Object.assign(new Event("storage"), { key, storageArea: storage });

const ada = userId("user-ada");

const bo = userId("user-bo");

describe("the origin store", () => {
  it("makes a signed-in slot its person's and the active one", () => {
    const store = makeOriginStore(new MemoryStorage(), new EventTarget());
    const slot = newSlot();

    store.promote(slot, ada);

    expect(store.read()).toStrictEqual({
      device: null,
      active: slot,
      people: new Map([[ada, slot]]),
    });
  });

  it("keeps the same snapshot until a key changes", () => {
    const store = makeOriginStore(new MemoryStorage(), new EventTarget());
    const before = store.read();

    expect(store.read()).toBe(before);

    store.setDevice("dv_1.secret");

    expect(store.read()).not.toBe(before);
    expect(store.read().device).toBe("dv_1.secret");
  });

  it("drops a person's older session when they sign in on another slot", () => {
    const storage = new MemoryStorage();
    const store = makeOriginStore(storage, new EventTarget());
    const first = newSlot();
    const second = newSlot();

    storage.setItem(store.sessionKey(first), "first tokens");
    store.promote(first, ada);
    store.promote(second, ada);

    expect(storage.getItem(store.sessionKey(first))).toBeNull();
    expect(store.read().people).toStrictEqual(new Map([[ada, second]]));
  });

  it("gives a shared device's one slot to the tile opened last", () => {
    const store = makeOriginStore(new MemoryStorage(), new EventTarget());
    const slot = newSlot();

    store.promote(slot, ada);
    store.promote(slot, bo);

    expect(store.read().people).toStrictEqual(new Map([[bo, slot]]));
  });

  it("forgets one person and leaves the others signed in here", () => {
    const storage = new MemoryStorage();
    const store = makeOriginStore(storage, new EventTarget());
    const adaSlot = newSlot();
    const boSlot = newSlot();

    storage.setItem(store.sessionKey(adaSlot), "ada tokens");
    store.promote(adaSlot, ada);
    store.promote(boSlot, bo);
    store.forget(bo);

    expect(store.read()).toStrictEqual({
      device: null,
      active: null,
      people: new Map([[ada, adaSlot]]),
    });
    expect(storage.getItem(store.sessionKey(adaSlot))).toBe("ada tokens");
  });

  it("forgets everyone but keeps the device when it becomes shared", () => {
    const storage = new MemoryStorage();
    const store = makeOriginStore(storage, new EventTarget());
    const slot = newSlot();

    store.setDevice("dv_1.secret");
    storage.setItem(store.sessionKey(slot), "tokens");
    store.promote(slot, ada);
    store.forgetAll();

    expect(store.read()).toStrictEqual({ device: "dv_1.secret", active: null, people: new Map() });
    expect(storage.getItem(store.sessionKey(slot))).toBeNull();
  });

  it("tells this tab of another tab's switch", () => {
    const storage = new MemoryStorage();
    const events = new EventTarget();
    const store = makeOriginStore(storage, events);
    const seen: Array<string | null> = [];
    const slot = newSlot();

    store.subscribe(() => seen.push(store.read().active));
    storage.setItem("media.active", slot);
    events.dispatchEvent(storageEvent(storage, "media.active"));

    expect(seen).toStrictEqual([slot]);
  });

  it("tells a session's engine when another tab writes or removes that session", () => {
    const storage = new MemoryStorage();
    const events = new EventTarget();
    const store = makeOriginStore(storage, events);
    const slot = newSlot();
    const other = newSlot();
    let changes = 0;

    store.sessions.subscribe?.(store.sessionKey(slot), () => {
      changes += 1;
    });
    events.dispatchEvent(storageEvent(storage, store.sessionKey(other)));
    events.dispatchEvent(storageEvent(storage, store.sessionKey(slot)));
    store.promote(slot, ada);
    store.forget(ada);

    expect(changes).toBe(2);
  });

  it("ignores another storage area's events", () => {
    const events = new EventTarget();
    const store = makeOriginStore(new MemoryStorage(), events);
    let changes = 0;

    store.subscribe(() => {
      changes += 1;
    });
    events.dispatchEvent(storageEvent(new MemoryStorage(), "media.active"));

    expect(changes).toBe(0);
  });
});
