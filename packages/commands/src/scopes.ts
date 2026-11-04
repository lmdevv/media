/**
 * The scopes a sign-in credential can hold. `account` manages the caller's own sessions, API keys,
 * device sign-ins, password, and username. `admin` manages other people's accounts.
 */
export const credentialScopes = ["account", "admin"] as const;

/**
 * Who may call a command. The generated Convex function checks it on every call: `public` needs no
 * session, `signed-in` needs any live session, and a credential scope needs a live session that
 * holds it.
 */
export const scopes = ["public", "signed-in", ...credentialScopes] as const;

/** A scope a command can require. */
export type Scope = (typeof scopes)[number];

/** The roles an admin can give someone (ADR 0005). */
export const assignableRoles = ["admin", "member"] as const;

/** A user's platform role. The owner is the admin who holds the server; only a handover moves it. */
export const roles = ["owner", ...assignableRoles] as const;
