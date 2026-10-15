/**
 * The job lifecycle the media service drives, and the crons that keep the database tidy, against
 * convex-test.
 */
import { DeviceId } from "@music/commands/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { DEVICE_RETAINED_MS } from "../convex/lib/devices";
import { MAX_SCAN_STALLS, RECORD_RETAINED_MS } from "../convex/maintenance";
import {
  MEDIA_SECRET,
  allTracks,
  drainScheduled,
  makeBackend,
  markMissing,
  seedLibrary,
  signUp,
  trackIds,
  upsertFiles,
} from "./backend";
import type { Backend } from "./backend";

const START = 1_800_000_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const WORKER = "worker-1";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

const jobId = async (backend: Backend, id: string): Promise<Id<"jobs">> => {
  const normalised = await backend.run(async (ctx) => ctx.db.normalizeId("jobs", id));

  if (normalised === null) throw new Error(`${id} is not a job`);

  return normalised;
};

const claim = (backend: Backend, job: Id<"jobs">) =>
  backend.mutation(api.media.claimJob, { secret: MEDIA_SECRET, jobId: job, workerId: WORKER });

const finish = (backend: Backend, job: Id<"jobs">) =>
  backend.mutation(api.media.finishJob, {
    secret: MEDIA_SECRET,
    jobId: job,
    workerId: WORKER,
    status: "done",
  });

describe("the scan job lifecycle", () => {
  it("runs from pending to done, reporting progress and recording the scan", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const job = await jobId(backend, created.jobId);

    expect(await backend.query(api.media.pendingJobs, { secret: MEDIA_SECRET })).toEqual([
      { jobId: job, kind: "scan" },
    ]);

    expect((await claim(backend, job))?.library.path).toBe("/music");
    expect(await claim(backend, job)).toBeNull();

    expect(
      await backend.mutation(api.media.reportJob, {
        secret: MEDIA_SECRET,
        jobId: job,
        workerId: WORKER,
        done: 5,
        total: 10,
      }),
    ).toEqual({ cancelled: false });

    expect((await admin.music.read("jobs.get", { jobId: created.jobId })).done).toBe(5);

    await finish(backend, job);
    const [library] = await admin.music.read("libraries.list", {});

    expect((await admin.music.read("jobs.get", { jobId: created.jobId })).status).toBe("done");
    expect(library?.lastScanAt).toBe(START);
  });

  it("tells the worker to stop once the job is cancelled", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const job = await jobId(backend, created.jobId);
    await claim(backend, job);

    await admin.music.run("jobs.cancel", { jobId: created.jobId });

    expect(
      await backend.mutation(api.media.reportJob, {
        secret: MEDIA_SECRET,
        jobId: job,
        workerId: WORKER,
        done: 1,
      }),
    ).toEqual({ cancelled: true });
  });

  it("retries a scan whose worker went silent, and fails it after three tries", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const job = await jobId(backend, created.jobId);

    const crash = async (attempt: number) => {
      vi.setSystemTime(START + attempt * 10 * 60_000);
      expect(await claim(backend, job)).not.toBeNull();
      vi.setSystemTime(START + attempt * 10 * 60_000 + 2 * 60_000);
      await backend.mutation(internal.maintenance.releaseExpiredLeases, {});

      return admin.music.read("jobs.get", { jobId: created.jobId });
    };

    expect((await crash(1)).status).toBe("pending");
    expect((await crash(2)).status).toBe("pending");

    const failed = await crash(MAX_SCAN_STALLS);

    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/stopped responding 3 times/u);
    expect(await backend.query(api.media.pendingJobs, { secret: MEDIA_SECRET })).toEqual([]);
  });

  it("keeps retrying a scan that saves files between restarts, even the same number each time", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const job = await jobId(backend, created.jobId);

    const restart = async (attempt: number) => {
      vi.setSystemTime(START + attempt * 10 * 60_000);
      expect(await claim(backend, job)).not.toBeNull();
      await backend.mutation(api.media.reportJob, {
        secret: MEDIA_SECRET,
        jobId: job,
        workerId: WORKER,
        done: 500,
      });
      vi.setSystemTime(START + attempt * 10 * 60_000 + 2 * 60_000);
      await backend.mutation(internal.maintenance.releaseExpiredLeases, {});

      return (await admin.music.read("jobs.get", { jobId: created.jobId })).status;
    };

    const statuses = await [1, 2, 3, 4, 5].reduce<Promise<ReadonlyArray<string>>>(
      async (previous, attempt) => [...(await previous), await restart(attempt)],
      Promise.resolve([]),
    );

    expect(statuses).toEqual(["pending", "pending", "pending", "pending", "pending"]);
  });

  it("keeps retrying a scan of an unchanged library that restarts after comparing", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const job = await jobId(backend, created.jobId);

    const restart = async (attempt: number, total: number | undefined) => {
      vi.setSystemTime(START + attempt * 10 * 60_000);
      expect(await claim(backend, job)).not.toBeNull();

      // The worker compared every file and found none changed, so it has nothing to save.
      if (total !== undefined) {
        await backend.mutation(api.media.reportJob, {
          secret: MEDIA_SECRET,
          jobId: job,
          workerId: WORKER,
          done: 0,
          total,
        });
      }

      vi.setSystemTime(START + attempt * 10 * 60_000 + 2 * 60_000);
      await backend.mutation(internal.maintenance.releaseExpiredLeases, {});

      return (await admin.music.read("jobs.get", { jobId: created.jobId })).status;
    };

    const unchanged = await [1, 2, 3, 4, 5].reduce<Promise<ReadonlyArray<string>>>(
      async (previous, attempt) => [...(await previous), await restart(attempt, 0)],
      Promise.resolve([]),
    );

    expect(unchanged).toEqual(["pending", "pending", "pending", "pending", "pending"]);

    // A lease that compared nothing does not count the last one's total as its own progress.
    const stalled = await [6, 7, 8].reduce<Promise<ReadonlyArray<string>>>(
      async (previous, attempt) => [...(await previous), await restart(attempt, undefined)],
      Promise.resolve([]),
    );

    expect(stalled).toEqual(["pending", "pending", "failed"]);
  });

  it("deletes albums and artists that no song points at after a scan", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const created = await admin.music.run("libraries.create", { name: "Rock", path: "/music" });
    const { libraryId } = created;

    await upsertFiles(backend, libraryId, [
      { path: "a.flac", album: "Demo", artist: "Early Name" },
      { path: "b.flac", album: "Kept", artist: "Band" },
    ]);

    // A retag moves the song to another album and artist; a deleted file only goes missing.
    await upsertFiles(backend, libraryId, [{ path: "a.flac", album: "Debut", artist: "Band" }]);
    await markMissing(backend, libraryId, ["b.flac"]);

    const job = await jobId(backend, created.jobId);
    await claim(backend, job);
    await finish(backend, job);
    await drainScheduled(backend);

    const left = await backend.run(async (ctx) => ({
      albums: (await ctx.db.query("albums").collect()).map((album) => album.title).toSorted(),
      artists: (await ctx.db.query("artists").collect()).map((artist) => artist.name),
    }));

    expect(left).toEqual({ albums: ["Debut", "Kept"], artists: ["Band"] });
  });
});

