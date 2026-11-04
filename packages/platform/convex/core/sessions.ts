import type { PaginationResult } from "convex/server";
import { v } from "convex/values";

import { credentialScopes } from "../../commands/scopes";
import type { CredentialScope, Role } from "../../commands/scopes";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { paginate } from "./lib/paginate";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a session lasts, and how long an unused refresh token keeps it alive. */
export const SESSION_MS = 30 * DAY_MS;

/** How long a JWT lasts. */
export const JWT_MS = 10 * 60 * 1000;

const PURGE_BATCH = 100;

/** More refresh tokens than a session can gather: one per JWT lifetime for its whole life. */
const SESSION_REFRESH_TOKENS_MAX = Math.ceil(SESSION_MS / JWT_MS) + 500;

const KEY_SESSIONS_MAX = 100;

type Session = Doc<"authSessions">;

/** How a session signed in. */
export type SessionKind = Session["kind"];

/** A session a provider opened, which Convex Auth mints tokens for. */
export interface SignedIn {
  readonly userId: Id<"users">;
  readonly sessionId: Id<"authSessions">;
}

export const signedIn = v.object({ userId: v.id("users"), sessionId: v.id("authSessions") });

/** What opens a session. */
export type Opening =
  | { readonly kind: "password" }
  | { readonly kind: "apiKey"; readonly key: Doc<"apiKeys"> }
  | {
      readonly kind: "deviceCode";
      readonly code: Extract<Doc<"deviceCodes">, { readonly state: "approved" }>;
    };

const currentGeneration = (kind: SessionKind, user: Doc<"users">): number =>
  kind === "apiKey" ? user.keyGeneration : user.sessionGeneration;

const isLive = (session: Session, user: Doc<"users">, now: number): boolean =>
  session.userId === user._id &&
  session.expirationTime > now &&
  session.generation === currentGeneration(session.kind, user);

const roleScopes = {
  owner: credentialScopes,
  admin: credentialScopes,
  member: ["account"],
} as const satisfies { readonly [R in Role]: ReadonlyArray<CredentialScope> };

export const roleHolds = (role: Role, scope: CredentialScope): boolean =>
  roleScopes[role].some((held) => held === scope);

export const heldScopes = (session: Session, user: Doc<"users">): Array<CredentialScope> =>
  session.kind === "password"
    ? [...roleScopes[user.role]]
    : session.scopes.filter((scope) => roleHolds(user.role, scope));

/** A session and its user when the session is live, or null. */
export const liveSession = async (
  db: DatabaseReader,
  sessionId: Id<"authSessions">,
  now: number,
): Promise<{ readonly session: Session; readonly user: Doc<"users"> } | null> => {
  const session = await db.get(sessionId);
  const user = session === null ? null : await db.get(session.userId);

  return session === null || user === null || !isLive(session, user, now)
    ? null
    : { session, user };
};

/** Whether a key still signs in: not ended by a key cut and not expired. */
export const keyWorks = (key: Doc<"apiKeys">, user: Doc<"users">, now: number): boolean =>
  key.generation === user.keyGeneration && (key.expiresAt === undefined || key.expiresAt > now);

const keySessions = (db: DatabaseReader, keyId: Id<"apiKeys">) =>
  db.query("authSessions").withIndex("by_key", (q) => q.eq("keyId", keyId));

const endKeySessionsBeyondNewest = async (
  ctx: Pick<MutationCtx, "db">,
  keyId: Id<"apiKeys">,
): Promise<void> => {
  const newest = await keySessions(ctx.db, keyId)
    .order("desc")
    .take(KEY_SESSIONS_MAX + 1);

  await Promise.all(newest.slice(KEY_SESSIONS_MAX).map((oldest) => endSession(ctx, oldest._id)));
};

/** Opens a session for `user`, stamped with the generation of what opened it. */
export const openSession = async (
  ctx: Pick<MutationCtx, "db">,
  user: Doc<"users">,
  opening: Opening,
  now: number,
): Promise<Id<"authSessions">> => {
  const fields = { userId: user._id, expirationTime: now + SESSION_MS };

  if (opening.kind === "password") {
    return ctx.db.insert("authSessions", {
      ...fields,
      kind: "password",
      generation: user.sessionGeneration,
    });
  }

  if (opening.kind === "apiKey") {
    const sessionId = await ctx.db.insert("authSessions", {
      ...fields,
      kind: "apiKey",
      expirationTime: Math.min(fields.expirationTime, opening.key.expiresAt ?? Infinity),
      generation: opening.key.generation,
      keyId: opening.key._id,
      scopes: opening.key.scopes,
    });

    await endKeySessionsBeyondNewest(ctx, opening.key._id);

    return sessionId;
  }

  return ctx.db.insert("authSessions", {
    ...fields,
    kind: "deviceCode",
    generation: opening.code.generation,
    scopes: opening.code.scopes,
    clientName: opening.code.clientName,
  });
};

