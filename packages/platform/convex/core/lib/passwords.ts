import { Scrypt } from "lucia";

import type { Id } from "../../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../../_generated/server";
import { fail } from "./errors";
import type { RateLimit } from "./rateLimit";

const PASSWORD_MIN = 8;

/** The longest password the core hashes or verifies. */
export const PASSWORD_MAX = 256;

const SIGN_INS_PER_HOUR = 10;

const scrypt = new Scrypt();

/**
 * The sign-in tries a username has: password sign-in and checking a current password take from
 * it, and a reset fills it again.
 */
export const signInLimit = (usernameKey: string): RateLimit => ({
  identifier: `password:${usernameKey}`,
  perHour: SIGN_INS_PER_HOUR,
});

/** Refuses a new password outside the length rules, before any hashing. */
export const checkNewPassword = (password: string): void => {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    fail("invalid_args", `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for the password`);
  }
};

/** The Scrypt hash of a new password that follows the rules. Call it from an action. */
export const hashNewPassword = (password: string): Promise<string> => {
  checkNewPassword(password);

  return scrypt.hash(password);
};

/** Whether `password` matches a stored Scrypt hash. */
export const passwordMatches = (hash: string, password: string): Promise<boolean> =>
  scrypt.verify(hash, password);

const passwordRow = (db: DatabaseReader, userId: Id<"users">) =>
  db
    .query("passwords")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

/** The user's stored password hash, if they have one. */
export const passwordHashOf = async (
  db: DatabaseReader,
  userId: Id<"users">,
): Promise<string | undefined> => (await passwordRow(db, userId))?.hash;

/** Stores the user's password hash, the only write to `passwords`. */
export const storePassword = async (
  db: DatabaseWriter,
  userId: Id<"users">,
  hash: string,
): Promise<void> => {
  const row = await passwordRow(db, userId);

  if (row === null) await db.insert("passwords", { userId, hash });
  else await db.patch(row._id, { hash });
};
