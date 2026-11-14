import { describeFailure, isFailure } from "@media/mobile-core/failure";

const MIN_PASSWORD_LENGTH = 8;

const MAX_PASSWORD_LENGTH = 256;

/** How many code points `text` holds, as the core counts a password's length. */
const codePoints = (text: string): number => {
  let count = 0;

  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);

    // A high surrogate and the low one after it are one code point.
    if (unit < 0xd800 || unit > 0xdbff) count += 1;
  }

  return count;
};

/**
 * Why a new password can't be used, or null when it can. The core counts a password's code points
 * in its NFKC form, 8 to 256 of them (ADR 0006).
 */
export const passwordProblem = (password: string): string | null => {
  const length = codePoints(password.normalize("NFKC"));

  if (length < MIN_PASSWORD_LENGTH)
    return `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;

  return length > MAX_PASSWORD_LENGTH
    ? `Use at most ${String(MAX_PASSWORD_LENGTH)} characters.`
    : null;
};

/** The line under an account form for a refusal; a taken username says so. */
export const accountFailureLine = (cause: unknown): string =>
  isFailure(cause, "Conflict") ? "That username is taken. Pick another." : describeFailure(cause);
