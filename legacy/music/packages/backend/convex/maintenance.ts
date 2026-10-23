import { v } from "convex/values";
import { Match } from "effect";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { deleteEmptyAlbum } from "./lib/catalog";
import { DEVICE_RETAINED_MS } from "./lib/devices";
import { endJam, expiryReason } from "./lib/jams";
import { findSession } from "./lib/playback";
import { DEVICE_ONLINE_MS } from "./lib/present";
import { normaliseStored, rowQueue, saveQueue } from "./lib/queue";
import { inOrder } from "./lib/sequence";

/** Rows one purge run deletes at most, well inside Convex's per-mutation limits. */
const PURGE_BUDGET = 256;

/** Queues one purge run rewrites; each reads up to `MAX_QUEUE` songs. */
const PURGE_QUEUES = 4;

const PRUNE_BATCH = 200;

/** Access grants a removed library's purge deletes per batch. */
const ACCESS_BATCH = 100;

/** A scan whose lease expires this many times in a row before it saves anything fails. */
export const MAX_SCAN_STALLS = 3;

/** Finished jobs, used invites, revoked keys, and expired reset links are kept this long, then deleted. */
export const RECORD_RETAINED_MS = 30 * 24 * 60 * 60 * 1000;

const purgePhase = v.union(
  v.literal("tracks"),
  v.literal("albums"),
  v.literal("artists"),
  v.literal("queues"),
);

type PurgePhase = typeof purgePhase.type;

/** Takes a song out of a playlist's counters, so it stops counting toward the playlist cap. */
const shrinkPlaylist = async (
  ctx: MutationCtx,
  playlistId: Id<"playlists">,
  durationMs: number,
): Promise<void> => {
  const playlist = await ctx.db.get(playlistId);

  if (playlist === null) return;
  await ctx.db.patch(playlist._id, {
    trackCount: Math.max(0, playlist.trackCount - 1),
    durationMs: Math.max(0, playlist.durationMs - durationMs),
  });
};

/**
 * Deletes up to `budget` rows that point at `track`: playlist entries (fixing their playlists'
 * counters), likes, and plays. Returns how many it deleted and whether none are left.
 */
const deleteDependents = async (
  ctx: MutationCtx,
  track: Doc<"tracks">,
  budget: number,
): Promise<{ readonly deleted: number; readonly finished: boolean }> => {
  const items = await ctx.db
    .query("playlistItems")
    .withIndex("by_track", (q) => q.eq("trackId", track._id))
    .take(budget);

  // One after another: two entries in the same playlist update the same counters.
  await inOrder(items, async (item) => {
    await ctx.db.delete(item._id);
    await shrinkPlaylist(ctx, item.playlistId, track.durationMs);
  });

  if (items.length === budget) return { deleted: budget, finished: false };

  const likes = await ctx.db
    .query("likes")
    .withIndex("by_track", (q) => q.eq("trackId", track._id))
    .take(budget - items.length);

  await Promise.all(likes.map((like) => ctx.db.delete(like._id)));

  if (items.length + likes.length === budget) return { deleted: budget, finished: false };

  const plays = await ctx.db
    .query("history")
    .withIndex("by_track", (q) => q.eq("trackId", track._id))
    .take(budget - items.length - likes.length);

  await Promise.all(plays.map((play) => ctx.db.delete(play._id)));
  const deleted = items.length + likes.length + plays.length;

  return { deleted, finished: deleted < budget };
};

/**
 * Deletes songs and everything pointing at them, within the budget. Returns whether the library
 * has no songs left.
 */
const purgeTracks = async (ctx: MutationCtx, libraryId: Id<"libraries">): Promise<boolean> => {
  const tracks = await ctx.db
    .query("tracks")
    .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
    .take(PURGE_BUDGET);

  let budget = PURGE_BUDGET;

  await inOrder(tracks, async (track) => {
    if (budget <= 0) return;
    const { deleted, finished } = await deleteDependents(ctx, track, budget);
    budget -= deleted;

    if (!finished) return;
    await ctx.db.delete(track._id);
    budget -= 1;
  });

  return tracks.length === 0;
};

