import { appKeychains } from "./keychains";

/**
 * Reads this app's own local preference `key`, such as the download quality, from its private
 * keychain group (D48), or null when it is unset, cleared, or the keychain is unavailable.
 */
export const readValue = (key: string): string | null => appKeychains().own.read(key);

/**
 * Writes this app's own local preference `key`, or clears it with null. A keychain that refuses
 * the write keeps the value for this launch only: losing a preference is harmless.
 */
export const writeValue = (key: string, value: string | null): void => {
  appKeychains().own.write(key, value);
};
