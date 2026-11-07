import type { PlatformProviderProps } from "@media/sdk/react";
import { randomUuid } from "@media/ui/lib/secure-context";
import { Brand } from "effect";

import type { UserId } from "./platform-types";

type KeyValueStore = PlatformProviderProps["storage"];

/**
 * A local name for one sign-in's stored session. A session is written before the app knows whose
 * it is, so its key cannot be named after the person; a slot is promoted to a person once the
 * sign-in says who it is. Never sent to the server.
 */
export type SlotId = string & Brand.Brand<"SlotId">;

const SlotId = Brand.nominal<SlotId>();

const UserId = Brand.nominal<UserId>();

/** What this browser holds for every client on the origin. */
export interface Origin {
  /** This browser's device code, `dv_<id>.<secret>`, once a sign-in has enrolled it. */
  readonly device: string | null;
  /** The slot every client on the origin acts as. */
  readonly active: SlotId | null;
  /** Each person who has a session on this browser, and the slot that holds it. */
  readonly people: ReadonlyMap<UserId, SlotId>;
}

/**
 * The origin's account state in `localStorage`. Every key name lives in this file, and each key
 * has one writer: the SDK writes `media.session.<slot>`, this store writes the rest. Other tabs
 * and other clients on the origin learn of every change through `storage` events (D52).
 */
export interface OriginStore {
  /** The current state; the same object until a key changes. */
  readonly read: () => Origin;
  /** Calls `onChange` after this tab's writes and other tabs' `storage` events. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** The SDK's session store over the same `localStorage`, following other tabs' writes. */
  readonly sessions: KeyValueStore;
  /** The key a slot's session lives under. */
  readonly sessionKey: (slot: SlotId) => string;
  /**
   * Makes `slot` the one holding `userId`, and the active slot. A different slot that held
   * `userId` before goes, since the core keeps one session per person per device, and so does
   * whoever `slot` held before, as on a shared device whose one slot a new tile took. Idempotent.
   */
  readonly promote: (slot: SlotId, userId: UserId) => void;
  /** Makes `slot` the one every client acts as. */
  readonly activate: (slot: SlotId) => void;
  /**
   * Forgets `slot` here: its session, whoever it held, and the active slot when it was this one.
   * It names the slot rather than a person, so a person's newer slot, as from signing in again in
   * another tab meanwhile, is left alone.
   */
  readonly forget: (slot: SlotId) => void;
  readonly setDevice: (code: string) => void;
  readonly clearDevice: () => void;
}

const KEYS = {
  device: "media.device",
  active: "media.active",
  person: "media.person.",
  session: "media.session.",
} as const;

const { device: DEVICE, active: ACTIVE, person: PERSON, session: SESSION } = KEYS;

const sessionKey = (slot: SlotId): string => `${SESSION}${slot}`;

// SAFETY: a type predicate, not checked by the compiler. Only `storage` events carry these fields;
// checking them rather than `instanceof StorageEvent` keeps the store usable where that class is
// missing, such as Node in tests.
const isStorageEvent = (event: Event): event is StorageEvent =>
  "storageArea" in event && "key" in event;

interface Snapshot {
  /** The keys' text, to tell whether anything changed. */
  readonly raw: string;
  readonly origin: Origin;
}

const isOurs = (key: string | null): boolean =>
  key === null ||
  key === DEVICE ||
  key === ACTIVE ||
  key.startsWith(PERSON) ||
  key.startsWith(SESSION);

/** Where the store listens for other tabs' writes: `window` in the browser. */
export type StorageEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** A slot no one has used: a random id. */
export const newSlot = (): SlotId => SlotId(randomUuid());

