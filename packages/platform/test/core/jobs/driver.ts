/**
 * A test worker that speaks the server's job protocol over the admin key. A worker that stops
 * calling is what the cron sees when a server process dies.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { FunctionArgs } from "convex/server";
import { Schema } from "effect";

import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { kindDef } from "../../../convex/core/jobs/kinds";
import { FunctionRefused, runFunction } from "../../admin";
import type { CoreStack } from "../../stack-env";

/** The server functions. p3-auth repoints this at `api.core.jobs.worker` with a service session. */
export const server = internal.core.jobs.worker;

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as a `jobs` id; the backend's `v.id("jobs")` validators check it again
// whenever a test sends it back.
const isJobId = (value: unknown): value is Id<"jobs"> => Schema.is(Schema.String)(value);

const JobId = Schema.declare(isJobId);

const Lease = Schema.Struct({ jobId: JobId, attempt: Schema.Finite });

export type Lease = typeof Lease.Type;

const Work = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("reported"),
    done: Schema.Finite,
    total: Schema.NullOr(Schema.Finite),
  }),
  Schema.Struct({
    mode: Schema.Literal("items"),
    done: Schema.Finite,
    appended: Schema.Finite,
    sealed: Schema.Boolean,
  }),
]);

const Refused = Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) });

const Claim = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("claimed"),
    lease: Lease,
    leaseExpiresAt: Schema.Finite,
    payload: Schema.Struct({
      kind: Schema.Literals(["probe.capped", "probe.wide", "probe.items", "probe.import"]),
    }),
    work: Work,
  }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const Reported = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("held"), leaseExpiresAt: Schema.Finite, work: Work }),
  Schema.Struct({ outcome: Schema.Literal("outOfOrder"), appended: Schema.Finite }),
  Refused,
]);

const Finished = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("settled"),
    status: Schema.Literals(["succeeded", "failed", "queued"]),
  }),
  Schema.Struct({ outcome: Schema.Literal("unfinished"), work: Work }),
  Refused,
]);

const Items = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("held"),
    items: Schema.Array(Schema.Struct({ seq: Schema.Finite, item: Schema.Unknown })),
  }),
  Refused,
]);

const JobView = Schema.Struct({
  id: JobId,
  status: Schema.Literals(["queued", "running", "succeeded", "failed", "canceled"]),
  attempts: Schema.Finite,
  done: Schema.Finite,
  total: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  canceling: Schema.Boolean,
});

export type JobView = typeof JobView.Type;

const Waiting = Schema.Array(
  Schema.Struct({ kind: Schema.String, free: Schema.Finite, ready: Schema.Boolean }),
);

export type ProbeRunKind = "probe.capped" | "probe.wide" | "probe.items";

export type ProbeKind = ProbeRunKind | "probe.import";

const LEASE_MS = 5000;

export const freshRun = (label: string): string =>
  `${label}-${Math.random().toString(36).slice(2, 8)}`;

export const waiting = (stack: CoreStack, kinds: ReadonlyArray<ProbeKind>) =>
  runFunction(stack, server.waiting, { kinds: [...kinds] }, Waiting);

export const jobOf = async (stack: CoreStack, jobId: Id<"jobs">): Promise<JobView> => {
  const job = await runFunction(
    stack,
    internal.core.jobs.admin.get,
    { jobId },
    Schema.NullOr(JobView),
  );

  if (job === null) throw new Error(`Job ${jobId} is gone`);

  return job;
};

/** Polls until `ready` answers a value, or throws after `timeoutMs`. */
export const eventually = async <Value>(
  what: string,
  ready: () => Promise<Value | null>,
  timeoutMs = 30_000,
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;

  const poll = async (): Promise<Value> => {
    const value = await ready();

    if (value !== null) return value;

    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);

    await sleep(250);

    return poll();
  };

  return poll();
};

/** Runs `run` on each item, one after another, and returns the results in order. */
export const inSequence = async <Item, Result>(
  items: ReadonlyArray<Item>,
  run: (item: Item) => Promise<Result>,
  done: ReadonlyArray<Result> = [],
): Promise<ReadonlyArray<Result>> => {
  if (done.length === items.length) return done;

  const item = items[done.length];

  if (item === undefined) throw new Error(`No item at ${done.length}`);

  return inSequence(items, run, [...done, await run(item)]);
};

