import { setTimeout as sleep } from "node:timers/promises";

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { insertByHand, patchByHand, runFunction } from "../admin";
import { eventually, retrying } from "../core/jobs/driver";
import { listedJob } from "../core/jobs/listed";
import { member } from "../devices";
import type { Member } from "../devices";
import { runServer } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  JobId,
  Lease,
  LrclibId,
  TrackId,
  claimScan,
  finishScan,
  hasTotals,
  musicLibrary,
  trackIdsAt,
  upsertAll,
} from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";
import type { LyricSet, ScannedTrack } from "./scanned";

const stack = coreStackFromEnvFile();

const Claimed = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("claimed"),
    lease: Lease,
    payload: Schema.Struct({ kind: Schema.String, trackId: Schema.optional(TrackId) }),
  }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const Settled = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    value: Schema.Struct({ saved: Schema.String }),
  }),
  Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
]);

const Lookups = Schema.Array(
  Schema.NullOr(
    Schema.Struct({
      job: Schema.NullOr(
        Schema.Struct({
          jobId: JobId,
          status: Schema.Literals(["queued", "running"]),
          attempts: Schema.Finite,
          strikes: Schema.Finite,
          waitUntil: Schema.NullOr(Schema.Finite),
        }),
      ),
      answer: Schema.NullOr(Schema.Struct({ status: Schema.String, current: Schema.Boolean })),
      rows: Schema.Finite,
    }),
  ),
);

const Kind = Schema.Struct({ held: Schema.Boolean, pausedUntil: Schema.NullOr(Schema.Finite) });

type Result = FunctionArgs<typeof api.music.lyricLookups.settle>["result"];

type Lyrics = FunctionReturnType<typeof api.music.lyrics.get>;

/** Synced main lyrics from an `.lrc` file beside the song, of `lines`. */
const syncedFile = (lines: ReadonlyArray<string>): LyricSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Sidecar", fileName: "song.lrc", format: "lrc" },
  body: {
    _tag: "Synced",
    lines: lines.map((text, index) => ({
      text,
      startMs: index * 1000,
      endMs: null,
      words: null,
      voice: null,
    })),
  },
});

/** LRCLIB's synced lyrics for a song, as the server settles them. */
const found = (recordId: number, text: string): Result => ({
  outcome: "answered",
  answer: {
    status: "found",
    recordId,
    sets: [
      {
        kind: "main",
        lang: null,
        origin: { _tag: "Lrclib", recordId },
        body: {
          _tag: "Synced",
          lines: [{ text, startMs: 1500, endMs: null, words: null, voice: null }],
        },
      },
    ],
  },
});

/** Each track's lookup, read 10 at a time, as a song's answer may be 512 KiB. */
const lookupsOf = async (core: CoreStack, trackIds: ReadonlyArray<Id<"tracks">>) => {
  const chunks = Array.from({ length: Math.ceil(trackIds.length / 10) }, (_, n) =>
    trackIds.slice(n * 10, n * 10 + 10),
  );

  const read = await Promise.all(
    chunks.map((chunk) =>
      runFunction(core, internal.music.probe.lookups, { trackIds: [...chunk] }, Lookups),
    ),
  );

  return read.flat();
};

const lookupOf = async (core: CoreStack, trackId: Id<"tracks">) => {
  const [one] = await lookupsOf(core, [trackId]);

  if (one === undefined || one === null) throw new Error(`No track ${trackId}`);

  return one;
};

const kindOf = (core: CoreStack) => runFunction(core, internal.music.probe.lookupKind, {}, Kind);

const claimOnce = (core: CoreStack, leaseMs = 60_000) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.claim,
      { kinds: ["music.lyrics"], workerId: "lyrics-test", leaseMs },
      Claimed,
    ),
  );

const settle = (core: CoreStack, lease: Lease, result: Result) =>
  retrying(() => runServer(core, api.music.lyricLookups.settle, { lease, result }, Settled));

const Proceeded = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    value: Schema.Struct({ next: Schema.Literals(["ask", "off", "stale"]) }),
  }),
  Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
]);

/** What the server asks right before each LRCLIB request: whether the held lookup may send it. */
const proceed = (core: CoreStack, lease: Lease) =>
  retrying(() => runServer(core, api.music.lyricLookups.proceed, { lease }, Proceeded));