/** The origin's account state over `storage`, told of other tabs' writes by `events`. */
export const makeOriginStore = (storage: Storage, events: StorageEvents): OriginStore => {
  const listeners = new Set<() => void>();
  const keyListeners = new Set<{ readonly key: string; readonly onChange: () => void }>();

  let cached: Snapshot | null = null;

  // Storage is read again only after a write here or another tab's `storage` event for our keys.
  let stale = true;

  const notify = (key: string | null) => {
    for (const listener of keyListeners) {
      if (key === null || key === listener.key || key.startsWith(`${listener.key}:`)) {
        listener.onChange();
      }
    }

    if (isOurs(key)) {
      stale = true;

      for (const listener of listeners) listener();
    }
  };

  const write = (key: string, value: string | null) => {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  };

  const snapshot = (): Snapshot => {
    const people = new Map<UserId, SlotId>();
    const parts: Array<string> = [];

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);

      if (key?.startsWith(PERSON) === true) {
        const slot = storage.getItem(key);

        if (slot !== null) {
          people.set(UserId(key.slice(PERSON.length)), SlotId(slot));
          parts.push(`${key}=${slot}`);
        }
      }
    }

    const device = storage.getItem(DEVICE);
    const active = storage.getItem(ACTIVE);

    parts.sort();
    parts.push(`${DEVICE}=${device ?? ""}`, `${ACTIVE}=${active ?? ""}`);

    return {
      raw: parts.join("\n"),
      origin: { device, active: active === null ? null : SlotId(active), people },
    };
  };

  const read = (): Origin => {
    if (cached === null || stale) {
      const next = snapshot();

      stale = false;

      if (cached === null || cached.raw !== next.raw) cached = next;
    }

    return cached.origin;
  };

  const onStorage = (event: Event) => {
    if (isStorageEvent(event) && event.storageArea === storage) notify(event.key);
  };

  events.addEventListener("storage", onStorage);

  const change = (writes: ReadonlyArray<readonly [string, string | null]>) => {
    for (const [key, value] of writes) write(key, value);

    for (const [key] of writes) notify(key);
  };

  /**
   * Removes a slot nobody uses any more: its session and each of its sessions' tokens. The SDK's
   * revocation records stay, so a renewal that lands later still loads as no session.
   */
  const dropSlot = (slot: SlotId): ReadonlyArray<readonly [string, null]> => {
    const prefix = `${sessionKey(slot)}:`;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));

    return [
      [sessionKey(slot), null],
      ...keys.flatMap((key) =>
        key !== null &&
        key.startsWith(prefix) &&
        !key.endsWith(":revoked") &&
        !key.endsWith(":confirmed")
          ? [[key, null] as const]
          : [],
      ),
    ];
  };

  const forgetting = (slot: SlotId): ReadonlyArray<readonly [string, string | null]> => {
    const { people, active } = read();

    return [
      ...[...people].flatMap(([person, held]) =>
        held === slot ? [[`${PERSON}${person}`, null] as const] : [],
      ),
      ...dropSlot(slot),
      ...(active === slot ? [[ACTIVE, null] as const] : []),
    ];
  };

  return {
    read,
    subscribe: (onChange) => {
      listeners.add(onChange);

      return () => {
        listeners.delete(onChange);
      };
    },
    sessions: {
      getItem: (key) => storage.getItem(key),
      keys: () => Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? ""),
      setItem: (key, value) => {
        storage.setItem(key, value);
      },
      removeItem: (key) => {
        storage.removeItem(key);
      },
      subscribe: (key, onChange) => {
        const listener = { key, onChange };

        keyListeners.add(listener);

        return () => {
          keyListeners.delete(listener);
        };
      },
    },
    sessionKey,
    promote: (slot, userId) => {
      const { people } = read();
      const before = people.get(userId);

      const others = [...people].flatMap(([other, held]) =>
        held === slot && other !== userId ? [[`${PERSON}${other}`, null] as const] : [],
      );

      change([
        ...others,
        ...(before === undefined || before === slot ? [] : dropSlot(before)),
        [`${PERSON}${userId}`, slot],
        [ACTIVE, slot],
      ]);
    },
    activate: (slot) => change([[ACTIVE, slot]]),
    forget: (slot) => change(forgetting(slot)),
    setDevice: (code) => change([[DEVICE, code]]),
    clearDevice: () => change([[DEVICE, null]]),
  };
};
