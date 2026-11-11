import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { followLog, logMark, runFunction } from "../../admin";
import type { CallUsage, LogMark } from "../../admin";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { share } from "../../probe";
import { runServer, runServerAs } from "../../service";
import { refusal } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { claimJob, finishJob, moviesLibrary, upsert } from "../../movies/catalog";
import { makeTree } from "./files";
import type { Lease } from "../../movies/catalog";
import { startImport } from "../../movies/importing";
import { movieFile } from "../../movies/scanned";
import { retrying } from "../jobs/driver";

const stack = coreStackFromEnvFile();

const Answer = Schema.Struct({ outcome: Schema.String });

const report = (core: CoreStack, lease: Lease, done: number, total: number, message: string) =>
  retrying(() =>
    runServer(
      core,
      api.core.jobs.worker.report,
      { lease, leaseMs: 60_000, message, progress: { done, total } },
      Answer,
    ),
  );

const finishWith = (core: CoreStack, lease: Lease) =>
  retrying(() =>
    runServer(core, api.core.jobs.worker.finish, { lease, end: { outcome: "succeeded" } }, Answer),
  );

const cancel = (who: Member, jobId: Id<"jobs">, attempt: number) =>
  who.signedIn.client.mutation(api.core.libraries.cancelScan, { jobId, attempt });

/** The shortest lease a worker may take, so a test can let one lapse. */
const SHORT_LEASE_MS = 5000;

/** Lets every lease taken `SHORT_LEASE_MS` ago lapse, as the release cron would. */
const lapseShortLeases = async (core: CoreStack) => {
  await sleep(SHORT_LEASE_MS + 500);
  await runFunction(
    core,
    internal.core.jobs.leases.releaseExpired,
    {},
    Schema.Struct({ released: Schema.Finite, more: Schema.Boolean }),
  );
};

const scanOf = async (who: Member, libraryId: Id<"libraries">) =>
  (await who.signedIn.client.query(api.core.libraries.get, { libraryId })).scan;

/** `core/scans:watched` as a caller that still names a kind would call it. */
const watchedOfKind = makeFunctionReference<
  "query",
  { kind: string; paginationOpts: { numItems: number; cursor: string | null } },
  unknown
>("core/scans:watched");

/** `core/scans:watched` as a reactive client would reload a page, pinned to where it ended. */
const watchedPinned = makeFunctionReference<
  "query",
  { paginationOpts: { numItems: number; cursor: string | null; endCursor: string } },
  unknown
>("core/scans:watched");

/** Convex's per-call limit on bytes read (ADR 0013). */
const BYTES_MAX = 16 * 1024 * 1024;

/** What a page of 64 libraries with 16 folders at their bounds reads at least: 64 × 16 × 3,000. */
const FULL_PAGE_BYTES = 3_000_000;

/**
 * A folder at its bounds: 1,024 characters, 3,000 bytes in UTF-8 (32 ASCII, then four of `/` and
 * 247 three-byte characters), unique by `prefix`.
 */
const longFolder = (prefix: string): string =>
  `/${prefix.padEnd(31, "-")}${`/${"界".repeat(247)}`.repeat(4)}`;

/** Creates `count` movies libraries one after another, each with 16 folders at their bounds. */
const longLibraries = async (
  admin: Member,
  run: string,
  count: number,
  made: ReadonlyArray<Id<"libraries">> = [],
): Promise<ReadonlyArray<Id<"libraries">>> => {
  if (made.length >= count) return made;

  const { libraryId } = await admin.signedIn.client.mutation(api.core.libraries.create, {
    name: `Long ${made.length}`,
    kind: "movies",
    folders: Array.from({ length: 16 }, (_, folder) =>
      longFolder(`${run}-${made.length}-${folder}`),
    ),
  });

  return longLibraries(admin, run, count, [...made, libraryId]);
};

