import { Schema } from "effect";

/**
 * The keychain refused a write that sign-in's safety depends on, such as while the device is
 * locked. Nothing was kept, in the keychain or in memory.
 */
export class KeychainWriteFailed extends Schema.TaggedError<KeychainWriteFailed>()(
  "KeychainWriteFailed",
  { key: Schema.String, message: Schema.String },
) {}

/**
 * One group of keychain items, read and written synchronously. An app has two (D48): its own,
 * which only it reads, and the phone's shared access group, which every [media] app under the same
 * Team ID reads.
 */
export interface Keychain {
  /** The value at `key`, or null when it is unset, cleared, or the keychain cannot be read. */
  readonly read: (key: string) => string | null;
  /**
   * Writes `key`, or clears it with null, for a record whose loss is harmless: the server's
   * connection and the app's local preferences, which the person can set again. A keychain that
   * refuses the write keeps the value for this launch only.
   */
  readonly write: (key: string, value: string | null) => void;
  /**
   * Writes `key`, or clears it with null, for a record sign-in's safety depends on: the D59 mark,
   * the person, and the phone's grant. Throws `KeychainWriteFailed` when the keychain refuses it,
   * and keeps nothing in memory, so a later launch never reads a value that was never stored.
   */
  readonly writeDurably: (key: string, value: string | null) => void;
}

/** A keychain that lives in memory, for tests and for a phone whose keychain is unavailable. */
export const memoryKeychain = (): Keychain => {
  const values = new Map<string, string>();

  const write = (key: string, value: string | null): void => {
    if (value === null) values.delete(key);
    else values.set(key, value);
  };

  return { read: (key) => values.get(key) ?? null, write, writeDurably: write };
};
