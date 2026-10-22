/**
 * Small values this install keeps between launches, in the iOS keychain through Expo SecureStore:
 * the server it connects to, the Convex Auth tokens for each server, and the appearance. Reads
 * are synchronous so the first frame can decide what to show.
 */
import type { TokenStorage } from "@convex-dev/auth/react";
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
 * Convex Auth's token store. The provider namespaces every key by server origin, so each server
 * keeps its own session and switching back to a server finds it still signed in.
 */
export const tokenStorage: TokenStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
