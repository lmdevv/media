import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { LAPSED_ERROR } from "../../../convex/core/jobs/machine";
import { logMark, runFunction, usageSince } from "../../admin";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import {
  cancel,
  enqueue,
  eventually,
  freshKind,
  freshRun,
  inSequence,
  jobOf,
  probeItems,
  server,
  waitForJob,
  waiting,
  worker,
} from "./driver";
import type { Lease, ProbeKind, ProbeRunKind } from "./driver";

const stack = coreStackFromEnvFile();

const RELEASE_WITHIN_MS = 30_000;

const ITEMS = 50_000;

const BATCH = 4000;

const only = <Value>(values: ReadonlyArray<Value>): Value => {
  const [value] = values;

  if (value === undefined || values.length !== 1) {
    throw new Error(`Expected one value, got ${values.length}`);
  }

  return value;
};

const claimed = async (claim: Promise<Awaited<ReturnType<ReturnType<typeof worker>["claim"]>>>) => {
  const answer = await claim;

  if (answer.outcome !== "claimed") throw new Error("The worker claimed nothing");

  return answer;
};

const countOf = async (
  core: CoreStack,
  kind: ProbeKind,
  status: "queued" | "running",
): Promise<number> =>
  (
    await runFunction(
      core,
      internal.core.jobs.admin.list,
      { kind, status, paginationOpts: { numItems: 20, cursor: null } },
      Schema.Struct({ page: Schema.Array(Schema.Unknown) }),
    )
  ).page.length;

const runningOf = (core: CoreStack, kind: ProbeKind): Promise<number> =>
  countOf(core, kind, "running");

const hasItems = (core: CoreStack, jobId: Id<"jobs">): Promise<boolean> =>
  runFunction(core, internal.core.jobs.probe.hasItems, { jobId }, Schema.Boolean);

const claimAll = async (
  w: ReturnType<typeof worker>,
  kinds: ReadonlyArray<ProbeRunKind>,
  leases: ReadonlyArray<Lease> = [],
): Promise<ReadonlyArray<Lease>> => {
  const answer = await w.claim(kinds, 30_000);

  return answer.outcome === "idle" ? leases : claimAll(w, kinds, [...leases, answer.lease]);
};

const drain = async (
  core: CoreStack,
  kinds: ReadonlyArray<ProbeRunKind>,
  workers: number,
): Promise<{ readonly finished: number; readonly peaks: ReadonlyMap<string, number> }> => {
  const holding = new Map<string, Set<Id<"jobs">>>();
  const peaks = new Map<string, number>();

  const work = async (w: ReturnType<typeof worker>, finished: number): Promise<number> => {
    const answer = await w.claim(kinds, 30_000);

    if (answer.outcome === "idle") {
      const queued = await Promise.all(kinds.map((kind) => countOf(core, kind, "queued")));

      if (queued.every((count) => count === 0)) return finished;

      await sleep(25);

      return work(w, finished);
    }

    const { kind } = answer.payload;
    const held = holding.get(kind) ?? new Set<Id<"jobs">>();

    holding.set(kind, held.add(answer.lease.jobId));

    const listed = await runningOf(core, kind);

    peaks.set(kind, Math.max(peaks.get(kind) ?? 0, held.size, listed));
    await w.report(answer.lease);
    held.delete(answer.lease.jobId);
    await w.finish(answer.lease, { outcome: "succeeded" });

    return work(w, finished + 1);
  };

  const counts = await Promise.all(
    Array.from({ length: workers }, (_, n) => work(worker(core, freshRun(`drain-${n}`)), 0)),
  );

  return { finished: counts.reduce((sum, count) => sum + count, 0), peaks };
};

