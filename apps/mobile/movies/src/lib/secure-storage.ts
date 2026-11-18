import { appKeychains } from "./keychains";

/**
 * Reads `key` from the app's own keychain group, or null when it is unset, cleared, or the
 * keychain is unavailable.
 */
export const readValue = (key: string): string | null => appKeychains().own.read(key);

/**
 * Writes `key` in the app's own keychain group, or clears it with null. A keychain failure keeps
 * the value for this launch only.
 */
export const writeValue = (key: string, value: string | null): void => {
  appKeychains().own.write(key, value);
};
