import { fail } from "./errors";

/**
 * Control, private-use, unassigned, and surrogate code points, line and paragraph separators, and
 * the bidirectional controls that reorder what others see. Zero-width joiners stay: emoji
 * sequences and several scripts need them.
 */
const UNPRINTABLE =
  /[\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{M}\u2800]/u;

/**
 * A name other people see, such as a guest's or a Cast receiver's: `typed` in NFKC form and
 * trimmed, or null when it holds an unprintable character or no visible one.
 */
export const printableName = (typed: string): string | null => {
  const name = typed.normalize("NFKC").trim();

  return !UNPRINTABLE.test(name) && VISIBLE.test(name) ? name : null;
};

/** `typed` as a printable name of at most `max` code points, or null. */
export const printableWithin = (typed: string, max: number): string | null => {
  const name = printableName(typed);

  return name !== null && Array.from(name).length <= max ? name : null;
};

/** Most code points in a name a person gives a device, group, library, or key. */
export const GIVEN_NAME_MAX = 64;

/**
 * A device, group, library, or key name, which other people see: printable and at most
 * `GIVEN_NAME_MAX` code points, or `invalid_args` with `refusal`.
 */
export const requireGivenName = (typed: string, refusal: string): string =>
  printableWithin(typed, GIVEN_NAME_MAX) ?? fail("invalid_args", refusal);

/** A device's name, which an app sends at enrollment: `requireGivenName` with the device refusal. */
export const requireDeviceName = (typed: string): string =>
  requireGivenName(typed, `Name the device with 1 to ${GIVEN_NAME_MAX} printable characters`);
