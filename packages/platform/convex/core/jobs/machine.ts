import type { JobItem } from "./kinds";
import type { JobCommon, JobFields, JobWork, Lease } from "./model";

type Attempt = Pick<Lease, "attempt">;

export const LEASE_MS_MIN = 5000;

export const LEASE_MS_MAX = 600_000;

export const ITEM_BATCH_MAX = 4000;

export const LAPSED_ERROR = "The worker stopped responding";

export interface Policy {
  readonly maxStrikes: number;
}

/** What a holder sends with a report. Every field but the lease length is optional. */
export interface Report {
  readonly leaseMs: number;
  readonly message?: string;
  /** Reported kinds only. */
  readonly progress?: { readonly done: number; readonly total: number | null };
  /** Item kinds only: items numbered from `from`, which must equal the job's `appended`. */
  readonly append?: {
    readonly from: number;
    readonly items: ReadonlyArray<JobItem>;
    readonly sealed: boolean;
  };
  /** Item kinds only: every item below `through` is done. At or below the watermark, a no-op. */
  readonly through?: number;
}

export type Finish =
  | { readonly outcome: "succeeded"; readonly message?: string }
  | {
      readonly outcome: "failed";
      readonly error: string;
      /** Back to the queue while strikes remain; false fails the job now. */
      readonly retry: boolean;
    };

export type JobEvent =
  | { readonly type: "claim"; readonly workerId: string; readonly leaseMs: number }
  | { readonly type: "report"; readonly lease: Attempt; readonly report: Report }
  | { readonly type: "finish"; readonly lease: Attempt; readonly finish: Finish }
  | { readonly type: "cancel" }
  | { readonly type: "lapse" };

export type ItemWrite =
  /** Delete the done items with `from <= seq < to`. */
  | { readonly type: "drop"; readonly from: number; readonly to: number }
  /** Insert `items` with seq numbers from `from`. */
  | { readonly type: "insert"; readonly from: number; readonly items: ReadonlyArray<JobItem> }
  /** Schedule `leases.purgeItems` for a finished job's items from `from` up. */
  | { readonly type: "purge"; readonly from: number };

type ItemsWork = Extract<JobWork, { mode: "items" }>;

export type Refusal =
  /** The job was canceled at this attempt; the worker stops. */
  | { readonly refused: "canceled" }
  /** Another attempt holds the job, or it went back to the queue, or it finished otherwise. */
  | { readonly refused: "lost" }
  /** An append whose `from` is not `appended`: the worker resyncs from the returned count. */
  | { readonly refused: "outOfOrder"; readonly appended: number }
  /** A success of an item kind with items unsealed or not done. */
  | { readonly refused: "unfinished"; readonly work: ItemsWork }
  /** A claim of a job that is not queued. */
  | { readonly refused: "notClaimable" };

export type Step =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly next: JobFields;
      readonly writes: ReadonlyArray<ItemWrite>;
    }
  | ({ readonly ok: false } & Refusal);

type Running = Extract<JobFields, { status: "running" }>;

const commonOf = (job: JobFields): JobCommon => ({
  payload: job.payload,
  dedupeKey: job.dedupeKey,
  attempts: job.attempts,
  strikes: job.strikes,
  work: job.work,
  message: job.message,
});

const unchanged = (job: JobFields): Step => ({ ok: true, changed: false, next: job, writes: [] });

const moved = (next: JobFields, writes: ReadonlyArray<ItemWrite> = []): Step => ({
  ok: true,
  changed: true,
  next,
  writes,
});

const refuse = (refusal: Refusal): Step => ({ ok: false, ...refusal });

const purgeOf = (work: JobWork): ReadonlyArray<ItemWrite> =>
  work.mode === "items" && work.appended > work.done ? [{ type: "purge", from: work.done }] : [];

const checkLeaseMs = (leaseMs: number): void => {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < LEASE_MS_MIN || leaseMs > LEASE_MS_MAX) {
    throw new Error(`A lease lasts ${LEASE_MS_MIN} to ${LEASE_MS_MAX} ms; got ${leaseMs}`);
  }
};