/** Deletes a batch of a library's albums. Returns whether none are left. */
const purgeAlbums = async (ctx: MutationCtx, libraryId: Id<"libraries">): Promise<boolean> => {
  const albums = await ctx.db
    .query("albums")
    .withIndex("by_library_artist_key", (q) => q.eq("libraryId", libraryId))
    .take(PURGE_BUDGET);

  await Promise.all(albums.map((album) => ctx.db.delete(album._id)));

  return albums.length < PURGE_BUDGET;
};

/** Deletes a batch of a library's artists. Returns whether none are left. */
const purgeArtists = async (ctx: MutationCtx, libraryId: Id<"libraries">): Promise<boolean> => {
  const artists = await ctx.db
    .query("artists")
    .withIndex("by_library_key", (q) => q.eq("libraryId", libraryId))
    .take(PURGE_BUDGET);

  await Promise.all(artists.map((artist) => ctx.db.delete(artist._id)));

  return artists.length < PURGE_BUDGET;
};

/**
 * Drops deleted songs from a batch of queues. Readers already skip them; this keeps stored
 * queues from carrying dead IDs. Returns where the next batch starts, or null when done.
 */
const purgeQueues = async (ctx: MutationCtx, cursor: string | null): Promise<string | null> => {
  const page = await ctx.db.query("playbackQueues").paginate({ cursor, numItems: PURGE_QUEUES });

  await Promise.all(
    page.page.map(async (row) => {
      const stored = rowQueue(row);
      const queue = await normaliseStored(ctx, stored, () => true);

      if (!queue.stale) return;
      await saveQueue(ctx, row.userId, queue);

      // The song playing was deleted: the position belonged to it, so the next song starts over.
      if (queue.items[queue.index]?.id !== stored.items[stored.index]?.id) {
        const session = await findSession(ctx, row.userId);

        // With nothing left to play, playback stops.
        if (session !== null) {
          await ctx.db.patch(session._id, {
            positionMs: 0,
            playing: session.playing && queue.items.length > 0,
            updatedAt: Date.now(),
          });
        }
      }
    }),
  );

  return page.isDone ? null : page.continueCursor;
};

/**
 * Deletes a removed library's catalog and everything pointing into it, in phases of bounded
 * batches, rescheduling itself until it is gone: songs with their playlist entries (fixing the
 * playlists' counters), likes, and plays; then albums; then artists; then deleted songs left in
 * queues.
 */
export const purgeLibrary = internalMutation({
  args: {
    libraryId: v.id("libraries"),
    // Optional so a purge scheduled by an older version, with only the library, still runs.
    phase: v.optional(purgePhase),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { libraryId, phase = "tracks", cursor = null }) => {
    const next = async (nextPhase: PurgePhase, nextCursor: string | null = null) => {
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibrary, {
        libraryId,
        phase: nextPhase,
        cursor: nextCursor,
      });
    };

    switch (phase) {
      case "tracks": {
        await next((await purgeTracks(ctx, libraryId)) ? "albums" : "tracks");

        return;
      }

      case "albums": {
        await next((await purgeAlbums(ctx, libraryId)) ? "artists" : "albums");

        return;
      }

      case "artists": {
        await next((await purgeArtists(ctx, libraryId)) ? "queues" : "artists");

        return;
      }

      case "queues": {
        const after = await purgeQueues(ctx, cursor);

        if (after !== null) await next("queues", after);

        return;
      }
    }
  },
});

/**
 * Deletes a removed library's access grants, a batch at a time, rescheduling until none are
 * left. Anyone can be added to a library, so there may be more than one mutation can delete; the
 * library is already gone, so the grants give nothing meanwhile.
 */
export const purgeLibraryAccess = internalMutation({
  args: { libraryId: v.id("libraries") },
  handler: async (ctx, { libraryId }) => {
    const grants = await ctx.db
      .query("libraryAccess")
      .withIndex("by_library", (q) => q.eq("libraryId", libraryId))
      .take(ACCESS_BATCH);

    await Promise.all(grants.map((grant) => ctx.db.delete(grant._id)));

    if (grants.length === ACCESS_BATCH) {
      await ctx.scheduler.runAfter(0, internal.maintenance.purgeLibraryAccess, { libraryId });
    }
  },
});

