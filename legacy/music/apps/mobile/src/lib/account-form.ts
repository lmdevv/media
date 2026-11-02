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