const nextIs = (next: "ask" | "off" | "stale") => ({ outcome: "held", value: { next } });

/** Requests lookups of `trackIds` as a song starting or a download does. */
const requestLookups = (core: CoreStack, trackIds: ReadonlyArray<Id<"tracks">>) =>
  runFunction(
    core,
    internal.music.lyricLookups.requestTracks,
    { trackIds: [...trackIds] },
    Schema.Null,
  );

/** The statuses of a track's lookup jobs, gone tracks' included. */
const statusesOf = (core: CoreStack, trackId: Id<"tracks">) =>
  runFunction(core, internal.music.probe.lookupStatuses, { trackId }, Schema.Array(Schema.String));

/**
 * Claims the lookup of `trackId` as the stack's media server. A lookup of another track claimed
 * first, left by an earlier test or run, is settled as a miss, which frees the kind's one slot.
 */
const claimLookup = async (
  core: CoreStack,
  trackId: Id<"tracks">,
  leaseMs = 60_000,
  deadline = Date.now() + 60_000,
): Promise<Lease> => {
  const claim = await claimOnce(core, leaseMs);

  if (claim.outcome === "claimed" && claim.payload.trackId === trackId) return claim.lease;

  if (Date.now() > deadline) throw new Error(`Timed out claiming the lookup of ${trackId}`);

  if (claim.outcome === "claimed") {
    await settle(core, claim.lease, { outcome: "answered", answer: { status: "miss" } });
  } else {
    await sleep(200);
  }

  return claimLookup(core, trackId, leaseMs, deadline);
};

/**
 * Settles lookups that other tests or runs left queued ahead of `trackIds`' until each of
 * `trackIds` has one queued or running. Answers the leases of any of theirs it claimed meanwhile.
 */
const drainUntilQueued = async (
  core: CoreStack,
  trackIds: ReadonlyArray<Id<"tracks">>,
  held: ReadonlyMap<Id<"tracks">, Lease> = new Map(),
  deadline = Date.now() + 60_000,
): Promise<ReadonlyMap<Id<"tracks">, Lease>> => {
  const states = await lookupsOf(core, trackIds);

  if (states.every((one) => one?.job !== null)) return held;

  if (Date.now() > deadline) throw new Error("Timed out waiting for the lookups");

  const claim = await claimOnce(core);
  const claimedId = claim.outcome === "claimed" ? claim.payload.trackId : undefined;
  const mine = trackIds.find((trackId) => trackId === claimedId);

  if (claim.outcome === "claimed" && mine !== undefined) {
    return drainUntilQueued(core, trackIds, new Map([...held, [mine, claim.lease]]), deadline);
  }

  if (claim.outcome === "claimed") {
    await settle(core, claim.lease, { outcome: "answered", answer: { status: "miss" } });
  } else {
    await sleep(250);
  }

  return drainUntilQueued(core, trackIds, held, deadline);
};

/**
 * Works the lookup queue as the server would, every lookup a miss, until each of `trackIds` has a
 * current answer. Answers how many do, and the most of their lookups seen waiting at once.
 */
const workUntilAnswered = async (
  core: CoreStack,
  trackIds: ReadonlyArray<Id<"tracks">>,
  rounds = 0,
  mostQueued = 0,
): Promise<{ readonly answered: number; readonly mostQueued: number }> => {
  const states = await lookupsOf(core, trackIds);
  const queuedNow = states.filter((one) => one?.job?.status === "queued").length;
  const most = Math.max(mostQueued, queuedNow);
  const answered = states.filter((one) => one?.answer?.current === true).length;

  if (answered === trackIds.length || rounds >= 2000) return { answered, mostQueued: most };

  const claim = await claimOnce(core);

  if (claim.outcome === "claimed") {
    await settle(core, claim.lease, { outcome: "answered", answer: { status: "miss" } });
  } else {
    await sleep(250);
  }

  return workUntilAnswered(core, trackIds, rounds + 1, most);
};

/** Settles every lookup left waiting as a miss, until a claim finds none. */
const drainAll = async (core: CoreStack): Promise<void> => {
  const claim = await claimOnce(core);

  if (claim.outcome === "idle") return;

  await settle(core, claim.lease, { outcome: "answered", answer: { status: "miss" } });

  return drainAll(core);
};