/**
 * Returns running jobs whose worker stopped renewing the lease to the pending queue, or fails one
 * whose lease expired `MAX_SCAN_STALLS` times in a row before saving anything: a file that crashes
 * the scanner would otherwise crash it again on every retry, forever. A scan that saves batches
 * between restarts (the service restarted for a deploy) keeps retrying.
 */
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
      expired.map((job) => {
        // `done` counts files this lease saved: claiming resets it, and the scanner adds a batch
        // only once it is written. Files already saved are skipped on the next try. A `total` of
        // 0 (claiming clears it too) means this lease compared every file, found none to read,
        // and marked the missing ones: an unchanged library made all the progress it could.
        const progressed = job.done > 0 || job.total === 0;
        const stalls = progressed ? 0 : (job.stalls ?? 0) + 1;

        return stalls >= MAX_SCAN_STALLS
          ? ctx.db.patch(job._id, {
              status: "failed",
              workerId: undefined,
              leaseUntil: undefined,
              finishedAt: now,
              stalls,
              error: `The scan stopped responding ${MAX_SCAN_STALLS} times without saving anything, so it was stopped. Check the media service log for the file it was reading, then scan again.`,
            })
          : ctx.db.patch(job._id, {
              status: "pending",
              workerId: undefined,
              leaseUntil: undefined,
              stalls,
              message: "Worker stopped responding; retrying",
            });
      }),
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

    const playing = await ctx.db
      .query("playbackSessions")
      .withIndex("by_playing", (q) => q.eq("playing", true))
      .collect();

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

/** Active Jams checked per batch; each run works through all of them, a batch at a time. */
const JAMS_PER_RUN = 100;

/**
 * Ends Jams whose host is gone or offline for 30 minutes, or where nothing has played for four
 * hours (see `expiryReason`). Their people get "The Jam ended" and their own player back.
 */
export const expireJams = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor = null }) => {
    const now = Date.now();

    const page = await ctx.db
      .query("jams")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .paginate({ cursor, numItems: JAMS_PER_RUN });

    await Promise.all(
      page.page.map(async (jam) => {
        const [host, device, session] = await Promise.all([
          ctx.db.get(jam.hostId),
          ctx.db
            .query("devices")
            .withIndex("by_user_last_seen", (q) => q.eq("userId", jam.hostId))
            .order("desc")
            .first(),
          findSession(ctx, jam.hostId),
        ]);

        // A host on the CLI sends no heartbeats; their commands show they are there. The
        // session's update time doesn't count: people in the Jam move it too.
        const lastSeen = Math.max(device?.lastSeenAt ?? 0, jam.hostActiveAt ?? 0);
        const reason = expiryReason(host, lastSeen, session, jam._creationTime, now);

        if (reason !== null) await endJam(ctx, jam, reason);
      }),
    );

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.expireJams, {
        cursor: page.continueCursor,
      });
    }
  },
});

/**
 * Deletes devices silent for longer than `DEVICE_RETAINED_MS`, one batch per run, rescheduling
 * with the batch's cursor until the whole range is read. A session's active device is kept
 * however old, so no session points at a deleted device, and so is a device that keeps downloads,
 * so the CLI and agents can still name it.
 */
export const pruneStaleDevices = internalMutation({
  args: { cutoff: v.optional(v.number()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Continuations reuse the first run's cutoff: the cursor belongs to that query's range.
    const cutoff = args.cutoff ?? Date.now() - DEVICE_RETAINED_MS;

    const batch = await ctx.db
      .query("devices")
      .withIndex("by_last_seen", (q) => q.lt("lastSeenAt", cutoff))
      .paginate({ cursor: args.cursor ?? null, numItems: PRUNE_BATCH });

    const userIds = [...new Set(batch.page.map((device) => device.userId))];
    const sessions = await Promise.all(userIds.map((userId) => findSession(ctx, userId)));

    const active = new Map<Id<"users">, string | undefined>(
      userIds.map((userId, index) => [userId, sessions[index]?.activeDeviceId]),
    );

    await Promise.all(
      batch.page
        .filter((device) => active.get(device.userId) !== device.deviceId)
        .map(async (device) => {
          const pin = await ctx.db
            .query("downloadPins")
            .withIndex("by_user_device", (q) =>
              q.eq("userId", device.userId).eq("deviceId", device.deviceId),
            )
            .first();

          if (pin === null) await ctx.db.delete(device._id);
        }),
    );

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneStaleDevices, {
        cutoff,
        cursor: batch.continueCursor,
      });
    }
  },
});

