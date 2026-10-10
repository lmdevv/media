import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./viewer";

/** Longest queue kept in a session; Convex arrays and query reads stay well inside limits. */
export const MAX_QUEUE = 1000;

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
    queue: [],
    index: 0,
    positionMs: 0,
    playing: false,
    updatedAt: Date.now(),
    shuffle: false,
    repeat: "off",
    volume: 1,
  });

  const created = await ctx.db.get(id);

  if (created === null) throw new Error("Session vanished right after insert");

  return created;
};

/** Where playback is now, given the last report. */
export const livePosition = (session: Doc<"playbackSessions">, now: number): number =>
  session.playing ? session.positionMs + Math.max(0, now - session.updatedAt) : session.positionMs;

/** Fisher-Yates shuffle into a new array. */
export const shuffled = <Item>(items: ReadonlyArray<Item>): Array<Item> => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    const current = result[index];
    const swap = result[other];

    if (current === undefined || swap === undefined) continue;
    result[index] = swap;
    result[other] = current;
  }

  return result;
};
