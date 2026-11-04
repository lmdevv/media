/**
 * Who may call a command. The generated Convex function checks it on every call: `public` needs no
 * session, and every other scope needs a signed-in caller.
 */
export const scopes = ["public", "signed-in"] as const;

/** A scope a command can require. */
export type Scope = (typeof scopes)[number];
