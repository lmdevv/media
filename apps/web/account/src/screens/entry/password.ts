/**
 * The core's rule for a new password: 8 to 256 characters, counted as the code points of its NFKC
 * form. The core checks it too; checking here first answers before a round trip.
 */
const PASSWORD_MIN = 8;

const PASSWORD_MAX = 256;

const lengthOf = (password: string): number => Array.from(password.normalize("NFKC")).length;

/** The label-row note for a new password. */
export const PASSWORD_RULE = `${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;

/** Why the core would refuse `password` as a new password, or null when it fits the rule. */
export const passwordProblem = (password: string): string | null => {
  const length = lengthOf(password);

  return length < PASSWORD_MIN || length > PASSWORD_MAX
    ? `Use ${PASSWORD_RULE} for the password.`
    : null;
};

/** The `14 characters` check line under a new password, once it fits the rule. */
export const passwordHint = (password: string): string | undefined =>
  passwordProblem(password) === null ? `${lengthOf(password)} characters` : undefined;
