/**
 * The scopes a sign-in credential can hold. `account` manages the caller's own sessions, API keys,
 * and device sign-ins.
 */
export const credentialScopes = ["account"] as const;

/**
 * Who may call a command. The generated Convex function checks it on every call: `public` needs no
 * session, `signed-in` needs any live session, and a credential scope needs a live session that
 * holds it.
 */
export const scopes = ["public", "signed-in", ...credentialScopes] as const;

/** A scope a command can require. */
export type Scope = (typeof scopes)[number];
