import type { PlatformOptions, SharedStore } from "@media/sdk/promise";

import type { Keychain } from "./keychain";

/** The calls the keychains make on expo-secure-store, which the app passes in as itself. */
export interface SecureStoreModule {
  readonly getItem: (key: string, options: StoreOptions) => string | null;
  readonly setItem: (key: string, value: string, options: StoreOptions) => void;
  readonly getItemAsync: (key: string, options: StoreOptions) => Promise<string | null>;
  readonly setItemAsync: (key: string, value: string, options: StoreOptions) => Promise<void>;
  readonly deleteItemAsync: (key: string, options: StoreOptions) => Promise<void>;
}

/** The options each call names: the keychain access group the item belongs to, if any. */
export interface StoreOptions {
  readonly accessGroup?: string;
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

const optionsFor = (group: string | null): StoreOptions =>
  group === null ? {} : { accessGroup: group };

/**
 * A keychain in one access group. Every call names the group: an item written without one lands
 * in the first group the app's entitlement lists, which could be the shared one. A write the
 * keychain refuses, as while the device is locked, holds in memory until a later write lands or
 * the app quits. Only refused writes are held, so values another app writes to the shared group
 * are read fresh.
 */
const keychainIn = (store: SecureStoreModule, options: StoreOptions): Keychain => {
  const refused = new Map<string, string | null>();

  return {
    read: (key) => {
      const held = refused.get(key);

      if (held !== undefined) return held;

      try {
        const value = store.getItem(key, options);

        return value === "" ? null : value;
      } catch {
        return null;
      }
    },
    // Clearing writes an empty value synchronously rather than deleting, so a clear followed by a
    // write can never land out of order.
    write: (key, value) => {
      try {
        store.setItem(key, value ?? "", options);
        refused.delete(key);
      } catch {
        refused.set(key, value);
      }
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
  const ownOptions = optionsFor(groups.own);
  const own = keychainIn(store, ownOptions);

  const sessions: SessionStore = {
    getItem: (key) => store.getItemAsync(key, ownOptions),
    setItem: (key, value) => store.setItemAsync(key, value, ownOptions),
    removeItem: (key) => store.deleteItemAsync(key, ownOptions),
  };

  if (groups.shared === null) return { own, shared: own, sharesWithApps: false, sessions };

  const sharedOptions = optionsFor(groups.shared);

  try {
    store.setItem(PROBE_KEY, "1", sharedOptions);
  } catch {
    return { own, shared: own, sharesWithApps: false, sessions };
  }

  return { own, shared: keychainIn(store, sharedOptions), sharesWithApps: true, sessions };
};

/**
 * The shared group's name after the Team ID. Every [media] app lists it in its
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