describe("pausing sessions on devices that went away", () => {
  it("pauses only playing sessions whose device stopped sending heartbeats", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const listener = await signUp(backend, "member");
    await seedLibrary(backend, admin, { name: "Rock", count: 2 });
    const rock = trackIds(await allTracks(admin), "Rock");
    const gone = DeviceId.make("closed-tab");
    const here = DeviceId.make("open-tab");

    await admin.music.run("devices.heartbeat", { deviceId: gone, name: "Tab", kind: "web" });
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: gone });
    await listener.music.run("devices.heartbeat", { deviceId: here, name: "Tab", kind: "web" });
    await listener.music.run("playback.play", { trackIds: [...rock], deviceId: here });

    vi.setSystemTime(START + 5 * 60_000);
    await listener.music.run("devices.heartbeat", { deviceId: here, name: "Tab", kind: "web" });
    await backend.mutation(internal.maintenance.pauseOrphanedSessions, {});

    const paused = await admin.music.read("playback.position", {});

    expect(paused.playing).toBe(false);
    expect(paused.activeDevice).toBeNull();
    expect((await listener.music.read("playback.position", {})).playing).toBe(true);
  });

  it("reads only the playing sessions", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Rock", count: 1 });

    await backend.run(async (ctx) => {
      await Promise.all(
        Array.from({ length: 100 }, () =>
          ctx.db.insert("playbackSessions", {
            userId: admin.id,
            positionMs: 0,
            playing: false,
            updatedAt: START,
            volume: 1,
          }),
        ),
      );
    });

    const read = await backend.mutation(async (ctx) => {
      const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used;
      await ctx.runMutation(internal.maintenance.pauseOrphanedSessions, {});

      return (await ctx.meta.getTransactionMetrics()).documentsRead.used - before;
    });

    expect(read).toBe(0);
  });
});

