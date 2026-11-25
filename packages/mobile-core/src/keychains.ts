import type { PlatformOptions, SharedStore } from "@media/sdk/promise";
import { Option, Schema } from "effect";

import { KeychainWriteFailed } from "./keychain";
import type { Keychain } from "./keychain";

/** The calls the keychains make on expo-secure-store, which the app passes in as itself. */
export interface SecureStoreModule {
  /**
   * The class that keeps an item readable while the device is locked, once it has been unlocked
   * after a restart, and never restores it to another device from a backup.
   */
  readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
  readonly getItem: (key: string, options: StoreOptions) => string | null;
  readonly setItem: (key: string, value: string, options: StoreOptions) => void;
  readonly getItemAsync: (key: string, options: StoreOptions) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string, options: StoreOptions) => Promise<void>;
  readonly deleteItemAsync: (key: string, options: StoreOptions) => Promise<void>;
}

/**
 * The options each call names: the keychain access group the item belongs to, if any, and the
 * accessibility class a write stores it in. Lookups ignore the class, so a read finds an item
 * stored in any class, and writing an existing item moves it to the class named.
 */
export interface StoreOptions {
  readonly accessGroup?: string;
  readonly keychainAccessible?: number;
}

/** A store the SDK keeps one client's session in, under one key. */
export type SessionStore = Exclude<NonNullable<PlatformOptions["storage"]>, SharedStore>;

/**
 * The keychain access groups an app uses, each with its Team ID, such as
 * `J9DZZ82K23.dev.lmdevv.movies`. Null for both in a build without a Team ID.
 */
export interface KeychainGroups {
  /** The app's private group: its session, its device code, and its own records (D48). */
  readonly own: string | null;
  /** The phone's shared group: only the server's address, the user id, and the grant (D48). */
  readonly shared: string | null;
}

/** An app's keychains. */
export interface Keychains {
  /** The app's own records, in its private group. */
  readonly own: Keychain;
  /** The phone's shared record, in the shared group; the own keychain when that cannot be written. */
  readonly shared: Keychain;
  /** False when the build cannot write the shared group and the app keeps the record itself. */
  readonly sharesWithApps: boolean;
  /** The platform client's session store, in the app's private group. */
  readonly sessions: SessionStore;
}

/**
 * Every item is stored after-first-unlock, so iOS can wake the app while the phone is locked, for
 * background audio, a finished download, or a relaunch, and it still reads the sign-in.
 */
const optionsFor = (store: SecureStoreModule, group: string | null): StoreOptions => {
  const keychainAccessible = store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

  return group === null ? { keychainAccessible } : { accessGroup: group, keychainAccessible };
};

/**
 * The keys in a group whose items an app rewrote in the after-first-unlock class, as a JSON array.
 * Items an older build wrote sit in expo-secure-store's default class, readable only while the
 * device is unlocked; the first read of each rewrites it once, and this list keeps later launches
 * from rewriting it again.
 */
const MOVED_KEY = "media.accessible";

const MovedJson = Schema.fromJsonString(Schema.Array(Schema.String));

const decodeMoved = Schema.decodeOption(MovedJson);

const encodeMoved = Schema.encodeSync(MovedJson);

/** Runs a keychain call and reports whether it landed. */
const lands = (call: () => void): boolean => {
  try {
    call();

    return true;
  } catch {
    return false;
  }
};

/** A keychain in one access group, and the step that moves a stored item to its class. */
interface Group {
  readonly keychain: Keychain;
  /** Rewrites the value stored at `key` in the group's class, unless an earlier read already did. */
  readonly settle: (key: string) => void;
}

/**
 * A keychain in one access group. Every call names the group: an item written without one lands
 * in the first group the app's entitlement lists, which could be the shared one. A best-effort
 * write the keychain refuses, as while the device is locked, holds in memory until a later write
 * lands or the app quits; a durable write throws instead and holds nothing. Only refused writes
 * are held, so values another app writes to the shared group are read fresh.
 *
 * With `onRead` "move", the first read of an item rewrites it in the group's class. Only this app
 * writes its private group, so nothing lands between that read and its rewrite. The shared group
 * takes "leave": another app can write it at any moment, and a rewrite of the value just read
 * could put an older grant back over that app's newer one.
 */