const schedulePurge = async (
  ctx: Pick<MutationCtx, "scheduler">,
  userId: Id<"users">,
  table: "authSessions" | "apiKeys",
): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.core.sessions.purge, { userId, table, cursor: null });
};

/** Ends one session and its refresh tokens. */
export const endSession = async (
  ctx: Pick<MutationCtx, "db">,
  sessionId: Id<"authSessions">,
): Promise<void> => {
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .take(SESSION_REFRESH_TOKENS_MAX);

  await Promise.all(refreshTokens.map((token) => ctx.db.delete(token._id)));

  if ((await ctx.db.get(sessionId)) !== null) await ctx.db.delete(sessionId);
};

/**
 * Ends every session a key opened, at once. They are at most `KEY_SESSIONS_MAX` rows, and their
 * refresh tokens are left to expire and be swept, so the call stays inside Convex's write limit.
 */
export const endKeySessions = async (
  ctx: Pick<MutationCtx, "db">,
  keyId: Id<"apiKeys">,
): Promise<void> => {
  const sessions = await keySessions(ctx.db, keyId).collect();

  await Promise.all(sessions.map((session) => ctx.db.delete(session._id)));
};

/** Deletes up to `limit` sessions that expired before `now`, and says how many it deleted. */
export const sweepExpiredSessions = async (
  ctx: Pick<MutationCtx, "db">,
  now: number,
  limit: number,
): Promise<number> => {
  const expired = await ctx.db
    .query("authSessions")
    .withIndex("by_expiration", (q) => q.lt("expirationTime", now))
    .take(limit);

  await Promise.all(expired.map((session) => ctx.db.delete(session._id)));

  return expired.length;
};

/** Ends every password and device session of the user except `keep`. */
export const endUserSessions = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  user: Doc<"users">,
  keep?: Id<"authSessions">,
): Promise<void> => {
  const generation = user.sessionGeneration + 1;

  await ctx.db.patch(user._id, { sessionGeneration: generation });

  const kept = keep === undefined ? null : await ctx.db.get(keep);

  if (kept !== null && kept.userId === user._id && kept.kind !== "apiKey") {
    await ctx.db.patch(kept._id, { generation });
  }

  await schedulePurge(ctx, user._id, "authSessions");
};

/** Ends every API key of the user and the sessions they opened. */
export const endUserKeys = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  user: Doc<"users">,
): Promise<void> => {
  await ctx.db.patch(user._id, { keyGeneration: user.keyGeneration + 1 });
  await schedulePurge(ctx, user._id, "apiKeys");
  await schedulePurge(ctx, user._id, "authSessions");
};

const deleteEnded = async <Row extends Doc<"authSessions"> | Doc<"apiKeys">>(
  ctx: Pick<MutationCtx, "db">,
  page: PaginationResult<Row>,
  ended: (row: Row) => boolean,
): Promise<PaginationResult<Row>> => {
  await Promise.all(page.page.flatMap((row) => (ended(row) ? [ctx.db.delete(row._id)] : [])));

  return page;
};

const purgeArgs = {
  userId: v.id("users"),
  table: v.union(v.literal("authSessions"), v.literal("apiKeys")),
  cursor: v.union(v.string(), v.null()),
};

/** Deletes a user's ended sessions or keys a page at a time, and schedules the next page. */
export const purge = internalMutation({
  args: purgeArgs,
  returns: v.null(),
  handler: async (ctx, { userId, table, cursor }) => {
    const user = await ctx.db.get(userId);

    if (user === null) return null;
    const now = Date.now();
    const options = { numItems: PURGE_BATCH, cursor };

    const page =
      table === "authSessions"
        ? await deleteEnded(
            ctx,
            await paginate(
              ctx.db,
              { table, index: "userId", range: (q) => q.eq("userId", userId) },
              options,
            ),
            (session) => !isLive(session, user, now),
          )
        : await deleteEnded(
            ctx,
            await paginate(
              ctx.db,
              { table, index: "by_user", range: (q) => q.eq("userId", userId) },
              options,
            ),
            (key) => !keyWorks(key, user, now),
          );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.core.sessions.purge, {
        userId,
        table,
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});