const recordKind = v.union(
  v.literal("jobs"),
  v.literal("expiredInvites"),
  v.literal("acceptedInvites"),
  v.literal("revokedKeys"),
  v.literal("passwordResets"),
);

type RecordKind = typeof recordKind.type;

const NEXT_KIND: Readonly<Record<RecordKind, RecordKind | null>> = {
  jobs: "expiredInvites",
  expiredInvites: "acceptedInvites",
  acceptedInvites: "revokedKeys",
  revokedKeys: "passwordResets",
  passwordResets: null,
};

/** Deletes up to `PRUNE_BATCH` records of `kind` older than `cutoff`; returns how many. */
const pruneRecords = async (
  ctx: MutationCtx,
  kind: RecordKind,
  cutoff: number,
): Promise<number> => {
  const rows = await Match.value(kind).pipe(
    Match.when("jobs", async () => {
      const finished = await Promise.all(
        (["done", "failed", "cancelled"] as const).map((status) =>
          ctx.db
            .query("jobs")
            .withIndex("by_status_finished", (q) =>
              q.eq("status", status).gte("finishedAt", 0).lt("finishedAt", cutoff),
            )
            .take(PRUNE_BATCH),
        ),
      );

      return finished.flat().slice(0, PRUNE_BATCH);
    }),
    Match.when("expiredInvites", () =>
      ctx.db
        .query("invites")
        .withIndex("by_expires", (q) => q.lt("expiresAt", cutoff))
        .take(PRUNE_BATCH),
    ),
    Match.when("acceptedInvites", () =>
      ctx.db
        .query("invites")
        .withIndex("by_accepted", (q) => q.gte("acceptedAt", 0).lt("acceptedAt", cutoff))
        .take(PRUNE_BATCH),
    ),
    Match.when("revokedKeys", () =>
      ctx.db
        .query("apiKeys")
        .withIndex("by_revoked", (q) => q.gte("revokedAt", 0).lt("revokedAt", cutoff))
        .take(PRUNE_BATCH),
    ),
    // A reset link lasts a day, used or not; it is kept as long as the other records after that.
    Match.when("passwordResets", () =>
      ctx.db
        .query("passwordResets")
        .withIndex("by_expires", (q) => q.lt("expiresAt", cutoff))
        .take(PRUNE_BATCH),
    ),
    Match.exhaustive,
  );

  await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

  return rows.length;
};

/**
 * Deletes jobs that finished, failed, or were cancelled, invites that expired or were accepted,
 * API keys that were revoked, and password reset links that expired, all more than
 * `RECORD_RETAINED_MS` ago, a batch per run. Play history is the user's own record and is kept.
 */
export const pruneOldRecords = internalMutation({
  args: { kind: v.optional(recordKind), cutoff: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const kind = args.kind ?? "jobs";
    // Continuations reuse the first run's cutoff, so the range they finish is the one it started.
    const cutoff = args.cutoff ?? Date.now() - RECORD_RETAINED_MS;
    const deleted = await pruneRecords(ctx, kind, cutoff);
    const next = deleted === PRUNE_BATCH ? kind : NEXT_KIND[kind];

    if (next !== null) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneOldRecords, { kind: next, cutoff });
    }
  },
});

/**
 * Deletes an album without playable songs once no song points at it, and then its artist if
 * nothing points at that either (see `deleteEmptyAlbum`). Scan batches do this themselves now;
 * this runs the ones older versions scheduled.
 */
export const pruneEmptyAlbum = internalMutation({
  args: { albumId: v.id("albums") },
  handler: async (ctx, { albumId }) => {
    await deleteEmptyAlbum(ctx, albumId);
  },
});