const groupIn = (
  store: SecureStoreModule,
  options: StoreOptions,
  onRead: "move" | "leave",
): Group => {
  const refused = new Map<string, string | null>();

  // Loaded by the first read that finds a value; null when the keychain could not read the list,
  // and then nothing moves this launch, so a list that failed to load is never written over.
  let moved: Set<string> | null | undefined;

  const movedKeys = (): Set<string> | null => {
    if (moved !== undefined) return moved;

    try {
      const stored = store.getItem(MOVED_KEY, options);

      moved = new Set(
        stored === null
          ? []
          : Option.getOrElse(decodeMoved(stored), (): ReadonlyArray<string> => []),
      );
    } catch {
      moved = null;
    }

    return moved;
  };

  const stored = (key: string): string | null => {
    try {
      const value = store.getItem(key, options);

      return value === "" ? null : value;
    } catch {
      return null;
    }
  };

  // The rewrite stores the value it was handed: callers pass one read in the same synchronous
  // turn, so no write from this app lands between the read and the rewrite.
  const move = (key: string, value: string): void => {
    if (onRead === "leave") return;

    const keys = movedKeys();

    if (keys === null || keys.has(key) || !lands(() => store.setItem(key, value, options))) return;

    keys.add(key);
    // A list that fails to save costs one more rewrite of the key on a later launch.
    lands(() => store.setItem(MOVED_KEY, encodeMoved([...keys]), options));
  };

  // Clearing writes an empty value synchronously rather than deleting, so a clear followed by a
  // write can never land out of order.
  const persist = (key: string, value: string | null): void => {
    store.setItem(key, value ?? "", options);
    refused.delete(key);
  };

  const keychain: Keychain = {
    read: (key) => {
      const held = refused.get(key);

      if (held !== undefined) return held;

      const value = stored(key);

      if (value !== null) move(key, value);

      return value;
    },
    write: (key, value) => {
      try {
        persist(key, value);
      } catch {
        refused.set(key, value);
      }
    },
    writeDurably: (key, value) => {
      try {
        persist(key, value);
      } catch (cause) {
        // A held value would let this launch read what a later one never could.
        refused.delete(key);

        throw new KeychainWriteFailed({
          key,
          message: `The keychain refused ${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    },
  };

  return {
    keychain,
    settle: (key) => {
      const value = stored(key);

      if (value !== null) move(key, value);
    },
  };
};

const PROBE_KEY = "media.probe";

/**
 * Opens an app's keychains over `store` in `groups` (D48). A build that cannot write the shared
 * group, such as a simulator build without a team, keeps the shared record in its own group and
 * works alone.
 */
export const openKeychains = (store: SecureStoreModule, groups: KeychainGroups): Keychains => {
  const ownOptions = optionsFor(store, groups.own);
  const own = groupIn(store, ownOptions, "move");

  // Session calls run one at a time, in the order the SDK makes them: the read moves its item
  // with a synchronous read and rewrite, which no session write may land between.
  let turn: Promise<unknown> = Promise.resolve();

  const inTurn = <A>(call: () => Promise<A>): Promise<A> => {
    const next = turn.then(call, call);

    turn = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  };

  const sessions: SessionStore = {
    getItem: (key) =>
      inTurn(async () => {
        const value = await store.getItemAsync(key, ownOptions);

        // The read reaches the keychain again: a synchronous write, such as a disconnect
        // clearing the session, may have landed while this one was away from the thread.
        if (value !== null) own.settle(key);

        return value;
      }),
    setItem: (key, value) => inTurn(() => store.setItemAsync(key, value, ownOptions)),
    removeItem: (key) => inTurn(() => store.deleteItemAsync(key, ownOptions)),
  };

  if (groups.shared === null) {
    return { own: own.keychain, shared: own.keychain, sharesWithApps: false, sessions };
  }

  // The probe runs at open, ahead of the first render's shared read. Deferred to the first shared
  // write, it could meet a phone locked since launch and send the grant to the private group,
  // where no other app reads it.
  const sharedOptions = optionsFor(store, groups.shared);

  if (!lands(() => store.setItem(PROBE_KEY, "1", sharedOptions))) {
    return { own: own.keychain, shared: own.keychain, sharesWithApps: false, sessions };
  }

  return {
    own: own.keychain,
    // The shared grant is read only in the foreground, at a password sign-in or a signed-out
    // launch, so it never has to be readable while locked; the next sign-in's write moves it.
    shared: groupIn(store, sharedOptions, "leave").keychain,
    sharesWithApps: true,
    sessions,
  };
};

/**
 * The shared group's name after the Team ID. Every Lar app lists it in its
 * `keychain-access-groups` entitlement, after its own group, so they share one sign-in (D48).
 */
const SHARED_GROUP = "dev.lmdevv.media";

/**
 * The keychain groups of the app `bundleId` signed with `team`: its private group, named for the
 * app, and the shared one. A build without a Team ID names neither.
 */
export const groupsFor = (team: string | null, bundleId: string | null): KeychainGroups =>
  team === null
    ? { own: null, shared: null }
    : {
        own: bundleId === null ? null : `${team}.${bundleId}`,
        shared: `${team}.${SHARED_GROUP}`,
      };