/**
 * Each `watched` call logged since `mark`, once one of them read a full page of libraries at their
 * bounds. A page whose libraries did not change since another test read it comes from the query
 * cache and logs nothing, so how many calls log depends on the tests before; a page holding new
 * libraries always logs.
 */
const watchedUntilFullPage = async (
  core: CoreStack,
  mark: LogMark,
  timeoutMs = 30_000,
): Promise<ReadonlyArray<CallUsage>> => {
  const log = followLog(core, mark);
  const deadline = Date.now() + timeoutMs;

  const logged = async (): Promise<ReadonlyArray<CallUsage>> => {
    const usage = log.usage(api.core.scans.watched);

    if (usage.some((call) => call.committed && call.bytes > FULL_PAGE_BYTES)) return usage;

    if (Date.now() > deadline) throw new Error("No core/scans:watched call read a full page");

    await log.catchUp();

    return logged();
  };

  return logged();
};

/** The cursor each page of `watched` ended at, read page by page with open cursors. */
const watchedCursors = async (
  core: CoreStack,
  cursor: string | null = null,
  seen: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  const page = await runServer(
    core,
    api.core.scans.watched,
    { paginationOpts: { numItems: 64, cursor } },
    Watched,
  );

  const cursors = [...seen, page.continueCursor];

  return page.isDone ? cursors : watchedCursors(core, page.continueCursor, cursors);
};

const removeAll = async (admin: Member, libraryIds: ReadonlyArray<Id<"libraries">>) => {
  const [libraryId, ...rest] = libraryIds;

  if (libraryId === undefined) return;

  await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  await removeAll(admin, rest);
};

