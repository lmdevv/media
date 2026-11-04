import { PASSWORD_MIN_LENGTH } from "@media/contracts/models/account";

/** The `14 characters` check line under a new password, once it is long enough. */
export const passwordHint = (password: string): string | undefined =>
  password.length >= PASSWORD_MIN_LENGTH ? `${password.length} characters` : undefined;
