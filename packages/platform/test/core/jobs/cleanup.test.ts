import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { member } from "../../devices";
import { JobId, claimJob, finishJob, moviesLibrary, upsert } from "../../movies/catalog";
import { startImport } from "../../movies/importing";
import { movieFile, scannedTitle } from "../../movies/scanned";
import { runServer } from "../../service";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { freshRun, inSequence, retrying } from "./driver";

const stack = coreStackFromEnvFile();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const Swept = Schema.Struct({ jobs: Schema.Finite, items: Schema.Finite, more: Schema.Boolean });

const Canceled = Schema.Struct({ outcome: Schema.String });

const backdate = (core: CoreStack, jobId: Id<"jobs">, ago = WEEK_MS + 60_000) =>
  runFunction(
    core,
    internal.core.jobs.probe.backdate,
    { jobId, finishedAt: Date.now() - ago },
    Schema.Null,
  );

const cancel = (core: CoreStack, jobId: Id<"jobs">) =>
  runFunction(core, internal.core.jobs.admin.cancel, { jobId }, Canceled);

/** Runs the sweep until it says nothing is left, as its own scheduling would. */
const sweepAll = async (core: CoreStack, calls = 0): Promise<number> => {
  const swept = await retrying(() =>
    runFunction(core, internal.core.jobs.cleanup.sweep, {}, Swept),
  );

  if (!swept.more) return calls + 1;

  if (calls >= 100) throw new Error("The sweep never ran out of old jobs");

  return sweepAll(core, calls + 1);
};

const exists = async (core: CoreStack, jobId: Id<"jobs">): Promise<boolean> =>
  (await runFunction(
    core,
    internal.core.jobs.admin.get,
    { jobId },
    Schema.NullOr(Schema.Unknown),
  )) !== null;

const TrickplayState = Schema.Struct({
  trickplay: Schema.NullOr(
    Schema.Struct({ status: Schema.String, jobId: Schema.optionalKey(JobId) }),
  ),
});

describe.skipIf(stack === undefined)("the sweep of finished jobs", { timeout: 180_000 }, () => {
  it("delete week-old finished jobs of swept kinds, and keep recent ones and scans", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "sweep-admin", "admin");

    const [oldProbe, oldProbeToo, recentProbe] = await runFunction(
      stack,
      internal.core.jobs.probe.enqueue,
      { kind: "probe.capped", run: freshRun("sweep"), count: 3 },
      Schema.Array(JobId),
    );

    if (oldProbe === undefined || oldProbeToo === undefined || recentProbe === undefined) {
      throw new Error("enqueued too few jobs");
    }

    await Promise.all([oldProbe, oldProbeToo, recentProbe].map(async (id) => cancel(stack, id)));
    await backdate(stack, oldProbe);
    await backdate(stack, oldProbeToo, 30 * WEEK_MS);

    const { libraryId, scanJobId } = await moviesLibrary(admin, "Swept");

    await cancel(stack, scanJobId);
    await backdate(stack, scanJobId);

    const imported = await startImport(stack, admin, { serverId: freshRun("sweep-import") });

    await cancel(stack, imported.jobId);
    await backdate(stack, imported.jobId);

    await sweepAll(stack);

    expect(await exists(stack, oldProbe)).toBe(false);
    expect(await exists(stack, oldProbeToo)).toBe(false);
    expect(await exists(stack, recentProbe)).toBe(true);
    expect(await exists(stack, scanJobId)).toBe(true);
    expect(await exists(stack, imported.jobId)).toBe(true);

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("delete at least one job per call when their messages hold over 16 MiB", async () => {
    if (stack === undefined) return;

    const count = 40;

    const jobIds = await runFunction(
      stack,
      internal.core.jobs.probe.enqueue,
      { kind: "probe.wide", run: freshRun("sweep-bytes"), count },
      Schema.Array(JobId),
    );

    // 40 messages of 512 KiB each, as jobs written before messages were bounded may hold.
    await inSequence(jobIds, async (jobId) => {
      await retrying(() => cancel(stack, jobId));
      await retrying(() => backdate(stack, jobId));
      await retrying(() =>
        runFunction(
          stack,
          internal.core.jobs.probe.inflate,
          { jobId, chars: 512 * 1024 },
          Schema.Null,
        ),
      );
    });

    const first = await retrying(() =>
      runFunction(stack, internal.core.jobs.cleanup.sweep, {}, Swept),
    );

    expect(first.jobs).toBeGreaterThanOrEqual(1);
    expect(first.more).toBe(true);

    await sweepAll(stack);

    const left = await Promise.all(jobIds.map(async (jobId) => exists(stack, jobId)));

    expect(left.filter(Boolean)).toEqual([]);
  });

  it("record a deleted failed trickplay job's failure on its file, so no file names it", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "sweep-trickplay", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Thumbnails");
    const [root] = roots;

    if (root === undefined) throw new Error("made no folder");

    const scan = await claimJob(stack, "movies.scan", scanJobId);
    const path = join(root, "film.mkv");

    const landed = await upsert(stack, scan, [
      movieFile(path, 5, 5, scannedTitle("movie", `file:${path}`, "Film"), true),
    ]);

    await finishJob(stack, scan);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const [file] = landed.value.files;

    if (file === undefined) throw new Error("no file landed");

    const fileState = () =>
      runFunction(stack, internal.movies.probe.fileState, { fileId: file.fileId }, TrickplayState);

    const queued = await fileState();
    const jobId = queued.trickplay?.jobId;

    if (jobId === undefined) throw new Error("the scan queued no thumbnails");

    const lease = await claimJob(stack, "movies.trickplay", jobId);

    await retrying(() =>
      runServer(
        stack,
        api.core.jobs.worker.finish,
        { lease, end: { outcome: "failed", error: "no frames", retry: false } },
        Canceled,
      ),
    );
    await backdate(stack, jobId);
    await sweepAll(stack);

    expect(await exists(stack, jobId)).toBe(false);
    expect((await fileState()).trickplay).toEqual({ status: "failed" });

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });
});
