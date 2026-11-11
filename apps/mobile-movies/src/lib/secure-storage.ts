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
