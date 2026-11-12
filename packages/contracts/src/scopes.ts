/**
 * Roles and scopes. A Convex Auth user is an account with one role. Every session carries scopes:
 * a password session holds everything its role allows; an API key or device session holds the
 * scopes chosen when it was created, intersected with what the role allows now.
 */
import { Schema } from "effect";

/** An account's role. `service` is the media service's system account and never signs in with a password. */
export const Role = Schema.Literals(["owner", "admin", "member", "service"]);

/** An account's role. */
export type Role = typeof Role.Type;

/** Roles an admin can assign through invites and role changes. */
export const AssignableRole = Role.pick(["admin", "member"]);

/** A role an admin can assign. */
export type AssignableRole = typeof AssignableRole.Type;

/**
 * What a session may do.
 *
 * - `read`: browse, search, history, and room state.
 * - `play`: playback sessions, progress, my list, and rooms.
 * - `account`: the account's own profiles, PINs, API keys, device approvals, and sessions.
 * - `manage`: libraries, scans, and metadata fixes. Admin role required.
 * - `admin`: users, invites, other people's keys, backups, restore, and migration. Admin role required.
 * - `media-service`: the media service's functions and nothing else.
 */
export const Scope = Schema.Literals([
  "read",
  "play",
  "account",
  "manage",
  "admin",
  "media-service",
]);

/** A session scope. */
export type Scope = typeof Scope.Type;

/** Scopes an API key may carry. Keys never manage credentials and never act as the media service. */
export const ApiKeyScope = Scope.pick(["read", "play", "manage", "admin"]);

/** A scope an API key may carry. */
export type ApiKeyScope = typeof ApiKeyScope.Type;

/**
 * Who may call a command: anyone (`public`), any signed-in session (`authenticated`), or sessions
 * holding one scope.
 */
export const CommandAccess = Schema.Union([Scope, Schema.Literals(["public", "authenticated"])]);

/** Who may call a command. */
export type CommandAccess = typeof CommandAccess.Type;
