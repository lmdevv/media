import { canLookUp, lookupKeyOf } from "@media/contracts/lyrics-lookup";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { leaseAnswer, withJobLease } from "../core/jobs/held";
import { kindDef } from "../core/jobs/kinds";
import type { PayloadOf } from "../core/jobs/kinds";
import type { Finish } from "../core/jobs/machine";
import { lease } from "../core/jobs/model";
import { applyEvent, insertJob, queuedCount } from "../core/jobs/store";
import type { JobCtx } from "../core/jobs/store";
import { inOrder } from "../core/lib/inOrder";
import { sha256Hex } from "../core/lib/secrets";
import { serverMutation } from "../core/lib/serverFacing";
import { reachOf } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import { SERVER, can, principalOf } from "../core/permissions/policy";
import { callBudget } from "../movies/reads";
import { walkMusicLibrariesFrom } from "./access";
import { CALL_COST, NO_COST, addCost, cost, meterFrom, whileBudget } from "./budget";
import { checkLyrics } from "./fit";
import { lrclibAnswer } from "./validators";
import type { LrclibAnswer } from "./validators";
import { atBound, musicStore } from "./write";
import type { MusicStore } from "./write";

/**
 * LRCLIB lookups as `music.lyrics` jobs (ADR 0012), replacing old music's `lyricLookups` queue and
 * its `lrclibPause` table: a job's attempts and strikes are a lookup's tries, its delayed retry is
 * old music's wait after a failed try, and the kind's pause is the LRCLIB pause. A lookup is asked
 * for when a song starts playing (`music.play.start`), when it is downloaded (`core.downloads.add`),
 * and by an admin's backfill (`music.lyrics.backfill`), as in old music; never by a scan. Its
 * answer lands in `lrclibLyrics`, keyed by the track and the revision of its tags.
 */

/** A `music.lyrics` job's payload: the track, the revision of its tags, and what LRCLIB is asked. */
export type Lookup = PayloadOf<"music.lyrics">;

/** How long a miss stands before a request asks LRCLIB again, as in old music. */
const MISS_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a lookup whose LRCLIB record could not be read waits before its next try, by the
 * strikes it had, as old music waited; its fifth failed try stores a miss.
 */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

/** The most tracks one request takes: a song starting or a download names one. */
const REQUEST_MAX = 16;

/** Tracks one backfill step reads. */
const BACKFILL_PAGE = 50;

/**
 * A backfill queues more lookups only while fewer than this many wait, so a library of any size
 * never puts more than a page ahead of the worker, a song that starts playing waits behind at most
 * that many, and no run of mass inserts holds the kind's row (ADR 0012).
 */
const BACKFILL_AHEAD = 25;

/**
 * How long a backfill first waits for the queue to drain below `BACKFILL_AHEAD` before it looks
 * again. Each wait in a row doubles, up to `BACKFILL_WAIT_MAX_MS`, so a backfill whose server is
 * stopped or whose lookups are paused looks about once a minute.
 */
const BACKFILL_WAIT_MS = 2000;

const BACKFILL_WAIT_MAX_MS = 60_000;

/**
 * The lookup a track's tags make, or null when LRCLIB cannot match them (`canLookUp`). Its
 * revision is SHA-256 of the lookup key, so tags that normalize alike make the same revision and
 * a retag makes another.
 */
export const lookupOf = async (track: Doc<"tracks">): Promise<Lookup | null> => {
  const tags = {
    artist: track.artistName,
    title: track.title,
    album: track.albumTitle,
    durationMs: track.durationMs,
  };

  if (!canLookUp(tags)) return null;

  return {
    kind: "music.lyrics",
    trackId: track._id,
    revision: await sha256Hex(lookupKeyOf(tags)),
    query: {
      artist: tags.artist,
      title: tags.title,
      album: tags.album,
      durationS: Math.round(tags.durationMs / 1000),
    },
  };
};