describe.skipIf(stack === undefined)("core jobs, live", { timeout: 180_000 }, () => {
  it("runs a probe job to succeeded", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.wide");

    const jobId = only(await enqueue(stack, "probe.wide", 1));
    const w = worker(stack, "happy");
    const { lease } = await claimed(w.claim(["probe.wide"]));

    expect(await w.report(lease, { progress: { done: 1, total: 1 } })).toMatchObject({
      outcome: "held",
    });
    expect(await w.finish(lease, { outcome: "succeeded" })).toEqual({
      outcome: "settled",
      status: "succeeded",
    });
    expect(await w.finish(lease, { outcome: "succeeded" })).toEqual({
      outcome: "settled",
      status: "succeeded",
    });
    expect(await jobOf(stack, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      done: 1,
      total: 1,
    });
  });

  it("gives a job whose worker stopped renewing to another worker, and fences the first", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.wide");

    const jobId = only(await enqueue(stack, "probe.wide", 1));
    const a = worker(stack, "stops");
    const b = worker(stack, "takes-over");
    const first = await claimed(a.claim(["probe.wide"]));

    const released = await waitForJob(
      stack,
      jobId,
      (job) => job.status === "queued",
      RELEASE_WITHIN_MS,
    );

    expect(released).toMatchObject({ attempts: 1, error: LAPSED_ERROR });

    const second = await claimed(b.claim(["probe.wide"], 30_000));

    expect(second.lease.attempt).toBe(2);
    expect(await a.report(first.lease)).toEqual({ outcome: "lost" });
    expect(await a.finish(first.lease, { outcome: "succeeded" })).toEqual({ outcome: "lost" });
    expect(await b.finish(second.lease, { outcome: "succeeded" })).toEqual({
      outcome: "settled",
      status: "succeeded",
    });
    expect((await jobOf(stack, jobId)).status).toBe("succeeded");
  });

  it("never runs more than 2 of 10 jobs capped at 2, with 5 workers racing", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.capped");
    await enqueue(stack, "probe.capped", 10);

    const w = worker(stack, "capped");
    const claims = await claimAll(w, ["probe.capped"]);

    expect(claims).toHaveLength(2);
    expect(await waiting(stack, ["probe.capped"])).toEqual([
      { kind: "probe.capped", free: 0, ready: false },
    ]);

    await Promise.all(claims.map((lease) => w.finish(lease, { outcome: "succeeded" })));

    const { finished, peaks } = await drain(stack, ["probe.capped"], 5);

    expect(finished).toBe(8);
    expect(peaks.get("probe.capped")).toBeLessThanOrEqual(2);
    expect(await runningOf(stack, "probe.capped")).toBe(0);
  });

  it("keeps each kind's own cap when one worker claims two kinds", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.capped");
    await freshKind(stack, "probe.wide");
    await enqueue(stack, "probe.capped", 10);
    await enqueue(stack, "probe.wide", 10);

    const w = worker(stack, "two-kinds");
    const claims = await claimAll(w, ["probe.capped", "probe.wide"]);

    expect(claims).toHaveLength(6);
    expect(await runningOf(stack, "probe.capped")).toBe(2);
    expect(await runningOf(stack, "probe.wide")).toBe(4);
    expect(await waiting(stack, ["probe.capped", "probe.wide"])).toEqual([
      { kind: "probe.capped", free: 0, ready: false },
      { kind: "probe.wide", free: 0, ready: false },
    ]);

    await Promise.all(claims.map((lease) => w.finish(lease, { outcome: "succeeded" })));

    const { finished, peaks } = await drain(stack, ["probe.capped", "probe.wide"], 8);

    expect(finished).toBe(14);
    expect(peaks.get("probe.capped")).toBeLessThanOrEqual(2);
    expect(peaks.get("probe.wide")).toBeLessThanOrEqual(4);
    expect(await runningOf(stack, "probe.wide")).toBe(0);
  });

  it("ends a canceled running job canceled at its worker's next call", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.wide");

    const [runningId, queuedId] = await enqueue(stack, "probe.wide", 2);

    if (runningId === undefined || queuedId === undefined) throw new Error("Two jobs were queued");

    const w = worker(stack, "canceled");
    const { lease } = await claimed(w.claim(["probe.wide"], 30_000));

    expect(lease.jobId).toBe(runningId);
    expect(await cancel(stack, runningId)).toEqual({ outcome: "canceling" });
    expect(await jobOf(stack, runningId)).toMatchObject({ status: "running", canceling: true });
    expect(only(await waiting(stack, ["probe.wide"])).free).toBe(3);
    expect(await w.report(lease)).toEqual({ outcome: "canceled" });
    expect(await w.report(lease)).toEqual({ outcome: "canceled" });
    expect(await jobOf(stack, runningId)).toMatchObject({ status: "canceled", canceling: false });

    expect(await cancel(stack, queuedId)).toEqual({ outcome: "finished", status: "canceled" });
    expect(await cancel(stack, queuedId)).toEqual({ outcome: "finished", status: "canceled" });
    expect(only(await waiting(stack, ["probe.wide"]))).toMatchObject({ free: 4, ready: false });
  });

  it("fails a job after three failed attempts", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.wide");

    const jobId = only(await enqueue(stack, "probe.wide", 1));
    const w = worker(stack, "fails");

    const statuses = await inSequence([1, 2, 3], async () => {
      const { lease } = await claimed(w.claim(["probe.wide"]));

      return w.finish(lease, { outcome: "failed", error: "boom", retry: true });
    });

    expect(statuses).toEqual([
      { outcome: "settled", status: "queued" },
      { outcome: "settled", status: "queued" },
      { outcome: "settled", status: "failed" },
    ]);
    expect(await jobOf(stack, jobId)).toMatchObject({
      status: "failed",
      attempts: 3,
      error: "boom",
    });
    expect(await w.claim(["probe.wide"])).toEqual({ outcome: "idle" });
  });

  it("succeeds a sealed item job once every item is done", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.items");

    const jobId = only(await enqueue(stack, "probe.items", 1));
    const w = worker(stack, "items-small");
    const { lease } = await claimed(w.claim(["probe.items"]));

    await w.report(lease, { append: { from: 0, items: probeItems(0, 10), sealed: true } });

    expect(await w.items(lease, 4, 3)).toEqual({
      outcome: "held",
      items: [4, 5, 6].map((n) => ({ seq: n, item: { kind: "probe.items", n } })),
    });
    expect(await w.finish(lease, { outcome: "succeeded" })).toMatchObject({
      outcome: "unfinished",
    });

    await w.report(lease, { through: 10 });

    expect(await w.finish(lease, { outcome: "succeeded" })).toEqual({
      outcome: "settled",
      status: "succeeded",
    });
    expect(await jobOf(stack, jobId)).toMatchObject({ status: "succeeded", done: 10, total: 10 });
    expect(await hasItems(stack, jobId)).toBe(false);
  });

  it("runs a 50,000-item job without any call writing more than 16,000 documents", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.items");

    const jobId = only(await enqueue(stack, "probe.items", 1));
    const w = worker(stack, "items-large");
    const mark = await logMark(stack);
    const { lease } = await claimed(w.claim(["probe.items"], 60_000));
    const froms = Array.from({ length: Math.ceil(ITEMS / BATCH) }, (_, n) => n * BATCH);
    const throughs = [4000, 8000, 12_000, 16_000, 20_000, 24_000, 28_000, 30_000];

    const appended = await inSequence(froms, (from) => {
      const count = Math.min(BATCH, ITEMS - from);

      return w.report(lease, {
        leaseMs: 60_000,
        append: { from, items: probeItems(from, count), sealed: from + count === ITEMS },
      });
    });

    expect(appended.every((answer) => answer.outcome === "held")).toBe(true);
    expect(
      await w.report(lease, { append: { from: 0, items: probeItems(0, 1), sealed: false } }),
    ).toEqual({ outcome: "outOfOrder", appended: ITEMS });
    expect(
      await inSequence(throughs, (through) => w.report(lease, { leaseMs: 60_000, through })),
    ).toMatchObject(
      throughs.map((through) => ({
        outcome: "held",
        work: { mode: "items", done: through, appended: ITEMS, sealed: true },
      })),
    );
    expect(await w.finish(lease, { outcome: "succeeded" })).toMatchObject({
      outcome: "unfinished",
    });
    expect(await cancel(stack, jobId)).toEqual({ outcome: "canceling" });
    expect(await w.report(lease)).toEqual({ outcome: "canceled" });

    await eventually(
      "the leftover items to be purged",
      async () => ((await hasItems(stack, jobId)) ? null : true),
      60_000,
    );

    const writes = [
      ...(await usageSince(stack, mark, server.report, froms.length + throughs.length + 2)),
      ...(await usageSince(stack, mark, internal.core.jobs.leases.purgeItems, 5)),
    ];

    expect(Math.max(...writes.map((call) => call.writes))).toBeLessThanOrEqual(16_000);
    expect(Math.max(...writes.map((call) => call.writes))).toBeGreaterThanOrEqual(BATCH);
    expect(Math.max(...writes.map((call) => call.reads))).toBeLessThanOrEqual(32_000);
    expect(await jobOf(stack, jobId)).toMatchObject({ status: "canceled", done: 30_000 });
  });

  it("keeps one active import per server and dedupes its enqueue", async () => {
    if (stack === undefined) return;

    await freshKind(stack, "probe.import");

    const den = { source: "jellyfin" as const, serverId: freshRun("server"), serverName: "Den" };

    const Started = Schema.Struct({
      importId: Schema.String,
      jobId: Schema.String,
      created: Schema.Boolean,
    });

    const start = (serverId = den.serverId) =>
      runFunction(stack, internal.core.imports.probeStart, { ...den, serverId }, Started);

    const first = await start();
    const queuedAgain = await start();
    const other = await start(freshRun("other"));

    expect(first.created).toBe(true);
    expect(queuedAgain).toEqual({ ...first, created: false });
    expect(other.jobId).not.toBe(first.jobId);

    const w = worker(stack, "imports");
    const { lease } = await claimed(w.claim(["probe.import"], 30_000));

    expect(lease.jobId).toBe(first.jobId);
    expect(await start()).toEqual({ ...first, created: false });

    await w.finish(lease, { outcome: "succeeded" });

    const next = await start();

    expect(next.created).toBe(true);
    expect(next.jobId).not.toBe(first.jobId);

    const listed = await runFunction(
      stack,
      internal.core.imports.listByServer,
      {
        source: den.source,
        serverId: den.serverId,
        paginationOpts: { numItems: 10, cursor: null },
      },
      Schema.Struct({ page: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    );

    expect(listed.page.map((row) => row.id)).toEqual([next.importId, first.importId]);
  });
});