describe("daily cleanup", () => {
  it("deletes old finished jobs, used or expired invites, and revoked keys, and keeps history", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");

    const { libraryId: wireLibrary } = await seedLibrary(backend, admin, {
      name: "Rock",
      count: 1,
    });

    const old = START - RECORD_RETAINED_MS - DAY_MS;
    const recent = START - DAY_MS;

    await backend.run(async (ctx) => {
      const libraryId = ctx.db.normalizeId("libraries", wireLibrary);

      if (libraryId === null) throw new Error("Seed missing");

      const job = (status: "done" | "failed" | "cancelled" | "running", finishedAt?: number) =>
        ctx.db.insert("jobs", {
          kind: "scan",
          status,
          libraryId,
          createdBy: admin.id,
          done: 0,
          message: `${status} ${finishedAt === old ? "old" : "recent"}`,
          finishedAt,
        });

      await job("done", old);
      await job("failed", old);
      await job("cancelled", old);
      await job("done", recent);
      await job("running");

      const invite = (code: string, expiresAt: number, acceptedAt?: number) =>
        ctx.db.insert("invites", {
          code,
          role: "member",
          createdBy: admin.id,
          expiresAt,
          revoked: false,
          acceptedAt,
          acceptedBy: acceptedAt === undefined ? undefined : admin.id,
        });

      await invite("expired-long-ago", old);
      await invite("expired-recently", recent);
      await invite("accepted-long-ago", START + DAY_MS, old);
      await invite("open", START + DAY_MS);

      const key = (name: string, revokedAt?: number) =>
        ctx.db.insert("apiKeys", { userId: admin.id, name, prefix: "mk_", hash: name, revokedAt });

      await key("revoked-long-ago", old);
      await key("revoked-recently", recent);
      await key("in-use");

      const track = await ctx.db.query("tracks").first();

      if (track === null) throw new Error("Seed missing");
      await ctx.db.insert("history", {
        userId: admin.id,
        trackId: track._id,
        albumId: track.albumId,
        deviceId: "old-phone",
      });
    });

    await backend.mutation(internal.maintenance.pruneOldRecords, {});
    await drainScheduled(backend);

    const left = await backend.run(async (ctx) => ({
      jobs: (await ctx.db.query("jobs").collect()).map((job) => job.message ?? job.status),
      invites: (await ctx.db.query("invites").collect()).map((invite) => invite.code),
      keys: (await ctx.db.query("apiKeys").collect()).map((key) => key.name),
      history: (await ctx.db.query("history").collect()).length,
    }));

    expect(left.jobs.filter((message) => message.endsWith("old"))).toEqual([]);
    expect(left.jobs).toContain("done recent");
    expect(left.jobs).toContain("running recent");
    expect(left.invites).toEqual(["expired-recently", "open"]);
    expect(left.keys).toEqual(["revoked-recently", "in-use"]);
    expect(left.history).toBe(1);
  });

  it("deletes long-silent devices but keeps the one a session plays on", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Rock", count: 1 });
    const rock = trackIds(await allTracks(admin), "Rock");
    const speaker = DeviceId.make("speaker");
    const tab = DeviceId.make("old-tab");

    await admin.music.run("devices.heartbeat", { deviceId: speaker, name: "Speaker", kind: "web" });
    await admin.music.run("devices.heartbeat", { deviceId: tab, name: "Tab", kind: "web" });
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: speaker });

    vi.setSystemTime(START + DEVICE_RETAINED_MS + DAY_MS);
    await backend.mutation(internal.maintenance.pruneStaleDevices, {});
    await drainScheduled(backend);

    const devices = await backend.run(async (ctx) =>
      (await ctx.db.query("devices").collect()).map((device) => device.deviceId),
    );

    expect(devices).toEqual([speaker]);
  });
});

describe("invites", () => {
  it("lists unused invites, marking the expired ones as expired", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const expiring = await admin.music.run("invites.create", {});

    vi.setSystemTime(START + 3 * DAY_MS);
    const fresh = await admin.music.run("invites.create", {});

    vi.setSystemTime(START + 8 * DAY_MS);
    const listed = await admin.music.read("invites.list", {});

    expect(listed.map((invite) => [invite.id, invite.status])).toEqual([
      [fresh.id, "open"],
      [expiring.id, "expired"],
    ]);
  });
});