/** Whether the server looks lyrics up on LRCLIB: on unless an admin turned it off. */
export const remoteLyricsOn = async (db: DatabaseReader): Promise<boolean> =>
  (await db.query("lyricsSettings").first())?.remote ?? true;

/** Whether `row` answers for `lookup` and still stands: found or instrumental, or a recent miss. */
const answered = (row: Doc<"lrclibLyrics"> | null, lookup: Lookup, now: number): boolean =>
  row !== null &&
  row.revision === lookup.revision &&
  (row.answer.status !== "miss" || now < row.checkedAt + MISS_RETRY_MS);

/**
 * Queues a lookup for `track` unless it needs none, as old music's `requestOne` decided: a song
 * missing from disk, one whose own files hold synced lyrics, one LRCLIB cannot match, and one with
 * a standing answer for its tags are skipped. The kind's dedupe joins a lookup already queued or
 * running for the same tags.
 */
const request = async (ctx: JobCtx, store: MusicStore, track: Doc<"tracks">): Promise<void> => {
  if (track.missing || track.lyricsSynced) return;

  const lookup = await lookupOf(track);

  if (lookup === null) return;

  const row = await store.first("lrclibLyrics", (q) =>
    q.withIndex("by_track", (index) => index.eq("trackId", track._id)),
  );

  if (!answered(row, lookup, Date.now())) await insertJob(ctx, lookup);
};

/**
 * One track's `request` at worst: its LRCLIB row at the row's bound, and the enqueue, which reads
 * the kind's row and two dedupe entries and inserts the job and reads it back.
 */
const REQUEST_MOST = addCost(atBound.read("lrclibLyrics"), cost(4, 2, 16 * 1024, 8 * 1024));

/**
 * Asks LRCLIB for the lyrics of `trackIds` (`request`), when lookups are on. A song starting or a
 * download schedules it, so its enqueue never conflicts with the person's own call. Tracks that
 * are gone are skipped.
 */
export const requestTracks = internalMutation({
  args: { trackIds: v.array(v.id("tracks")) },
  returns: v.null(),
  handler: async (ctx, { trackIds }) => {
    if (trackIds.length > REQUEST_MAX) {
      throw new Error(`A request names at most ${REQUEST_MAX} tracks; got ${trackIds.length}`);
    }

    if (!(await remoteLyricsOn(ctx.db))) return null;

    const store = musicStore(ctx.db, meterFrom(NO_COST));

    await inOrder([...new Set(trackIds)], async (trackId) => {
      const track = await store.get("tracks", trackId);

      if (track !== null) await request(ctx, store, track);
    });

    return null;
  },
});

/** Schedules `requestTracks` for one track, from a mutation that names it. */
export const scheduleRequest = async (ctx: JobCtx, trackId: Id<"tracks">): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.music.lyricLookups.requestTracks, {
    trackIds: [trackId],
  });
};

/**
 * Looks up lyrics for every track of `libraryIds` in path order, a page a step, then the next
 * library, as old music's `lyrics.backfill` did, stopping when lookups are turned off. Unlike old
 * music, which queued every song at once, a step queues its page only while fewer than
 * `BACKFILL_AHEAD` lookups wait, and otherwise looks again later (`BACKFILL_WAIT_MS`).
 */
