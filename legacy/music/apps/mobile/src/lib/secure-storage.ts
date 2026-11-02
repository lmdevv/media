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
  } catch {}
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
