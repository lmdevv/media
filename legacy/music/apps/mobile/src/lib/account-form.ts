/**
 * The rules the account forms share: creating the owner (E04), accepting an invite (E08), and
 * setting a password from a reset link (E09). The server checks them too; these say so before a
 * round trip, and word the server's refusals for the form.
 */
import { commandFailure } from "@music/sdk/errors";
import { mentionsWrongCredentials } from "@music/sdk/sign-in";

const MIN_PASSWORD_LENGTH = 8;

/** Why a new password can't be used, or null when it can. */
export const passwordProblem = (password: string): string | null =>
  password.length < MIN_PASSWORD_LENGTH
    ? `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`
    : null;

/**
 * The line under an account form for a refusal. The server refuses an email that already has an
 * account like a wrong sign-in, without saying which; on a sign-up form that can only mean the
 * email is taken.
 */
export const accountFailureLine = (cause: unknown): string => {
  if (!(cause instanceof Error)) return "Something went wrong. Try again.";

  if (mentionsWrongCredentials(cause.message)) {
    return "That email already has an account here. Sign in instead.";
  }

  return commandFailure(cause)?.message ?? "Something went wrong. Try again.";
};