/** Polls a job until `done` holds for it. */
export const waitForJob = (
  stack: CoreStack,
  jobId: Id<"jobs">,
  done: (job: JobView) => boolean,
  timeoutMs?: number,
): Promise<JobView> =>
  eventually(
    `job ${jobId}`,
    async () => {
      const job = await jobOf(stack, jobId);

      return done(job) ? job : null;
    },
    timeoutMs,
  );

/**
 * Empties a probe kind: cancels its queued jobs and waits until no job of it runs, whatever an
 * aborted earlier run left (a running job frees its slot when its lease lapses).
 */
export const freshKind = async (stack: CoreStack, kind: ProbeKind): Promise<void> => {
  const { more } = await runFunction(
    stack,
    internal.core.jobs.probe.reset,
    { kind },
    Schema.Struct({ more: Schema.Boolean }),
  );

  if (more) return freshKind(stack, kind);

  const { cap } = kindDef(kind);

  await eventually(
    `${kind} to drain`,
    async () => {
      const [state] = await waiting(stack, [kind]);

      return state?.free === cap && !state.ready ? state : null;
    },
    90_000,
  );
};

/** Queues `count` jobs of a probe kind for one run, and returns their ids in queue order. */
export const enqueue = (
  stack: CoreStack,
  kind: ProbeRunKind,
  count: number,
): Promise<ReadonlyArray<Id<"jobs">>> =>
  runFunction(
    stack,
    internal.core.jobs.probe.enqueue,
    { kind, run: freshRun(kind), count },
    Schema.Array(JobId),
  );

export const cancel = (stack: CoreStack, jobId: Id<"jobs">) =>
  runFunction(
    stack,
    internal.core.jobs.admin.cancel,
    { jobId },
    Schema.Struct({ outcome: Schema.String, status: Schema.optionalKey(Schema.String) }),
  );

export type ReportFields = Omit<FunctionArgs<typeof server.report>, "lease" | "leaseMs"> & {
  readonly leaseMs?: number;
};

export type End = FunctionArgs<typeof server.finish>["end"];

/** `count` probe items numbered from `from`. */
export const probeItems = (from: number, count: number) =>
  Array.from({ length: count }, (_, n) => ({ kind: "probe.items" as const, n: from + n }));

/** Refusals that commit nothing, so the worker sends the same call again. */
const RETRIED = new Set(["OptimisticConcurrencyControlFailure", "TooManyWrites"]);

/**
 * Sends a worker call, retrying a refusal that committed nothing, as the server's pool will:
 * Convex gives up on a mutation whose reads keep changing under it, and the deployment caps
 * writes at 4 MiB a second. A report's `append.from` guard keeps a retry from duplicating items.
 */
const retrying = async <Value>(send: () => Promise<Value>, attempt = 1): Promise<Value> => {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof FunctionRefused) || error.code === null || !RETRIED.has(error.code)) {
      throw error;
    }

    if (attempt >= 20) throw error;

    await sleep(100 * attempt + Math.random() * 100);

    return retrying(send, attempt + 1);
  }
};

/** One test worker: a fixed id and the protocol calls, nothing else. */
export const worker = (stack: CoreStack, workerId: string) => ({
  claim: (kinds: ReadonlyArray<ProbeKind>, leaseMs = LEASE_MS) =>
    retrying(() =>
      runFunction(stack, server.claim, { kinds: [...kinds], workerId, leaseMs }, Claim),
    ),
  report: (lease: Lease, fields: ReportFields = {}) =>
    retrying(() =>
      runFunction(stack, server.report, { leaseMs: LEASE_MS, ...fields, lease }, Reported),
    ),
  items: (lease: Lease, from: number, limit: number) =>
    runFunction(stack, server.items, { lease, from, limit }, Items),
  finish: (lease: Lease, end: End) =>
    retrying(() => runFunction(stack, server.finish, { lease, end }, Finished)),
});
