/**
 * One group of keychain items, read and written synchronously. An app has two (D48): its own,
 * which only it reads, and the phone's shared access group, which every [media] app under the same
 * Team ID reads.
 */
export interface Keychain {
  /** The value at `key`, or null when it is unset, cleared, or the keychain cannot be read. */
  readonly read: (key: string) => string | null;
  /**
   * Writes `key`, or clears it with null. A keychain that refuses the write, as while the device is
   * locked, keeps the value for this launch only.
   */
  readonly write: (key: string, value: string | null) => void;
}

/** A keychain that lives in memory, for tests and for a phone whose keychain is unavailable. */
export const memoryKeychain = (): Keychain => {
  const values = new Map<string, string>();

  return {
    read: (key) => values.get(key) ?? null,
    write: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
};
