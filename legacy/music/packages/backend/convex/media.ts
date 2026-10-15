/**
 * Functions for the media service. Each takes the shared `MEDIA_SERVICE_SECRET`; none of them
 * decides user access. Convex never calls the media service; the service subscribes here.
 */
import { chainsOverlap, fsPathsOverlap } from "@music/commands/folder-ids";
import { isSystemFolder, SYSTEM_FOLDER_MESSAGE } from "@music/commands/system-folders";
import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { enqueueScan } from "./handlers/admin";
import { markTrackMissing, moveScannedTrack, upsertScannedTrack } from "./lib/catalog";
import { firstOverlap, isClaimed, normaliseLibraryPath } from "./lib/paths";
import { inOrder } from "./lib/sequence";
import { requireService } from "./lib/service";

const LEASE_MS = 60_000;

const FINGERPRINT_PAGE = 1000;

const ART_PAGE = 1000;

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
  folderArt: v.optional(v.string()),
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

/** The message of a refused root claim. It names no folder: the job's viewer may not read the other library. */
const OVERLAP_MESSAGE =
  "This folder is the same as, inside, or around another library's folder (through a link or a " +
  "mount), so it was not scanned. Add a folder that holds only this library's music.";

/**
 * Records the real folder a library's path resolves to, before the media service indexes
 * anything in it, or refuses it. A link or a bind mount can give one folder two names, so the
 * text check when a library is added is not enough: the claim is refused when the real folder
 * equals, contains, or sits inside another library's folder (by either of its names), or lies
 * in /proc, /sys, or /dev. The media service claims at the start of every scan and indexes
 * nothing when refused; a refusal says nothing about the other library.
 */
export const claimRoot = mutation({
  args: {
    secret: v.string(),
    libraryId: v.id("libraries"),
    realPath: v.string(),
    /** The folder's identity and its parents' up to `/`, the folder first (see `folder-ids`). */
    rootIds: v.array(v.string()),
    /** Where the folder is on its file system (see `folder-ids`); null without a mount table. */
    fsPath: v.union(v.string(), v.null()),
    /** The boot those identities were read in (see `schema.ts`); null without one. */
    bootId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { secret, libraryId, realPath, rootIds, fsPath, bootId }) => {
    requireService(secret);
    const library = await ctx.db.get(libraryId);
    const real = normaliseLibraryPath(realPath);

    if (library === null) return { ok: false, error: "The library was removed" } as const;

    if (real === null || isSystemFolder(real)) {
      await unclaim(ctx, library);

      return { ok: false, error: SYSTEM_FOLDER_MESSAGE } as const;
    }

    const overlapping = (await ctx.db.query("libraries").collect()).filter(
      (other) =>
        other._id !== libraryId &&
        (firstOverlap([other], real) !== null ||
          // Identities read in another boot may name other folders now; paths still count.
          ((other.bootId ?? null) === bootId &&
            ((other.rootIds !== undefined && chainsOverlap(other.rootIds, rootIds)) ||
              (fsPath !== null &&
                other.fsPath !== undefined &&
                fsPathsOverlap(other.fsPath, fsPath))))),
    );

    // The library added first keeps a folder two libraries name, whichever scan claims it first:
    // an older library that had no claim yet (from before claims, say) takes its folder back from
    // a newer one on another path to it, such as a bind mount, which stops streaming.
    if (overlapping.some((other) => other._creationTime < library._creationTime)) {
      await unclaim(ctx, library);

      return { ok: false, error: OVERLAP_MESSAGE } as const;
    }

    await Promise.all(overlapping.map(async (other) => unclaim(ctx, other)));

    const stored = { fsPath: fsPath ?? undefined, bootId: bootId ?? undefined };

    if (
      library.realPath !== real ||
      library.rootIds?.join("/") !== rootIds.join("/") ||
      library.fsPath !== stored.fsPath ||
      library.bootId !== stored.bootId
    ) {
      await ctx.db.patch(libraryId, { realPath: real, rootIds: [...rootIds], ...stored });
    }

    return { ok: true } as const;
  },
});

/**
 * Drops a library's claim, so none of its songs stream (`trackSource`, `stream.url`) until a scan
 * claims its folder again. Its songs stay indexed, for when the folder is put right.
 */
const unclaim = async (ctx: MutationCtx, library: Doc<"libraries">): Promise<void> => {
  if (library.realPath !== undefined || library.rootIds !== undefined) {
    await ctx.db.patch(library._id, {
      realPath: undefined,
      rootIds: undefined,
      fsPath: undefined,
      bootId: undefined,
    });
  }
};

/**
 * Records that the media service refused a library's folder before claiming it: outside
 * `MUSIC_ROOTS`, or in /proc, /sys, or /dev. Like a refused claim, it stops the library streaming.
 */
export const refuseRoot = mutation({
  args: { secret: v.string(), libraryId: v.id("libraries") },
  handler: async (ctx, { secret, libraryId }) => {
    requireService(secret);
    const library = await ctx.db.get(libraryId);

    if (library !== null) await unclaim(ctx, library);
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
        folderArt: track.folderArt,
        // What a scan matches a new file against to tell a moved file from a new one.
        durationMs: track.durationMs,
        title: track.title,
        artist: track.artistName,
        album: track.albumTitle,
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

/**
 * Moves tracks whose files a scan found at new paths (renamed, or moved within the library),
 * keeping each track's ID and so its likes, plays, and playlist entries. Keep batches at 100
 * moves or fewer.
 */
export const moveTracks = mutation({
  args: {
    secret: v.string(),
    libraryId: v.id("libraries"),
    moves: v.array(v.object({ from: v.string(), track: scannedTrack })),
  },
  handler: async (ctx, { secret, libraryId, moves }) => {
    requireService(secret);

    if ((await ctx.db.get(libraryId)) === null) return { moved: 0 };
    let moved = 0;

    await inOrder(moves, async ({ from, track }) => {
      if (await moveScannedTrack(ctx, libraryId, from, track)) moved += 1;
    });

    return { moved };
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

/**
 * The artwork hashes one page of tracks, albums, or artists uses, so the media service can
 * delete stored artwork nothing uses any more. Walk each table from a `null` cursor until `done`.
 */
export const artHashes = query({
  args: {
    secret: v.string(),
    table: v.union(v.literal("tracks"), v.literal("albums"), v.literal("artists")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { secret, table, cursor }) => {
    requireService(secret);

    const page = await ctx.db.query(table).paginate({ cursor, numItems: ART_PAGE });
    const hashes = new Set<string>();

    for (const doc of page.page) if (doc.artHash !== undefined) hashes.add(doc.artHash);

    return { hashes: [...hashes], cursor: page.continueCursor, done: page.isDone };
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

    // Nothing streams from a folder no scan has claimed (`claimRoot`): a library refused since it
    // was indexed, or one from before claims whose next scan hasn't run yet.
    if (!isClaimed(library)) return null;

    return {
      path: track.path,
      // The folder the last scan claimed: a link retargeted since must not change what plays.
      libraryPath: library.realPath,
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

    // `claimed` lets the service claim new and upgraded libraries at once, before any scan.
    return all.map((library) => ({
      id: library._id,
      path: library.path,
      claimed: isClaimed(library) && library.rootIds !== undefined,
      bootId: library.bootId ?? null,
    }));
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
