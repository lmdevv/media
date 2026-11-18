/**
 * Pages of the account client at the origin's root (ADR 0020). They sit outside the movies
 * client's base path, so links to them load the account client rather than route here.
 */

/** The person's own settings: name, password, unlock code, and playback preferences. */
export const ACCOUNT_SETTINGS = "/settings";

/** The admin's libraries, where a library is made. */
export const ACCOUNT_LIBRARIES = "/admin/libraries";
