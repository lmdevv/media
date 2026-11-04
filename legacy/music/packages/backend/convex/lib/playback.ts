import { PlaybackControl } from "@music/commands/models";
import { Schema } from "effect";
import { nextPlaybackControl } from "@music/commands/queue-rules";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { ReadCtx } from "./viewer";

/** Atomically orders explicit playback controls ahead of older device measurements. */
export const writePlaybackControl = (
  ctx: MutationCtx,
  session: Doc<"playbackSessions">,
  fields: Partial<
    Pick<
      Doc<"playbackSessions">,
      "positionMs" | "playing" | "updatedAt" | "activeDeviceId" | "movedAt" | "volume"
    >
  >,
  kind: Parameters<typeof nextPlaybackControl>[1],
  after?: Parameters<typeof nextPlaybackControl>[2],
  appliedBy?: Parameters<typeof nextPlaybackControl>[3],
): Promise<PlaybackControl> => {
  const control = nextPlaybackControl(
    session.control === undefined ? undefined : Schema.decodeSync(PlaybackControl)(session.control),
    kind,
    after,
    appliedBy,
  );

  return ctx.db.patch(session._id, { ...fields, control }).then(() => control);
};

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
