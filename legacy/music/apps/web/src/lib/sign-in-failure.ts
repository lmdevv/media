/**
 * How a wrong email or password reads: Convex Auth's Password provider throws `InvalidAccountId`
 * (no such email) or `InvalidSecret` (wrong password). Refresh-token renewal, rate limits, an
 * expired session, and server faults read differently, so they still count as errors.
 */
const WRONG_CREDENTIALS = /\b(?:InvalidAccountId|InvalidSecret)\b/;

/**
 * Whether a Convex log line or error message reports a wrong email or password. The one rule the
 * Convex logger and the sign-in screen share, so they never disagree (ADS-109).
 */
export const mentionsWrongCredentials = (text: string): boolean => WRONG_CREDENTIALS.test(text);

/** Why a sign-in failed: the credentials, too many attempts, or anything else the server reported. */
export type SignInFailure = "credentials" | "rate-limited" | "server";

/** Convex Auth's rejection after too many failed attempts in a row. */
const TOO_MANY_ATTEMPTS = /\bTooManyFailedAttempts\b/;

/**
 * Classifies a failed `signIn("password", …)`: wrong credentials by
 * {@link mentionsWrongCredentials}, Convex Auth's rate limit, or a server problem.
 */
export const signInFailure = (error: Error): SignInFailure => {
  if (mentionsWrongCredentials(error.message)) return "credentials";

  return TOO_MANY_ATTEMPTS.test(error.message) ? "rate-limited" : "server";
};
