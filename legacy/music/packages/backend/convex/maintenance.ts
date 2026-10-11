import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { DEVICE_ONLINE_MS } from "./lib/present";

const PURGE_BATCH = 200;

/** Deletes a removed library's index in batches, rescheduling until it is gone. */
export const purgeLibrary = internalMutation({
  args: { libraryId: v.id("libraries") },
  handler: async (ctx, { libraryId }) => {
    const tracks = await ctx.db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .take(PURGE_BATCH);

    await Promise.all(tracks.map((track) => ctx.db.delete(track._id)));

    if (tracks.length === PURGE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, { libraryId });

      return;
    }

    const albums = await ctx.db
      .query("albums")
      .withIndex("by_library_artist_key", (q) => q.eq("libraryId", libraryId))
      .collect();

    await Promise.all(albums.map((album) => ctx.db.delete(album._id)));

    const artists = await ctx.db
      .query("artists")
      .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId))
      .collect();

    await Promise.all(artists.map((artist) => ctx.db.delete(artist._id)));
  },
});

/** Returns running jobs whose worker stopped renewing the lease to the pending queue. */
export const releaseExpiredLeases = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const running = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    const expired = running.filter((job) => job.leaseUntil !== undefined && job.leaseUntil < now);

    await Promise.all(
      expired.map((job) =>
        ctx.db.patch(job._id, {
          status: "pending",
          workerId: undefined,
          leaseUntil: undefined,
          message: "Worker stopped responding; retrying",
        }),
      ),
    );
  },
});

/**
 * Pauses sessions whose active device stopped sending heartbeats, at the position it last
 * reported, and clears that device, so no client shows music playing on a device that went away.
 */
export const pauseOrphanedSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const sessions = await ctx.db.query("playbackSessions").collect();
    const playing = sessions.filter((session) => session.playing);

    const lastSeen = await Promise.all(
      playing.map(async (session) => {
        const device = await ctx.db
          .query("devices")
          .withIndex("by_user_device", (q) =>
            q.eq("userId", session.userId).eq("deviceId", session.activeDeviceId ?? ""),
          )
          .unique();

        return device?.lastSeenAt ?? null;
      }),
    );

    const orphaned = playing.flatMap((session, index) => {
      const seenAt = lastSeen[index] ?? null;

      return seenAt !== null && now - seenAt < DEVICE_ONLINE_MS
        ? []
        : [{ session, silentSince: seenAt ?? session.updatedAt }];
    });

    await Promise.all(
      orphaned.map(({ session, silentSince }) =>
        ctx.db.patch(session._id, {
          playing: false,
          positionMs: session.positionMs + Math.max(0, silentSince - session.updatedAt),
          updatedAt: now,
          // Clear the gone device so clients stop showing "Playing on" it; the next play picks
          // an online player.
          activeDeviceId: undefined,
        }),
      ),
    );
  },
});
