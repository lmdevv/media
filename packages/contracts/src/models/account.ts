import { Schema } from "effect";

import { ApiKeyId, AuthSessionId, InviteId, UserId } from "../ids";
import { ApiKeyScope, AssignableRole, Role, Scope } from "../scopes";
import { EpochMillis } from "../units";

/** Shortest password the server accepts for a sign-up or a password change. */
export const PASSWORD_MIN_LENGTH = 8;

/** An account as other people and admins see it. */
export const User = Schema.Struct({
  id: UserId,
  email: Schema.NullOr(Schema.String),
  name: Schema.String,
  role: Role,
  disabled: Schema.Boolean,
  createdAt: EpochMillis,
});

/** An account. */
export interface User extends Schema.Schema.Type<typeof User> {}

/** How a session signed in. `password` sessions hold every scope their role allows. */
const SessionKind = Schema.Literals(["password", "apikey", "device"]);

/** How a session signed in. */
type SessionKind = typeof SessionKind.Type;

/** A signed-in browser, CLI, TV, or API key, as listed under the account's sessions. */
export const SessionInfo = Schema.Struct({
  id: AuthSessionId,
  kind: SessionKind,
  /** The key name or the device's client name; null for password sessions. */
  label: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Scope),
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
  current: Schema.Boolean,
});

/** A signed-in session. */
export interface SessionInfo extends Schema.Schema.Type<typeof SessionInfo> {}

/** Lifecycle of an invite. */
export const InviteState = Schema.Literals(["open", "used", "expired", "revoked"]);

/** Lifecycle of an invite. */
export type InviteState = typeof InviteState.Type;

/** An invite as admins see it. The code itself is shown only once, when it is created. */
export const Invite = Schema.Struct({
  id: InviteId,
  email: Schema.NullOr(Schema.String),
  role: AssignableRole,
  state: InviteState,
  createdBy: UserId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
});

/** An invite. */
export interface Invite extends Schema.Schema.Type<typeof Invite> {}

/** An API key as its owner sees it. */
export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  userId: UserId,
  name: Schema.String,
  /** The first characters of the key, enough to recognize it. */
  prefix: Schema.String,
  scopes: Schema.Array(ApiKeyScope),
  createdAt: EpochMillis,
  lastUsedAt: Schema.NullOr(EpochMillis),
  expiresAt: Schema.NullOr(EpochMillis),
  revokedAt: Schema.NullOr(EpochMillis),
});

/** An API key. */
export interface ApiKey extends Schema.Schema.Type<typeof ApiKey> {}
