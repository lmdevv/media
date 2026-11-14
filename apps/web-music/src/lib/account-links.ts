/**
 * Pages of the account client at the origin's root (ADR 0020), where old music's account, key,
 * people, library, and job settings moved. They sit outside the music client's base path, so links
 * to them load the account client rather than route here.
 */

/** The person's own settings: name, password, and unlock code. */
export const ACCOUNT_SETTINGS = "/settings";

/** The person's API keys, for the CLI and agents. */
export const ACCOUNT_API_KEYS = "/api-keys";

/** The admin's people and invites. */
export const ACCOUNT_PEOPLE = "/admin";

/** The admin's libraries, where a library is made. */
export const ACCOUNT_LIBRARIES = "/admin/libraries";

/** The admin's jobs: every library's scan. */
export const ACCOUNT_JOBS = "/admin/jobs";