/** Claims every lookup left waiting, settling each as a miss, and answers whose they were. */
const claimedUntilIdle = async (
  core: CoreStack,
  claimed: ReadonlyArray<Id<"tracks"> | undefined> = [],
): Promise<ReadonlyArray<Id<"tracks"> | undefined>> => {
  const claim = await claimOnce(core);

  if (claim.outcome === "idle") return claimed;

  await settle(core, claim.lease, { outcome: "answered", answer: { status: "miss" } });

  return claimedUntilIdle(core, [...claimed, claim.payload.trackId]);
};

/** A music library of `admin`'s holding `tracks`, scanned, and the tracks' ids in order. */
const library = async (
  core: CoreStack,
  admin: Member,
  name: string,
  tracks: (root: string) => ReadonlyArray<ScannedTrack>,
) => {
  const made = await musicLibrary(admin, name);
  const [root] = made.roots;

  if (root === undefined) throw new Error("the library has no folder");

  const lease = await claimScan(core, made.scanJobId);
  const scanned = tracks(root);

  await upsertAll(core, lease, scanned);
  await finishScan(core, lease);

  const ids = await trackIdsAt(
    core,
    made.libraryId,
    scanned.map((track) => track.path),
  );

  return {
    ...made,
    root,
    ids: ids.map((id) => {
      if (id === null) throw new Error("a scanned track has no row");

      return id;
    }),
  };
};

/** A song LRCLIB can match: a title, an artist, and a whole second of audio or more. */
const song = (root: string, title: string, fields: Partial<ScannedTrack> = {}) =>
  musicTrack(`${root}/Album/${title}.flac`, 1000, 0, {
    title,
    artist: "Lyrics Artist",
    album: "Album",
    durationMs: 200_000,
    ...fields,
  });

/** An answer for tags a song no longer has, about 480 KiB: 40 of them pass 16 MiB. */
const staleDenseAnswer = (trackId: Id<"tracks">) => ({
  trackId,
  revision: "older tags",
  checkedAt: Date.now(),
  answer: {
    status: "found" as const,
    recordId: 1,
    sets: [
      {
        kind: "main" as const,
        lang: null,
        origin: { _tag: "Lrclib" as const, recordId: 1 },
        body: { _tag: "Plain" as const, text: "la ".repeat(160 * 1024) },
      },
    ],
  },
});

const lyricsAs = (who: Member, trackId: Id<"tracks">): Promise<Lyrics> =>
  who.signedIn.client.query(api.music.lyrics.get, { trackId });

const turn = (who: Member, remote: boolean) =>
  who.signedIn.client.mutation(api.music.lyrics.configure, { remote });

