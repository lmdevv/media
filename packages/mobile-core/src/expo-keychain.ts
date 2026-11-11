import type { PlatformOptions, SharedStore } from "@media/sdk/promise";
import * as SecureStore from "expo-secure-store";

import type { Keychain } from "./keychain";

type Options = SecureStore.SecureStoreOptions;

/** A store the SDK keeps one client's session in, under one key. */
type SessionStore = Exclude<NonNullable<PlatformOptions["storage"]>, SharedStore>;

const keychainOver = (options: Options): Keychain => ({
  read: (key) => {
    try {
      const value = SecureStore.getItem(key, options);

      return value === "" ? null : value;
    } catch {
      return null;
    }
  },
  // Clearing writes an empty value synchronously rather than deleting, so a clear followed by a
  // write can never land out of order.
  write: (key, value) => {
    try {
      SecureStore.setItem(key, value ?? "", options);
    } catch {
      // The keychain refuses writes while the device is locked; the app keeps working in memory.
    }
  },
});

/** The app's own keychain, which no other app reads. */
export const ownKeychain: Keychain = keychainOver({});

const PROBE_KEY = "media.probe";

/** The phone's shared keychain, and whether it is the shared access group or the app's own. */
export interface SharedKeychain {
  readonly keychain: Keychain;
  /** False when the build cannot write the access group and the app keeps the record itself. */
  readonly shared: boolean;
}

/**
 * The phone's shared keychain access group `accessGroup`, such as `J9DZZ82K23.dev.lmdevv.media`,
 * which every [media] app signed with the same Team ID reads (D48). A build that does not carry
 * the group's entitlement, such as a simulator build without a team, cannot write it: the app then
 * keeps the shared record in its own keychain, and works alone. `shared` says which one it got.
 */
export const sharedKeychain = (accessGroup: string | null): SharedKeychain => {
  if (accessGroup === null) return { keychain: ownKeychain, shared: false };

  const options = { accessGroup };

  try {
    SecureStore.setItem(PROBE_KEY, "1", options);

    return { keychain: keychainOver(options), shared: true };
  } catch {
    return { keychain: ownKeychain, shared: false };
  }
};

/** The SDK's session store over the app's own keychain, where the app's session lives (D48). */
export const ownSessionStore: SessionStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
