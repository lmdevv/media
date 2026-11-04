import { fail } from "./errors";

const USERNAME = /^[A-Za-z0-9][\w.-]{0,31}$/u;

/** A username as typed and as folded for uniqueness and sign-in: `Alice` and `alice`. */
export interface Username {
  readonly username: string;
  readonly usernameKey: string;
}

/** The username in `typed`, or null when it breaks the rules. */
export const parseUsername = (typed: string): Username | null => {
  const username = typed.trim();

  return USERNAME.test(username) ? { username, usernameKey: username.toLowerCase() } : null;
};

export const requireUsername = (typed: string): Username =>
  parseUsername(typed) ??
  fail(
    "invalid_args",
    "Use 1 to 32 letters, digits, dots, dashes, or underscores, starting with a letter or digit",
  );