const canceled = (job: Running, now: number): Step =>
  moved({ ...commonOf(job), status: "canceled", finishedAt: now }, purgeOf(job.work));

/**
 * Whether `lease` holds `job`: the one fencing rule. Held means running at the lease's attempt; a
 * requested cancel still holds, and the caller decides whether to answer it. A job canceled at the
 * lease's attempt answers `canceled`; anything else is `lost`, including a job back in the queue at
 * the same attempt count.
 */
export const holds = (
  job: JobFields,
  lease: Attempt,
):
  | { readonly held: true; readonly job: Running }
  | { readonly held: false; readonly refused: "canceled" | "lost" } => {
  if (job.attempts !== lease.attempt) return { held: false, refused: "lost" };

  if (job.status === "running") return { held: true, job };

  return { held: false, refused: job.status === "canceled" ? "canceled" : "lost" };
};

interface WorkUpdate {
  readonly work: JobWork;
  readonly progressed: boolean;
  readonly writes: ReadonlyArray<ItemWrite>;
}

const reportedWork = (work: Extract<JobWork, { mode: "reported" }>, report: Report): WorkUpdate => {
  if (report.append !== undefined || report.through !== undefined) {
    throw new Error("A reported job takes progress, not items");
  }

  if (report.progress === undefined) return { work, progressed: false, writes: [] };

  return {
    work: { mode: "reported", done: report.progress.done, total: report.progress.total },
    progressed: false,
    writes: [],
  };
};

const itemsWork = (job: Running, work: ItemsWork, report: Report): WorkUpdate | Refusal => {
  if (report.progress !== undefined) throw new Error("An item job takes items, not progress");

  const writes: Array<ItemWrite> = [];
  let next = work;

  if (report.append !== undefined) {
    const { from, items, sealed } = report.append;

    if (from !== work.appended) return { refused: "outOfOrder", appended: work.appended };

    if (work.sealed) throw new Error("An append after the items were sealed");

    if (items.length > ITEM_BATCH_MAX) {
      throw new Error(`A report appends at most ${ITEM_BATCH_MAX} items; got ${items.length}`);
    }

    if (items.some((item) => item.kind !== job.payload.kind)) {
      throw new Error(`An append of items of another kind to a ${job.payload.kind} job`);
    }

    if (items.length > 0) writes.push({ type: "insert", from, items });

    next = { ...next, appended: from + items.length, sealed };
  }

  if (report.through !== undefined && report.through > next.done) {
    const { through } = report;

    if (!Number.isSafeInteger(through) || through > next.appended) {
      throw new Error(`Items done through ${through}, past the ${next.appended} appended`);
    }

    if (through - next.done > ITEM_BATCH_MAX) {
      throw new Error(
        `A report completes at most ${ITEM_BATCH_MAX} items; got ${through - next.done}`,
      );
    }

    writes.push({ type: "drop", from: next.done, to: through });
    next = { ...next, done: through };
  }

  return {
    work: next,
    progressed: next.appended > work.appended || next.done > work.done,
    writes,
  };
};

const report = (job: Running, event: Report, now: number): Step => {
  checkLeaseMs(event.leaseMs);

  const result =
    job.work.mode === "reported" ? reportedWork(job.work, event) : itemsWork(job, job.work, event);

  if ("refused" in result) return refuse(result);

  return moved(
    {
      ...job,
      work: result.work,
      message: event.message ?? job.message,
      leaseExpiresAt: now + event.leaseMs,
      progressed: job.progressed || result.progressed,
    },
    result.writes,
  );
};

const failed = (job: Running, error: string, strikes: number, now: number): Step =>
  moved({ ...commonOf(job), strikes, status: "failed", finishedAt: now, error }, purgeOf(job.work));

