import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./viewer";

/** The user's session, if they have played anything yet. */
export const findSession = (
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<Doc<"playbackSessions"> | null> =>
  ctx.db
    .query("playbackSessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

/** Returns the user's session, creating an empty one on first use. */
export const ensureSession = async (
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"playbackSessions">> => {
  const existing = await findSession(ctx, userId);

  if (existing !== null) return existing;

  const id = await ctx.db.insert("playbackSessions", {
    userId,
    positionMs: 0,
    playing: false,
    updatedAt: Date.now(),
    volume: 1,
  });

  const created = await ctx.db.get(id);

  if (created === null) throw new Error("Session vanished right after insert");

  return created;
};

/** Where playback is now, given the last report. */
export const livePosition = (session: Doc<"playbackSessions">, now: number): number =>
  session.playing ? session.positionMs + Math.max(0, now - session.updatedAt) : session.positionMs;