const Watched = Schema.Struct({
  page: Schema.Array(
    Schema.Struct({ libraryId: Schema.String, folders: Schema.Array(Schema.String) }),
  ),
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

const watchedFolders = async (
  core: CoreStack,
  cursor: string | null = null,
  seen: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> => {
  const page = await runServer(
    core,
    api.core.scans.watched,
    { paginationOpts: { numItems: 64, cursor } },
    Watched,
  );

  const next = new Map([...seen, ...page.page.map((row) => [row.libraryId, row.folders] as const)]);

  return page.isDone ? next : watchedFolders(core, page.continueCursor, next);
};

describe.skipIf(stack === undefined)("cancelling scans and imports", { timeout: 300_000 }, () => {
  it("cancel the scan named, fenced by its attempt, for people who may edit the library", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "cancel-admin", "admin");
    const editor = await member(stack, "cancel-editor");
    const viewer = await member(stack, "cancel-viewer");
    const outsider = await member(stack, "cancel-outsider");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Cancels");
    const root = roots[0] ?? "";

    await share(admin, libraryId, { kind: "user", userId: editor.userId }, "edit");
    await share(admin, libraryId, { kind: "user", userId: viewer.userId }, "view");

    const first = await claimJob(stack, "movies.scan", scanJobId);
    const before = Date.now();

    await report(stack, first, 1, 4, "probing");

    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: scanJobId,
      status: "running",
      done: 1,
      total: 4,
      message: "probing",
    });
    expect((await scanOf(editor, libraryId))?.startedAt).toBeLessThanOrEqual(before);

    expect(await refusal(cancel(viewer, scanJobId, 1))).toBe("forbidden");
    expect(await refusal(cancel(outsider, scanJobId, 1))).toBe("not_found");

    await finishJob(stack, first);
    expect(await cancel(editor, scanJobId, 1)).toEqual({
      outcome: "finished",
      status: "succeeded",
    });
    expect(await scanOf(editor, libraryId)).toMatchObject({ status: "succeeded" });

    const queued = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });

    expect(await cancel(editor, queued.jobId, 0)).toEqual({
      outcome: "finished",
      status: "canceled",
    });
    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: queued.jobId,
      status: "canceled",
    });

    const running = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });
    const lease = await claimJob(stack, "movies.scan", running.jobId);

    expect(await cancel(editor, running.jobId, 1)).toEqual({ outcome: "canceling" });
    expect(await cancel(editor, running.jobId, 1)).toEqual({ outcome: "canceling" });
    expect(await scanOf(editor, libraryId)).toMatchObject({ status: "running", canceling: true });

    expect(await upsert(stack, lease, [movieFile(join(root, "late.mkv"))])).toEqual({
      outcome: "canceled",
    });
    expect(await finishWith(stack, lease)).toEqual({ outcome: "canceled" });
    expect(await report(stack, lease, 4, 4, "done")).toEqual({ outcome: "canceled" });
    expect(await scanOf(editor, libraryId)).toMatchObject({
      jobId: running.jobId,
      status: "canceled",
      startedAt: null,
    });
    expect(await cancel(editor, running.jobId, 1)).toEqual({
      outcome: "finished",
      status: "canceled",
    });

    const next = await editor.signedIn.client.mutation(api.core.libraries.scan, { libraryId });

    expect(next.jobId).not.toBe(running.jobId);
    expect(await cancel(editor, running.jobId, 1)).toEqual({
      outcome: "finished",
      status: "canceled",
    });
    expect(await scanOf(editor, libraryId)).toMatchObject({ jobId: next.jobId, status: "queued" });

    const backup = await admin.signedIn.client.mutation(api.core.server.backups.run, {});

    expect(await refusal(cancel(admin, backup.jobId, 0))).toBe("not_found");

    await cancel(admin, next.jobId, 0);
    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("cancel an import for its owners and admins, fenced by its attempt", async () => {
    if (stack === undefined) return;

    const owner = await member(stack, "cancel-import-admin", "admin");
    const someone = await member(stack, "cancel-import-member");
    const serverId = `cancel-${Date.now()}`;
    const started = await startImport(stack, owner, { serverId });

    const cancelImport = (who: Member, attempt: number) =>
      who.signedIn.client.mutation(api.movies.imports.cancel, {
        importId: started.importId,
        attempt,
      });

    const run = () =>
      owner.signedIn.client.query(api.movies.imports.get, { importId: started.importId });

    expect((await run()).job).toMatchObject({
      status: "queued",
      startedAt: null,
      canceling: false,
    });
    expect(await refusal(cancelImport(someone, 0))).toBe("forbidden");

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    expect((await run()).job.startedAt).toBeGreaterThan(0);
    expect(await cancelImport(owner, 1)).toEqual({ outcome: "canceling" });
    expect((await run()).job).toMatchObject({ status: "running", canceling: true });
    expect(await finishWith(stack, lease)).toEqual({ outcome: "canceled" });
    expect((await run()).job).toMatchObject({
      status: "canceled",
      startedAt: null,
      canceling: false,
    });
    expect(await cancelImport(owner, 1)).toEqual({ outcome: "finished", status: "canceled" });

    const again = await startImport(stack, owner, { serverId });

    expect(again.created).toBe(true);
    expect(await cancelImport(owner, 1)).toEqual({ outcome: "finished", status: "canceled" });
    expect(
      (await owner.signedIn.client.query(api.movies.imports.get, { importId: again.importId })).job
        .status,
    ).toBe("queued");

    await owner.signedIn.client.mutation(api.movies.imports.cancel, {
      importId: again.importId,
      attempt: 0,
    });
  });

  it("cancel a scan only at the attempt the editor saw, after its lease lapsed and it was claimed again", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "reclaim-admin", "admin");
    const { libraryId, scanJobId } = await moviesLibrary(admin, "Reclaimed");

    await claimJob(stack, "movies.scan", scanJobId, SHORT_LEASE_MS);

    const seen = await scanOf(admin, libraryId);

    expect(seen).toMatchObject({ jobId: scanJobId, status: "running", attempt: 1 });

    await lapseShortLeases(stack);

    const second = await claimJob(stack, "movies.scan", scanJobId);

    expect(second).toEqual({ jobId: scanJobId, attempt: 2 });
    expect(await cancel(admin, scanJobId, 1)).toEqual({ outcome: "movedOn" });
    expect(await scanOf(admin, libraryId)).toMatchObject({
      jobId: scanJobId,
      status: "running",
      attempt: 2,
      canceling: false,
    });
    expect(await cancel(admin, scanJobId, 2)).toEqual({ outcome: "canceling" });
    expect(await finishWith(stack, second)).toEqual({ outcome: "canceled" });

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("cancel an import only at the attempt its owner saw, after its lease lapsed and it was claimed again", async () => {
    if (stack === undefined) return;

    const owner = await member(stack, "reclaim-import-admin", "admin");
    const started = await startImport(stack, owner, { serverId: `reclaim-${Date.now()}` });

    const run = () =>
      owner.signedIn.client.query(api.movies.imports.get, { importId: started.importId });

    const cancelAt = (attempt: number) =>
      owner.signedIn.client.mutation(api.movies.imports.cancel, {
        importId: started.importId,
        attempt,
      });

    await claimJob(stack, "movies.import.jellyfin", started.jobId, SHORT_LEASE_MS);
    expect((await run()).job).toMatchObject({ status: "running", attempt: 1 });

    await lapseShortLeases(stack);

    const second = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    expect(second).toEqual({ jobId: started.jobId, attempt: 2 });
    expect(await cancelAt(1)).toEqual({ outcome: "movedOn" });
    expect((await run()).job).toMatchObject({ status: "running", attempt: 2, canceling: false });
    expect(await cancelAt(2)).toEqual({ outcome: "canceling" });
    expect(await finishWith(stack, second)).toEqual({ outcome: "canceled" });
  });

  it("tell the server every movies library's folders, and only the server", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "watched-admin", "admin");
    const { libraryId, roots } = await moviesLibrary(admin, "Watched", 2);

    expect((await watchedFolders(stack)).get(libraryId)?.toSorted()).toEqual([...roots].toSorted());
    expect(
      await refusal(
        runServerAs(
          stack,
          admin.signedIn,
          api.core.scans.watched,
          { paginationOpts: { numItems: 10, cursor: null } },
          Watched,
        ),
      ),
    ).toBe("forbidden");

    const music = await admin.signedIn.client.mutation(api.core.libraries.create, {
      name: "Watched music",
      kind: "music",
      folders: [await makeTree([])],
    });

    expect((await watchedFolders(stack)).has(music.libraryId)).toBe(false);
    await expect(
      runServer(
        stack,
        watchedOfKind,
        { kind: "music", paginationOpts: { numItems: 64, cursor: null } },
        Watched,
      ),
    ).rejects.toThrow();
    await admin.signedIn.client.mutation(api.core.libraries.remove, {
      libraryId: music.libraryId,
    });

    const scan = await scanOf(admin, libraryId);

    if (scan !== null) {
      await cancel(admin, scan.jobId, scan.attempt);
    }

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });

    expect((await watchedFolders(stack)).has(libraryId)).toBe(false);
  });

  it("page every movies library's folders within one call's reads, and refuse a page pinned to an end", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "watched-long", "admin");
    // Two pages' worth: whatever libraries come before them, one whole page of 64 is all at bounds.
    const libraryIds = await longLibraries(admin, `w${Date.now() % 100_000_000}`, 128);
    const mark = await logMark(stack);
    const cursors = await watchedCursors(stack);
    const usage = await watchedUntilFullPage(stack, mark);

    expect(cursors.length).toBeGreaterThan(1);
    expect(usage.every((call) => call.committed && call.bytes < BYTES_MAX)).toBe(true);

    const end = cursors.at(-2) ?? "";

    await expect(
      runServer(
        stack,
        watchedPinned,
        { paginationOpts: { numItems: 64, cursor: null, endCursor: end } },
        Watched,
      ),
    ).rejects.toThrow(/endCursor/u);

    await removeAll(admin, libraryIds);
  });
});