describe.skipIf(stack === undefined)("music lyrics lookups", { timeout: 180_000 }, () => {
  if (stack === undefined) return;
  const core = stack;
  const admin = member(core, "lyrics-admin", "admin");

  afterAll(async () => {
    await turn(await admin, true);
  });

  it("queue a backfill's lookups only for songs that need one, and refuse a member", async () => {
    const owner = await admin;
    const somebody = await member(core, "lyrics-member");

    const { ids, libraryId } = await library(core, owner, "Backfill", (root) => [
      song(root, "Bare"),
      song(root, "Own plain", { lyrics: [plainLyrics("own words")] }),
      song(root, "Own synced", { lyrics: [syncedFile(["own line"])] }),
      song(root, "No artist", { artist: "Unknown Artist" }),
    ]);

    const [bare, plain, synced, noArtist] = ids;

    expect(await refusal(somebody.signedIn.client.mutation(api.music.lyrics.backfill, {}))).toBe(
      "forbidden",
    );

    const { libraries } = await owner.signedIn.client.mutation(api.music.lyrics.backfill, {});

    expect(libraries).toBeGreaterThanOrEqual(1);

    const held = await drainUntilQueued(core, [bare ?? never(), plain ?? never()]);
    const queued = await lookupsOf(core, ids);

    expect(queued.map((one) => one?.job !== null)).toEqual([true, true, false, false]);
    expect(await hasTotals(core, libraryId)).toBe(true);

    // While pending, a song with plain lyrics of its own shows them as the fallback.
    expect(await lyricsAs(owner, plain ?? never())).toMatchObject({
      status: "pending",
      fallback: { origin: { type: "sidecar" }, body: { type: "plain", text: "own words" } },
    });
    expect(await lyricsAs(owner, bare ?? never())).toEqual({ status: "pending", fallback: null });
    expect(await lyricsAs(owner, noArtist ?? never())).toEqual({ status: "none" });

    // The backfill queued them in path order, so the bare song's lookup runs first.
    const bareLease = held.get(bare ?? never()) ?? (await claimLookup(core, bare ?? never()));

    await settle(core, bareLease, {
      outcome: "answered",
      answer: { status: "instrumental", recordId: 7 },
    });
    expect(await lyricsAs(owner, bare ?? never())).toEqual({ status: "instrumental" });

    // LRCLIB's synced lyrics beat a song's own plain lyrics, as in old music.
    const lease = held.get(plain ?? never()) ?? (await claimLookup(core, plain ?? never()));

    expect(await settle(core, lease, found(41, "from LRCLIB"))).toEqual({
      outcome: "held",
      value: { saved: "found" },
    });
    expect(await lyricsAs(owner, plain ?? never())).toMatchObject({
      status: "synced",
      source: "lrclib",
      main: { origin: { type: "lrclib", recordId: 41 }, body: { type: "synced" } },
    });

    // A song's own synced lyrics win over a remote answer, however it got there.
    await insertByHand(core, "lrclibLyrics", [
      {
        trackId: synced ?? never(),
        revision: "any",
        checkedAt: Date.now(),
        answer: { status: "instrumental", recordId: 9 },
      },
    ]);
    expect(await lyricsAs(owner, synced ?? never())).toMatchObject({
      status: "synced",
      source: "file",
      main: { body: { type: "synced", lines: [{ text: "own line" }] } },
    });
  });

  it("go on listing an admin's libraries in later steps and backfill each found", async () => {
    const owner = await admin;
    const { ids } = await library(core, owner, "Found later", (root) => [song(root, "Late find")]);

    // The step a backfill schedules when one call could not list every library: from the start
    // here, it finds this admin's libraries, the new one among them, and backfills them.
    await runFunction(
      core,
      internal.music.lyricLookups.discover,
      { userId: owner.userId, cursor: null },
      Schema.Null,
    );

    const trackId = ids[0] ?? never();
    const held = await drainUntilQueued(core, ids);
    const lease = held.get(trackId) ?? (await claimLookup(core, trackId));

    expect(await settle(core, lease, found(4, "found later"))).toEqual({
      outcome: "held",
      value: { saved: "found" },
    });
  });

  it("pause every lookup for LRCLIB's pause, then let them run again", async () => {
    const owner = await admin;
    const { ids } = await library(core, owner, "Pause", (root) => [song(root, "Paused")]);
    const [paused] = ids;

    await owner.signedIn.client.mutation(api.music.play.start, { trackId: paused ?? never() });

    await eventually("the play's lookup", async () =>
      (await lookupOf(core, paused ?? never())).job === null ? null : true,
    );

    const lease = await claimLookup(core, paused ?? never());
    const pauseMs = 3000;

    expect(
      await settle(core, lease, { outcome: "unavailable", error: "LRCLIB: 429", pauseMs }),
    ).toEqual({ outcome: "held", value: { saved: "retrying" } });

    const during = await lookupOf(core, paused ?? never());

    expect(during.job).toMatchObject({ status: "queued", attempts: 1, strikes: 0 });
    expect((await kindOf(core)).pausedUntil).toBeGreaterThan(Date.now());
    expect(await claimOnce(core)).toEqual({ outcome: "idle" });
    expect(
      await runServer(
        core,
        api.core.jobs.worker.waiting,
        { kinds: ["music.lyrics"] },
        Schema.Array(Schema.Struct({ ready: Schema.Boolean })),
      ),
    ).toMatchObject([{ ready: false }]);

    await eventually(
      "the pause to end",
      async () => ((await kindOf(core)).pausedUntil === null ? true : null),
      pauseMs + 10_000,
    );

    const again = await claimLookup(core, paused ?? never());

    expect(again.attempt).toBe(2);
    await settle(core, again, found(5, "after the pause"));
    expect(await lookupOf(core, paused ?? never())).toMatchObject({
      job: null,
      answer: { status: "found", current: true },
    });
  });

  it("wait between failed tries, and store a miss after the fifth", async () => {
    const owner = await admin;
    const { ids } = await library(core, owner, "Retry", (root) => [song(root, "Broken record")]);
    const [broken] = ids;
    const trackId = broken ?? never();

    await runFunction(
      core,
      internal.music.lyricLookups.requestTracks,
      { trackIds: [trackId] },
      Schema.Null,
    );

    // Four tries fail and wait; each wait is a minute or more, so the test brings it forward and
    // wakes the lookup, as the core will when its time comes.
    const failTry = async (strike: number): Promise<void> => {
      const lease = await claimLookup(core, trackId);

      expect(await settle(core, lease, { outcome: "failed", error: "unreadable" })).toEqual({
        outcome: "held",
        value: { saved: "retrying" },
      });

      const waiting = await lookupOf(core, trackId);

      expect(waiting.job).toMatchObject({ status: "queued", strikes: strike });
      expect(waiting.job?.waitUntil ?? 0).toBeGreaterThan(Date.now());

      const jobId = waiting.job?.jobId ?? never();

      await patchByHand(core, "jobs", [jobId], { waitUntil: Date.now() - 1 });
      await runFunction(
        core,
        internal.core.jobs.leases.wake,
        { jobId, attempt: waiting.job?.attempts ?? 0 },
        Schema.Null,
      );

      if (strike < 4) await failTry(strike + 1);
    };

    await failTry(1);

    const last = await claimLookup(core, trackId);

    expect(await settle(core, last, { outcome: "failed", error: "unreadable" })).toEqual({
      outcome: "held",
      value: { saved: "miss" },
    });
    expect(await lookupOf(core, trackId)).toMatchObject({
      job: null,
      answer: { status: "miss", current: true },
    });
    expect(await lyricsAs(owner, trackId)).toEqual({ status: "none" });

    // A miss stands 30 days; then a request asks again, and the song reads pending meanwhile.
    const [missRow] = await runFunction(
      core,
      internal.music.probe.lrclibRowIds,
      { trackId },
      Schema.Array(LrclibId),
    );

    await patchByHand(core, "lrclibLyrics", [missRow ?? never()], {
      checkedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    await runFunction(
      core,
      internal.music.lyricLookups.requestTracks,
      { trackIds: [trackId] },
      Schema.Null,
    );

    expect(await lyricsAs(owner, trackId)).toEqual({ status: "pending", fallback: null });
    await settle(core, await claimLookup(core, trackId), found(13, "found at last"));
    expect(await lyricsAs(owner, trackId)).toMatchObject({ status: "synced", source: "lrclib" });
  });

  it("list a lookup with its attempts to the admins who may see its song", async () => {
    const owner = await admin;
    const otherAdmin = await member(core, "lyrics-jobs-admin", "admin");
    const made = await library(core, owner, "Listed", (root) => [song(root, "Listed lookup")]);
    const trackId = made.ids[0] ?? never();

    await requestLookups(core, [trackId]);

    const lease = await claimLookup(core, trackId);

    await settle(core, lease, { outcome: "failed", error: "LRCLIB sent an unreadable answer" });

    const jobId = (await lookupOf(core, trackId)).job?.jobId ?? never();

    try {
      expect(await listedJob(owner.signedIn.client, jobId)).toMatchObject({
        kind: "music.lyrics",
        status: "queued",
        attempts: 1,
        library: null,
        error: "LRCLIB sent an unreadable answer",
      });

      // The song's library is private to its owner until it is shared, admins included.
      expect(await listedJob(otherAdmin.signedIn.client, jobId)).toBeUndefined();

      await owner.signedIn.client.mutation(api.core.permissions.grants.set, {
        resource: { type: "library", id: made.libraryId },
        principal: { kind: "household" },
        level: "view",
      });

      expect(await listedJob(otherAdmin.signedIn.client, jobId)).toMatchObject({
        kind: "music.lyrics",
        attempts: 1,
      });
    } finally {
      await runFunction(core, internal.core.jobs.admin.cancel, { jobId }, Schema.Unknown);
    }
  });

  it("run a lookup whose server stopped once more, and never store or ask twice", async () => {
    const owner = await admin;
    const { ids } = await library(core, owner, "Restart", (root) => [song(root, "Killed")]);
    const trackId = ids[0] ?? never();

    const request = () =>
      runFunction(
        core,
        internal.music.lyricLookups.requestTracks,
        { trackIds: [trackId] },
        Schema.Null,
      );

    await request();

    const dead = await claimLookup(core, trackId, 5000);

    await sleep(5500);
    await runFunction(core, internal.core.jobs.leases.releaseExpired, {}, Schema.Unknown);

    const restarted = await claimLookup(core, trackId);

    expect(restarted.attempt).toBe(dead.attempt + 1);
    expect(await settle(core, dead, found(1, "late"))).toEqual({ outcome: "lost" });
    expect(await settle(core, restarted, found(2, "kept"))).toEqual({
      outcome: "held",
      value: { saved: "found" },
    });
    expect(await settle(core, restarted, found(3, "again"))).toEqual({ outcome: "lost" });

    await request();

    expect(await lookupOf(core, trackId)).toMatchObject({
      job: null,
      answer: { status: "found", current: true },
      rows: 1,
    });
    expect(await lyricsAs(owner, trackId)).toMatchObject({
      main: { origin: { recordId: 2 }, body: { lines: [{ text: "kept" }] } },
    });
  });

  it("hold every lookup while lookups are off, for admins only to switch", async () => {
    const owner = await admin;
    const somebody = await member(core, "lyrics-switch-member");

    const { ids } = await library(core, owner, "Switch", (root) => [
      song(root, "Held"),
      song(root, "Asked while off"),
    ]);

    const [held, whileOff] = ids;

    const request = (trackId: Id<"tracks">) =>
      runFunction(
        core,
        internal.music.lyricLookups.requestTracks,
        { trackIds: [trackId] },
        Schema.Null,
      );

    await request(held ?? never());

    expect(await refusal(turn(somebody, false))).toBe("forbidden");
    expect(await refusal(somebody.signedIn.client.query(api.music.lyrics.status, {}))).toBe(
      "forbidden",
    );

    try {
      await turn(owner, false);

      expect(await owner.signedIn.client.query(api.music.lyrics.status, {})).toEqual({
        remote: false,
      });
      expect(await kindOf(core)).toMatchObject({ held: true });
      expect(await claimOnce(core)).toEqual({ outcome: "idle" });
      expect(await lyricsAs(owner, held ?? never())).toEqual({ status: "none" });
      expect(await refusal(owner.signedIn.client.mutation(api.music.lyrics.backfill, {}))).toBe(
        "conflict",
      );

      await request(whileOff ?? never());
      expect((await lookupOf(core, whileOff ?? never())).job).toBeNull();
      expect((await lookupOf(core, held ?? never())).job).toMatchObject({ status: "queued" });
    } finally {
      await turn(owner, true);
    }

    expect(await kindOf(core)).toMatchObject({ held: false });

    const lease = await claimLookup(core, held ?? never());

    await settle(core, lease, found(8, "after the switch"));
  });

  it("send nothing more from a lookup claimed before lookups were turned off", async () => {
    const owner = await admin;

    const { ids } = await library(core, owner, "Claimed then off", (root) => [
      song(root, "Claimed"),
    ]);

    const trackId = ids[0] ?? never();

    await requestLookups(core, [trackId]);

    const lease = await claimLookup(core, trackId);

    expect(await proceed(core, lease)).toEqual(nextIs("ask"));

    try {
      // The admin turns lookups off between the lookup's get and its search.
      await turn(owner, false);

      expect(await proceed(core, lease)).toEqual(nextIs("off"));
      expect(await lookupOf(core, trackId)).toMatchObject({
        job: { status: "queued", attempts: 1, strikes: 0, waitUntil: null },
        answer: null,
      });
      expect(await claimOnce(core)).toEqual({ outcome: "idle" });
      expect(await settle(core, lease, found(20, "too late"))).toEqual({ outcome: "lost" });
    } finally {
      await turn(owner, true);
    }

    const again = await claimLookup(core, trackId);

    expect(again.attempt).toBe(2);
    expect(await proceed(core, again)).toEqual(nextIs("ask"));
    expect(await settle(core, again, found(21, "back on"))).toEqual({
      outcome: "held",
      value: { saved: "found" },
    });
  });

  it("cancel a removed library's queued lookups, and end a claimed one as stale", async () => {
    const owner = await admin;

    const made = await library(core, owner, "Purged lookups", (root) => [
      song(root, "Claimed before"),
      song(root, "Queued before"),
    ]);

    const [claimed, queued] = made.ids;

    await requestLookups(core, [claimed ?? never()]);

    const lease = await claimLookup(core, claimed ?? never());

    await requestLookups(core, [queued ?? never()]);
    expect(await statusesOf(core, queued ?? never())).toEqual(["queued"]);

    await owner.signedIn.client.mutation(api.core.libraries.remove, { libraryId: made.libraryId });
    await eventually("the purge to finish", async () =>
      (await hasTotals(core, made.libraryId)) ? null : true,
    );

    expect(await statusesOf(core, queued ?? never())).toEqual(["canceled"]);
    expect(await statusesOf(core, claimed ?? never())).toEqual(["running"]);
    expect(await proceed(core, lease)).toEqual(nextIs("stale"));
    expect(await statusesOf(core, claimed ?? never())).toEqual(["succeeded"]);
  });

  it("end a claimed lookup of a purged song as stale while lookups are off", async () => {
    const owner = await admin;

    const made = await library(core, owner, "Purged while off", (root) => [
      song(root, "Claimed, then off, then purged"),
    ]);

    const trackId = made.ids[0] ?? never();

    await requestLookups(core, [trackId]);

    const lease = await claimLookup(core, trackId);

    try {
      await turn(owner, false);
      await owner.signedIn.client.mutation(api.core.libraries.remove, {
        libraryId: made.libraryId,
      });
      await eventually("the purge to finish", async () =>
        (await hasTotals(core, made.libraryId)) ? null : true,
      );

      expect(await proceed(core, lease)).toEqual(nextIs("stale"));
      expect(await statusesOf(core, trackId)).toEqual(["succeeded"]);
    } finally {
      await turn(owner, true);
    }

    expect(await claimedUntilIdle(core)).not.toContain(trackId);
    expect(await statusesOf(core, trackId)).toEqual(["succeeded"]);
  });

  it("end a purged song's lookup as stale when LRCLIB was unavailable, keeping its pause", async () => {
    const owner = await admin;

    const made = await library(core, owner, "Purged mid-request", (root) => [
      song(root, "Unavailable"),
    ]);

    const trackId = made.ids[0] ?? never();

    await requestLookups(core, [trackId]);

    const lease = await claimLookup(core, trackId);

    expect(await proceed(core, lease)).toEqual(nextIs("ask"));

    await owner.signedIn.client.mutation(api.core.libraries.remove, { libraryId: made.libraryId });
    await eventually("the purge to finish", async () =>
      (await hasTotals(core, made.libraryId)) ? null : true,
    );

    const pauseMs = 2000;

    expect(
      await settle(core, lease, { outcome: "unavailable", error: "LRCLIB: 429", pauseMs }),
    ).toEqual({ outcome: "held", value: { saved: "stale" } });
    expect(await statusesOf(core, trackId)).toEqual(["succeeded"]);
    expect((await kindOf(core)).pausedUntil).toBeGreaterThan(Date.now());

    await eventually(
      "the pause to end",
      async () => ((await kindOf(core)).pausedUntil === null ? true : null),
      pauseMs + 10_000,
    );

    expect(await claimedUntilIdle(core)).not.toContain(trackId);
  });

  it("cancel the queued lookup of a song whose folder left its library", async () => {
    const owner = await admin;
    const made = await musicLibrary(owner, "Dropped folder", 2);
    const [kept, dropped] = made.roots;

    if (kept === undefined || dropped === undefined) throw new Error("two folders");

    const scan = await claimScan(core, made.scanJobId);
    const scanned = [song(kept, "Kept song"), song(dropped, "Dropped song")];

    await upsertAll(core, scan, scanned);
    await finishScan(core, scan);

    const [keptId, droppedId] = await trackIdsAt(
      core,
      made.libraryId,
      scanned.map((track) => track.path),
    );

    await requestLookups(core, [keptId ?? never(), droppedId ?? never()]);
    expect(await statusesOf(core, droppedId ?? never())).toEqual(["queued"]);

    await owner.signedIn.client.mutation(api.core.libraries.setFolders, {
      libraryId: made.libraryId,
      folders: [kept],
    });
    await eventually("the dropped song to go", async () =>
      (await lookupsOf(core, [droppedId ?? never()]))[0] === null ? true : null,
    );

    expect(await statusesOf(core, droppedId ?? never())).toEqual(["canceled"]);
    expect(await statusesOf(core, keptId ?? never())).toEqual(["queued"]);
    await settle(core, await claimLookup(core, keptId ?? never()), found(22, "kept"));
  });

  it("look a retagged song up again, and delete its answer with the song", async () => {
    const owner = await admin;
    const made = await library(core, owner, "Retag", (root) => [song(root, "Old title")]);
    const trackId = made.ids[0] ?? never();

    await runFunction(
      core,
      internal.music.lyricLookups.requestTracks,
      { trackIds: [trackId] },
      Schema.Null,
    );
    await settle(core, await claimLookup(core, trackId), found(11, "old"));

    const { jobId } = await owner.signedIn.client.mutation(api.core.libraries.scan, {
      libraryId: made.libraryId,
    });

    const rescan = await claimScan(core, jobId);

    await upsertAll(core, rescan, [
      musicTrack(`${made.root}/Album/Old title.flac`, 2000, 1, {
        title: "New title",
        artist: "Lyrics Artist",
        album: "Album",
        durationMs: 200_000,
      }),
    ]);
    await finishScan(core, rescan);

    expect(await lookupOf(core, trackId)).toMatchObject({
      job: null,
      answer: { status: "found", current: false },
    });
    expect(await lyricsAs(owner, trackId)).toEqual({ status: "none" });

    await runFunction(
      core,
      internal.music.lyricLookups.requestTracks,
      { trackIds: [trackId] },
      Schema.Null,
    );
    expect((await lookupOf(core, trackId)).job).toMatchObject({ status: "queued" });
    await settle(core, await claimLookup(core, trackId), found(12, "new"));

    await owner.signedIn.client.mutation(api.core.libraries.remove, { libraryId: made.libraryId });
    await eventually("the purge to finish", async () =>
      (await hasTotals(core, made.libraryId)) ? null : true,
    );

    expect(await lookupsOf(core, [trackId])).toEqual([null]);
    expect(
      await runFunction(core, internal.music.probe.lrclibRowCount, { trackId }, Schema.Finite),
    ).toBe(0);
  });

  it("go through songs whose answers are at the row's bound within one call's reads", async () => {
    const owner = await admin;
    const count = 40;

    const { ids } = await library(core, owner, "Dense answers", (root) =>
      Array.from({ length: count }, (_, n) => song(root, `Dense ${String(n).padStart(2, "0")}`)),
    );

    await Promise.all(
      [0, 1, 2, 3, 4, 5, 6, 7].map((batch) =>
        insertByHand(
          core,
          "lrclibLyrics",
          ids.slice(batch * 5, batch * 5 + 5).map((trackId) => staleDenseAnswer(trackId)),
        ),
      ),
    );

    await owner.signedIn.client.mutation(api.music.lyrics.backfill, {});

    // Each step reads past answers for older tags at the row's bound and queues a new lookup.
    expect((await workUntilAnswered(core, ids)).answered).toBe(count);
  });

  it("keep a large backfill a page ahead of the worker while other enqueues go on", async () => {
    const owner = await admin;
    const count = 120;

    const { ids } = await library(core, owner, "Large backfill", (root) =>
      Array.from({ length: count }, (_, n) => song(root, `Track ${String(n).padStart(3, "0")}`)),
    );

    // Start from an empty queue, which the backfill could fill all at once.
    await drainAll(core);
    await owner.signedIn.client.mutation(api.music.lyrics.backfill, {});

    /** The most of the songs' lookups seen waiting over `ms`, while nothing claims. */
    const quietMost = async (until: number, most = 0): Promise<number> => {
      const states = await lookupsOf(core, ids);
      const waiting = states.filter((one) => one?.job?.status === "queued").length;

      if (Date.now() > until) return Math.max(most, waiting);

      await sleep(200);

      return quietMost(until, Math.max(most, waiting));
    };

    // On a queue nothing works, the backfill's steps fill it up to 24 and go no further.
    const quiet = await quietMost(Date.now() + 5000);

    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThanOrEqual(24);

    const created = Promise.all(
      Array.from({ length: 6 }, async (_, n) => musicLibrary(owner, `Beside the backfill ${n}`)),
    );

    const { answered, mostQueued } = await workUntilAnswered(core, ids);

    expect((await created).length).toBe(6);
    expect(answered).toBe(count);
    // A step queues only enough to keep fewer than 25 waiting.
    expect(mostQueued).toBeLessThanOrEqual(24);
  });
});

const never = (): never => {
  throw new Error("a test track is missing");
};