const finish = (job: Running, end: Finish, now: number, policy: Policy): Step => {
  if (end.outcome === "succeeded") {
    const { work } = job;

    if (work.mode === "items" && !(work.sealed && work.done === work.appended)) {
      return refuse({ refused: "unfinished", work });
    }

    return moved({
      ...commonOf(job),
      message: end.message ?? job.message,
      status: "succeeded",
      finishedAt: now,
    });
  }

  const strikes = job.strikes + 1;

  if (end.retry && strikes < policy.maxStrikes) {
    return moved({ ...commonOf(job), strikes, status: "queued", lastError: end.error });
  }

  return failed(job, end.error, strikes, now);
};

const lapse = (job: Running, now: number, policy: Policy): Step => {
  if (job.leaseExpiresAt > now) return unchanged(job);

  if (job.cancelRequestedAt !== null) return canceled(job, now);

  const strikes = job.progressed ? 0 : job.strikes + 1;

  if (strikes >= policy.maxStrikes) return failed(job, LAPSED_ERROR, strikes, now);

  return moved({ ...commonOf(job), strikes, status: "queued", lastError: LAPSED_ERROR });
};

const settledAlready = (job: JobFields, end: Finish): boolean =>
  (job.status === "succeeded" && end.outcome === "succeeded") ||
  (job.status === "failed" && end.outcome === "failed");

/**
 * The one transition function.
 *
 * @throws Error on a defect no validator catches: a lease length outside 5 s to 10 min, a report
 * that mixes item and reported progress, an append past the seal or of another kind's items, more
 * than `ITEM_BATCH_MAX` items, or a `through` past `appended`.
 */
export const step = (job: JobFields, event: JobEvent, now: number, policy: Policy): Step => {
  if (event.type === "claim") {
    if (job.status !== "queued") return refuse({ refused: "notClaimable" });

    checkLeaseMs(event.leaseMs);

    return moved({
      ...commonOf(job),
      attempts: job.attempts + 1,
      status: "running",
      workerId: event.workerId,
      leaseExpiresAt: now + event.leaseMs,
      claimedAt: now,
      progressed: false,
      cancelRequestedAt: null,
    });
  }

  if (event.type === "cancel") {
    if (job.status === "queued") {
      return moved({ ...commonOf(job), status: "canceled", finishedAt: now }, purgeOf(job.work));
    }

    return job.status === "running" && job.cancelRequestedAt === null
      ? moved({ ...job, cancelRequestedAt: now })
      : unchanged(job);
  }

  if (event.type === "lapse") {
    return job.status === "running" ? lapse(job, now, policy) : unchanged(job);
  }

  if (
    event.type === "finish" &&
    job.attempts === event.lease.attempt &&
    settledAlready(job, event.finish)
  ) {
    return unchanged(job);
  }

  const held = holds(job, event.lease);

  if (!held.held) return refuse({ refused: held.refused });

  if (held.job.cancelRequestedAt !== null) return canceled(held.job, now);

  return event.type === "report"
    ? report(held.job, event.report, now)
    : finish(held.job, event.finish, now, policy);
};

export interface KindQueue<JobId> {
  readonly cap: number;
  readonly running: number;
  readonly head: { readonly jobId: JobId; readonly createdAt: number } | null;
}

/**
 * The cap rule: the oldest queued job among kinds below their cap, or null. A full kind offers
 * nothing, so its queued jobs never block another kind's.
 */
export const pickClaim = <JobId>(queues: ReadonlyArray<KindQueue<JobId>>): JobId | null => {
  let best: KindQueue<JobId>["head"] = null;

  for (const queue of queues) {
    if (
      queue.running < queue.cap &&
      queue.head !== null &&
      (best === null || queue.head.createdAt < best.createdAt)
    ) {
      best = queue.head;
    }
  }

  return best?.jobId ?? null;
};

export const progressOf = (
  work: JobWork,
): { readonly done: number; readonly total: number | null } =>
  work.mode === "reported"
    ? { done: work.done, total: work.total }
    : { done: work.done, total: work.sealed ? work.appended : null };
