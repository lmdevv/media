import type { MutationName } from "./registry";

/**
 * Every `playback.*` and `queue.*` mutation: what a player routes to the session it plays.
 * Derived from the registry, so the local session's handler table, a mapped type over it, fails
 * the build until a new one is handled or refused.
 */
export type SessionMutation = Extract<MutationName, `playback.${string}` | `queue.${string}`>;

/** Whether `name` moves the playback session, as {@link SessionMutation} names them. */
export const isSessionMutation = (name: MutationName): name is SessionMutation =>
  name.startsWith("playback.") || name.startsWith("queue.");
