import type { MoviesProviderProps } from "@media/sdk/react";
import * as SecureStore from "expo-secure-store";

/** Reads `key`, or null when it is unset, cleared, or the keychain is unavailable. */
export const readValue = (key: string): string | null => {
  try {
    const value = SecureStore.getItem(key);

    return value === "" ? null : value;
  } catch {
    return null;
  }
};

/**
 * Writes `key`, or clears it with null. Clearing writes an empty value synchronously rather than
 * deleting, so a clear followed by a write can never land out of order. A keychain failure keeps
 * the value for this launch only.
 */
export const writeValue = (key: string, value: string | null): void => {
  try {
    SecureStore.setItem(key, value ?? "");
  } catch {
    // The keychain can refuse writes while the device is locked; the app keeps working in memory.
  }
};

/**
 * Where the SDK keeps the Convex Auth session for the account server at `convexUrl`. Each server
 * has its own key, so a token saved late for one server can never reach another.
 */
export const sessionKeyFor = (convexUrl: string): string =>
  `movies.session.${convexUrl.replace(/[^\w.-]/gu, "_")}`;

/** The SDK's session store: the Convex Auth tokens, kept in the keychain. */
export const sessionStore: MoviesProviderProps["storage"] = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
