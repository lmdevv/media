import { register } from "../../../commands/core/auth/sessions";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { fail } from "../lib/errors";
import { PAGE_ROWS_MAX, paginateAtMost } from "../lib/paginate";
import { LIST_CALL_READS } from "../permissions/grants";
import { can, heldScopes } from "../permissions/policy";
import { boundDevice, endSession, endUserSessions, liveWithDevice } from "../sessions";
import { callerUser } from "./caller";
import type { Caller } from "./caller";

/** Convex Auth writes a refresh token as `<refreshTokenId>|<sessionId>`. */
const REFRESH_TOKEN_DIVIDER = "|";

const NO_SESSION = "No such session";

/**
 * What a listed session costs: its row, the device it is bound to, and the grant that names an app
 * on no device yet.
 */
const LIST_ROW_READS = 3;

const LIST_ROWS = Math.floor((PAGE_ROWS_MAX - LIST_CALL_READS) / LIST_ROW_READS);

/** Decides `action` on a session or key `owner` holds; a refusal fails and says why. */
export const requireOwnCredential = (
  caller: Caller,
  action: "list" | "end",
  owner: Id<"users">,
  missing: string,
): void => {
  const decision = can(caller, action, { on: "credential", owner });

  if (decision.allowed) return;

  if (decision.refusal === "hidden") return fail("not_found", missing);

  return fail(
    "forbidden",
    decision.because === "guest"
      ? "A guest has no account to manage"
      : "Only a session with your account's scope can do this",
  );
};

type Listed = Exclude<Doc<"authSessions">, { readonly kind: "apiKey" | "guest" }>;

const listed = (session: Doc<"authSessions">): session is Listed =>
  session.kind !== "apiKey" && session.kind !== "guest";

/** What a session calls itself: its device's name, a device sign-in's name, or its grant's. */
const nameOf = async (
  db: DatabaseReader,
  session: Listed,
  device: Doc<"devices"> | null,
): Promise<string | null> => {
  if (device !== null) return device.name;

  if (session.kind === "deviceCode") return session.clientName;

  if (session.kind === "password" || session.kind === "grant") {
    const grant = session.grant === undefined ? null : await db.get(session.grant);

    return grant?.name ?? null;
  }

  return null;
};

export const { current, list, end, endAll, revoke } = register({
  current: async (ctx, _args, caller) => {
    const [session, user] = await Promise.all([
      ctx.db.get(caller.sessionId),
      ctx.db.get(caller.userId),
    ]);

    const bound = session !== null && "device" in session ? session.device : undefined;

    return {
      userId: caller.userId,
      username: caller.username,
      displayName: user?.kind === "person" ? (user.displayName ?? null) : null,
      role: caller.role,
      sessionId: caller.sessionId,
      kind: caller.sessionKind,
      scopes: caller.scopes,
      // Where the session took a device, and its number there: a later one ends it.
      device:
        bound?.joined === undefined ? null : { deviceId: bound.id, joinSequence: bound.joined },
    };
  },
  /**
   * The caller's live sessions but their API keys', which a key opens again on its next use, so
   * the key list covers them. Ended sessions wait for the purge and are left out, so a page may
   * hold fewer rows than asked.
   */
  list: async (ctx, { paginationOpts }, caller) => {
    requireOwnCredential(caller, "list", caller.userId, NO_SESSION);

    const user = await callerUser(ctx, caller);
    const now = Date.now();

    const page = await paginateAtMost(
      ctx.db,
      {
        table: "authSessions",
        index: "userId",
        range: (q) => q.eq("userId", user._id),
        order: "desc",
      },
      paginationOpts,
      LIST_ROWS,
    );

    const rows = await Promise.all(
      page.page.filter(listed).map(async (session) => {
        const bound = boundDevice(session);
        const device = bound === null ? null : await ctx.db.get(bound.id);

        if (!liveWithDevice(session, user, device, now)) return [];

        return [
          {
            sessionId: session._id,
            kind: session.kind,
            name: await nameOf(ctx.db, session, device),
            device: device === null ? null : { deviceId: device._id, name: device.name },
            scopes: heldScopes(session, user),
            signedInAt: session._creationTime,
            expiresAt: session.expirationTime,
            current: session._id === caller.sessionId,
          },
        ];
      }),
    );

    return { ...page, page: rows.flat() };
  },
  /**
   * Signs out one of the caller's sessions with the session machinery that ends every other one.
   * An app whose own session ends while its device grant stands asks for the password again (D59).
   */
  end: async (ctx, { sessionId }, caller) => {
    const session = (await ctx.db.get(sessionId)) ?? fail("not_found", NO_SESSION);

    requireOwnCredential(caller, "end", session.userId, NO_SESSION);

    await endSession(ctx, sessionId);

    return null;
  },
  endAll: async (ctx, { keepCurrent }, caller) => {
    const user = await ctx.db.get(caller.userId);

    if (user !== null) {
      await endUserSessions(ctx, user, keepCurrent ? caller.sessionId : undefined);
    }

    return null;
  },
  /**
   * The refresh token is the proof: only a token row of that very session ends it, so nobody ends
   * a session whose refresh token they never held. Any token of the session works, a rotated or
   * invalidated one included, because Convex Auth keeps those rows until the session ends. A token
   * whose row is gone names a session that already ended, or one it cannot prove, so there is
   * nothing to end.
   */
  revoke: async (ctx, { refreshToken }) => {
    const [tokenPart, sessionPart] = refreshToken.split(REFRESH_TOKEN_DIVIDER);
    const tokenId = ctx.db.normalizeId("authRefreshTokens", tokenPart ?? "");
    const sessionId = ctx.db.normalizeId("authSessions", sessionPart ?? "");

    if (tokenId === null || sessionId === null) {
      return fail("invalid_args", "That is not a refresh token");
    }

    const token = await ctx.db.get(tokenId);

    if (token?.sessionId === sessionId) await endSession(ctx, sessionId);

    return { confirmed: true as const };
  },
});
