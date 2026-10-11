/**
 * Functions for the media service. Each takes the shared `MEDIA_SERVICE_SECRET`; none of them
 * decides user access. Convex never calls the media service; the service subscribes here.
 */
import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { enqueueScan } from "./handlers/admin";
import { markTrackMissing, upsertScannedTrack } from "./lib/catalog";
import { inOrder } from "./lib/sequence";
import { requireService } from "./lib/service";

const LEASE_MS = 60_000;

const FINGERPRINT_PAGE = 1000;

const scannedTrack = v.object({
  path: v.string(),
  size: v.number(),
  mtimeMs: v.number(),
  title: v.string(),
  artist: v.string(),
  albumArtist: v.optional(v.string()),
  album: v.string(),
  trackNumber: v.optional(v.number()),
  discNumber: v.optional(v.number()),
  year: v.optional(v.number()),
  genre: v.optional(v.string()),
  durationMs: v.number(),
  codec: v.string(),
  lossless: v.boolean(),
  bitrate: v.optional(v.number()),
  sampleRate: v.optional(v.number()),
  bitDepth: v.optional(v.number()),
  artHash: v.optional(v.string()),
});

/** Pending jobs, oldest first. The media service subscribes to this. */
export const pendingJobs = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireService(secret);

    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(20);

    return jobs.map((job) => ({ jobId: job._id, kind: job.kind }));
  },
});

/** Claims a pending job with a lease. Returns null when another worker got it first. */
export const claimJob = mutation({
  args: { secret: v.string(), jobId: v.id("jobs"), workerId: v.string() },
  handler: async (ctx, { secret, jobId, workerId }) => {
    requireService(secret);
    const job = await ctx.db.get(jobId);

    if (job === null || job.status !== "pending") return null;
    const library = await ctx.db.get(job.libraryId);
    const now = Date.now();

    if (library === null) {
      await ctx.db.patch(jobId, {
        status: "failed",
        error: "The library was removed",
        finishedAt: now,
      });

      return null;
    }

    await ctx.db.patch(jobId, {
      status: "running",
      workerId,
      leaseUntil: now + LEASE_MS,
      startedAt: job.startedAt ?? now,
      done: 0,
    });

    return {
      jobId,
      kind: job.kind,
      library: { id: library._id, path: library.path, name: library.name },
    };
  },
});

/** Reports progress and renews the lease. `cancelled` tells the worker to stop. */
export const reportJob = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    workerId: v.string(),
    done: v.number(),
    total: v.optional(v.number()),
    message: v.optional(v.string()),
  },
  handler: async (ctx, { secret, jobId, workerId, done, total, message }) => {
    requireService(secret);
    const job = await ctx.db.get(jobId);

    if (job === null || job.status !== "running" || job.workerId !== workerId) {
      return { cancelled: true };
    }

    await ctx.db.patch(jobId, { done, total, message, leaseUntil: Date.now() + LEASE_MS });

    return { cancelled: false };
  },
});

/** Finishes a job the worker holds. */
export const finishJob = mutation({
  args: {
    secret: v.string(),
    jobId: v.id("jobs"),
    workerId: v.string(),
    status: v.union(v.literal("done"), v.literal("failed")),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { secret, jobId, workerId, status, message, error }) => {
    requireService(secret);
    const job = await ctx.db.get(jobId);

    if (job === null || job.status !== "running" || job.workerId !== workerId) return null;
    const now = Date.now();
    await ctx.db.patch(jobId, {
      status,
      message,
      error,
      finishedAt: now,
      leaseUntil: undefined,
    });

    if (status === "done") await ctx.db.patch(job.libraryId, { lastScanAt: now });

    return null;
  },
});

/** Known files in a library, for skipping unchanged files and finding missing ones. */
export const fingerprints = query({
  args: {
    secret: v.string(),
    libraryId: v.id("libraries"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { secret, libraryId, cursor }) => {
    requireService(secret);

    const page = await ctx.db
      .query("tracks")
      .withIndex("by_library_path", (q) => q.eq("libraryId", libraryId))
      .paginate({ cursor, numItems: FINGERPRINT_PAGE });

    return {
      files: page.page.map((track) => ({
        path: track.path,
        size: track.size,
        mtimeMs: track.mtimeMs,
        missing: track.missing,
      })),
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/** Upserts a batch of scanned files. Keep batches at 100 files or fewer. */
export const upsertTracks = mutation({
  args: {
    secret: v.string(),
    libraryId: v.id("libraries"),
    tracks: v.array(scannedTrack),
  },
  handler: async (ctx, { secret, libraryId, tracks }) => {
    requireService(secret);

    if ((await ctx.db.get(libraryId)) === null) return { upserted: 0 };

    await inOrder(tracks, (track) => upsertScannedTrack(ctx, libraryId, track));

    return { upserted: tracks.length };
  },
});

/** Marks files that were not found on disk during a scan. */
export const markMissing = mutation({
  args: { secret: v.string(), libraryId: v.id("libraries"), paths: v.array(v.string()) },
  handler: async (ctx, { secret, libraryId, paths }) => {
    requireService(secret);

    await inOrder(paths, (path) => markTrackMissing(ctx, libraryId, path));

    return { marked: paths.length };
  },
});

/** Resolves a track to its file for streaming. The caller already verified a signed URL. */
export const trackSource = query({
  args: { secret: v.string(), trackId: v.string() },
  handler: async (ctx, { secret, trackId }) => {
    requireService(secret);
    const id = ctx.db.normalizeId("tracks", trackId);

    if (id === null) return null;
    const track = await ctx.db.get(id);

    if (track === null || track.missing) return null;
    const library = await ctx.db.get(track.libraryId);

    if (library === null) return null;

    return {
      path: track.path,
      libraryPath: library.path,
      codec: track.codec,
      lossless: track.lossless,
      size: track.size,
      mtimeMs: track.mtimeMs,
      durationMs: track.durationMs,
    };
  },
});

/** Every library folder, so the service can watch them. Updates live as libraries change. */
export const libraries = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireService(secret);
    const all = await ctx.db.query("libraries").collect();

    return all.map((library) => ({ id: library._id, path: library.path }));
  },
});

/**
 * Enqueues a scan after the service saw files change. Returns the existing pending or running
 * job instead of adding another one, so repeated requests are safe.
 */
export const requestScan = mutation({
  args: { secret: v.string(), libraryId: v.id("libraries") },
  handler: async (ctx, { secret, libraryId }) => {
    requireService(secret);
    const library = await ctx.db.get(libraryId);

    if (library === null) return null;

    return { jobId: await enqueueScan(ctx, library._id, library.ownerId) };
  },
});
