import { Scrypt } from "lucia";

import type { Id } from "../../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../../_generated/server";
import { fail } from "./errors";
import type { RateLimit } from "./rateLimit";

/** The shortest password anyone can set, in characters as {@link checkNewPassword} counts them. */
export const PASSWORD_MIN = 8;

/** The longest password anyone can set, counted like {@link PASSWORD_MIN}. */
export const PASSWORD_MAX = 256;

/**
 * No password is typed longer: NFKC joins at most 4 code points into one, and a code point takes at
 * most 2 UTF-16 units.
 */
const TYPED_MAX = PASSWORD_MAX * 4 * 2;

const SIGN_INS_PER_HOUR = 10;

const scrypt = new Scrypt();

export const signInLimit = (usernameKey: string): RateLimit => ({
  identifier: `password:${usernameKey}`,
  perHour: SIGN_INS_PER_HOUR,
});

/**
 * lucia's Scrypt hashes the NFKC form, so length counts its code points. NFKC can make a string 18
 * times longer, so oversized input is refused before normalizing.
 */
const fitsPassword = (password: string, shortest: number): boolean => {
  if (password.length > TYPED_MAX) return false;

  const length = Array.from(password.normalize("NFKC")).length;

  return length >= shortest && length <= PASSWORD_MAX;
};

/** Refuses a new password that Scrypt would hash as too few or too many characters. */
export const checkNewPassword = (password: string): void => {
  if (!fitsPassword(password, PASSWORD_MIN)) {
    fail("invalid_args", `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for the password`);
  }
};

/** Refuses a typed password longer than any password can be, before it is hashed. */
export const checkTypedPassword = (password: string): void => {
  if (!fitsPassword(password, 0)) {
    fail("invalid_args", `Use at most ${PASSWORD_MAX} characters for the password`);
  }
};

/** Call it from an action: Convex seeds a mutation's randomness, so its salts would be predictable. */
export const hashNewPassword = (password: string): Promise<string> => {
  checkNewPassword(password);

  return scrypt.hash(password);
};

/** Call it from an action, like `hashNewPassword`; an unlock code is stored the way a password is. */
export const hashUnlockCode = (code: string): Promise<string> => scrypt.hash(code);

/** Whether `password`, or an unlock code, matches a Scrypt hash, compared in constant time. */
export const passwordMatches = (hash: string, password: string): Promise<boolean> =>
  scrypt.verify(hash, password);

const passwordRow = (db: DatabaseReader, userId: Id<"users">) =>
  db
    .query("passwords")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

export const passwordHashOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
): Promise<string | undefined> => (await passwordRow(db, userId))?.hash;

export const storePassword = async (
  db: DatabaseWriter,
  userId: Id<"users">,
  hash: string,
): Promise<void> => {
  const row = await passwordRow(db, userId);

  if (row === null) await db.insert("passwords", { userId, hash });
  else await db.patch(row._id, { hash });
};