export const backfill = internalMutation({
  args: {
    libraryIds: v.array(v.id("libraries")),
    /** The path of the last track of the first library a step went through; null from its first. */
    after: v.union(v.string(), v.null()),
    /** Steps in a row that found the queue full; absent for none. */
    waits: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { libraryIds, after, waits = 0 }) => {
    const [libraryId, ...later] = libraryIds;

    if (libraryId === undefined || !(await remoteLyricsOn(ctx.db))) return null;

    if ((await queuedCount(ctx.db, "music.lyrics", BACKFILL_AHEAD)) >= BACKFILL_AHEAD) {
      const wait = Math.min(BACKFILL_WAIT_MS * 2 ** waits, BACKFILL_WAIT_MAX_MS);

      await ctx.scheduler.runAfter(wait, internal.music.lyricLookups.backfill, {
        libraryIds,
        after,
        waits: waits + 1,
      });

      return null;
    }

    const store = musicStore(ctx.db, meterFrom(NO_COST));

    // A library holds one track a path, so the path is the exact cursor of a step that stopped
    // part of the way through its page.
    const page = await store.take(
      "tracks",
      (q) =>
        q.withIndex("by_library_path", (index) =>
          after === null
            ? index.eq("libraryId", libraryId)
            : index.eq("libraryId", libraryId).gt("path", after),
        ),
      BACKFILL_PAGE,
    );

    // Each track may hold an LRCLIB row at its 512 KiB bound, so the budget decides how many of
    // the page one step goes through (ADR 0024).
    const done = await whileBudget(store.meter, CALL_COST, REQUEST_MOST, page, (track) =>
      request(ctx, store, track),
    );

    const last = page[done.length - 1];

    const next =
      done.length === page.length && page.length < BACKFILL_PAGE
        ? { libraryIds: later, after: null }
        : { libraryIds, after: last?.path ?? after };

    if (next.libraryIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.music.lyricLookups.backfill, next);
    }

    return null;
  },
});

/** Queues the backfill of the libraries `gates` found (`backfill`). */
export const startBackfill = async (
  ctx: JobCtx,
  gates: ReadonlyArray<Pick<ItemGate, "library">>,
): Promise<void> => {
  if (gates.length === 0) return;

  await ctx.scheduler.runAfter(0, internal.music.lyricLookups.backfill, {
    libraryIds: gates.map((gate) => gate.library._id),
    after: null,
  });
};

/** Schedules `discover` from `cursor`, for an admin's libraries one call could not list. */
export const discoverMore = async (
  ctx: JobCtx,
  userId: Id<"users">,
  cursor: string | null,
): Promise<void> => {
  await ctx.scheduler.runAfter(0, internal.music.lyricLookups.discover, { userId, cursor });
};

/**
 * Lists the next music libraries `userId` may view, from `cursor`, as far as one call's budget
 * reaches, and starts their backfill, then goes on in another step until the last one, as old
 * music's backfill went through every library its admin could read. It stops when lookups are
 * turned off or the person may no longer configure them.
 */
export const discover = internalMutation({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { userId, cursor }) => {
    const user = await ctx.db.get(userId);

    if (user === null || !(await remoteLyricsOn(ctx.db))) return null;

    const principal = principalOf(user);

    if (!can(principal, "configureLyrics", SERVER).allowed) return null;

    const reach = await reachOf(ctx.db, principal);
    const walked = await walkMusicLibrariesFrom(ctx.db, reach, callBudget(reach), cursor);

    await startBackfill(ctx, walked.gates);

    // A step that found nothing and still stopped short could not afford one page: stop there.
    if (!walked.complete && (walked.gates.length > 0 || walked.cursor !== cursor)) {
      await discoverMore(ctx, userId, walked.cursor);
    }

    return null;
  },
});

/**
 * What one try learned, as the server sends it: LRCLIB's answer; that the record it sent for the
 * song could not be read (`failed`); or that LRCLIB itself was unavailable, with how long the
 * server holds every request (`unavailable`), as old music's `LookupOutcome` said.
 */
const tryOutcome = v.union(
  v.object({ outcome: v.literal("answered"), answer: lrclibAnswer }),
  v.object({ outcome: v.literal("failed"), error: v.string() }),
  v.object({ outcome: v.literal("unavailable"), error: v.string(), pauseMs: v.number() }),
);

/** What `settle` did with a try: stored an answer, gave up as a miss, or put the lookup back. */
const settled = v.union(
  v.object({ saved: v.union(v.literal("found"), v.literal("instrumental"), v.literal("miss")) }),
  /** The song is gone, or its tags changed since the lookup was asked for: nothing stored. */
  v.object({ saved: v.literal("stale") }),
  /** It waits for its next try, or for LRCLIB's pause to end. */
  v.object({ saved: v.literal("retrying") }),
);

const SAVED_MESSAGES: Readonly<Record<LrclibAnswer["status"], string>> = {
  found: "LRCLIB found lyrics",
  instrumental: "LRCLIB says the song is instrumental",
  miss: "LRCLIB has no lyrics for the song",
};

/**
 * Stores `answer` for the held lookup when its track still has the tags it was asked for: a gone
 * or retagged track stores nothing, as the answer would be for tags it no longer has.
 */
const saveAnswer = async (
  ctx: JobCtx,
  lookup: Lookup,
  answer: LrclibAnswer,
): Promise<LrclibAnswer["status"] | "stale"> => {
  const music = musicStore(ctx.db, meterFrom(NO_COST));
  const track = await music.get("tracks", lookup.trackId);
  const current = track === null ? null : await lookupOf(track);

  if (current?.revision !== lookup.revision) return "stale";

  if (answer.status === "found") checkLyrics(answer.sets);

  return music.writeLrclibLyrics(lookup.trackId, {
    revision: lookup.revision,
    checkedAt: Date.now(),
    answer,
  });
};

type TryOutcome = Infer<typeof tryOutcome>;

interface Ended {
  readonly saved: Infer<typeof settled>["saved"];
  readonly finish: Finish;
}

/** What a try with `strikes` before it stores, and how its job ends (`settle`). */
const endOf = async (
  ctx: JobCtx,
  lookup: Lookup,
  result: TryOutcome,
  strikes: number,
): Promise<Ended> => {
  if (result.outcome === "unavailable") {
    return {
      saved: "retrying",
      finish: { outcome: "deferred", error: result.error, pauseMs: result.pauseMs },
    };
  }

  if (result.outcome === "answered") {
    const saved = await saveAnswer(ctx, lookup, result.answer);

    return {
      saved,
      finish: {
        outcome: "succeeded",
        message: saved === "stale" ? STALE_MESSAGE : SAVED_MESSAGES[saved],
      },
    };
  }

  const delay = RETRY_DELAYS_MS[strikes];

  if (strikes + 1 < kindDef("music.lyrics").maxStrikes && delay !== undefined) {
    return {
      saved: "retrying",
      finish: { outcome: "failed", error: result.error, retry: true, retryInMs: delay },
    };
  }

  return {
    saved: await saveAnswer(ctx, lookup, { status: "miss" }),
    finish: { outcome: "failed", error: result.error, retry: false },
  };
};

const STALE_MESSAGE = "The song is gone or was retagged since this lookup was asked for";

/**
 * Ends the held lookup with what its try learned, in the one mutation that also stores its
 * answer, so a lookup that stored its answer never runs again and a server that stops before this
 * call leaves the job to run again (ADR 0012). An answer is stored and the job succeeds. A record
 * that could not be read fails the try: the lookup waits for its next one, and its fifth stores a
 * miss and fails the job. LRCLIB being unavailable puts the lookup back with no strike and pauses
 * every lookup for `pauseMs`, even across a restart. The server ends the job through this call,
 * never through `core/jobs/worker:finish`.
 */
export const settle = serverMutation({
  args: { lease, result: tryOutcome },
  returns: leaseAnswer(settled),
  handler: (ctx, { lease: held, result }) =>
    withJobLease(ctx, ["music.lyrics"], held, async (job) => {
      const running = await ctx.db.get("jobs", job.jobId);

      if (running?.status !== "running") {
        throw new Error(`The lookup ${job.jobId} this lease checked is not running`);
      }

      const ended = await endOf(ctx, job.payload, result, running.strikes);

      const step = await applyEvent(ctx, running, {
        type: "finish",
        lease: held,
        finish: ended.finish,
      });

      if (!step.ok)
        throw new Error(`The held lookup ${job.jobId} refused its end: ${step.refused}`);

      return { outcome: "held" as const, value: { saved: ended.saved } };
    }),
});
