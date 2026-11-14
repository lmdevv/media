import { describe, expect, it } from "vitest";

import type { JobItem } from "../../../convex/core/jobs/kinds";
import {
  CUT_MARK,
  ITEM_BATCH_MAX,
  JOB_TEXT_MAX,
  LAPSED_ERROR,
  pickClaim,
  RESTORED_ERROR,
  step,
} from "../../../convex/core/jobs/machine";
import type { JobEvent, Report, Step } from "../../../convex/core/jobs/machine";
import type { JobFields, JobWork } from "../../../convex/core/jobs/model";

const NOW = 1_000_000;

const LEASE_MS = 5000;

const policy = { maxStrikes: 3 };

const reported: JobWork = { mode: "reported", done: 0, total: null };

const noItems: JobWork = { mode: "items", done: 0, appended: 0, sealed: false };

const queued = (work: JobWork = reported): JobFields => ({
  status: "queued",
  payload: { kind: work.mode === "items" ? "probe.items" : "probe.wide", run: "unit", n: 0 },
  dedupeKey: null,
  attempts: 0,
  strikes: 0,
  work,
  message: null,
  lastError: null,
});

const items = (from: number, count: number): ReadonlyArray<JobItem> =>
  Array.from({ length: count }, (_, n) => ({ kind: "probe.items", n: from + n }));

const next = (result: Step): JobFields => {
  if (!result.ok) throw new Error(`The step was refused: ${result.refused}`);

  return result.next;
};

const run = (job: JobFields, event: JobEvent, at = NOW): JobFields =>
  next(step(job, event, at, policy));

const claim = (job: JobFields, at = NOW): JobFields =>
  run(job, { type: "claim", workerId: "worker", leaseMs: LEASE_MS }, at);

const report = (job: JobFields, fields: Omit<Report, "leaseMs"> = {}, at = NOW): Step =>
  step(
    job,
    { type: "report", lease: { attempt: job.attempts }, report: { leaseMs: LEASE_MS, ...fields } },
    at,
    policy,
  );

const lapse = (job: JobFields): JobFields => run(job, { type: "lapse" }, NOW + LEASE_MS + 1);

const fail = (job: JobFields, retry: boolean): JobFields =>
  run(job, {
    type: "finish",
    lease: { attempt: job.attempts },
    finish: { outcome: "failed", error: "boom", retry },
  });

const succeed = (job: JobFields): Step =>
  step(
    job,
    { type: "finish", lease: { attempt: job.attempts }, finish: { outcome: "succeeded" } },
    NOW,
    policy,
  );

describe("job machine", () => {
  it("claims a queued job as its next attempt with a fresh lease", () => {
    expect(claim(queued())).toMatchObject({
      status: "running",
      attempts: 1,
      workerId: "worker",
      leaseExpiresAt: NOW + LEASE_MS,
      progressed: false,
      cancelRequestedAt: null,
    });
  });

  it("refuses to claim a job that is not queued", () => {
    expect(
      step(claim(queued()), { type: "claim", workerId: "other", leaseMs: LEASE_MS }, NOW, policy),
    ).toEqual({ ok: false, refused: "notClaimable" });
  });

  it("treats a lease outside 5 s to 10 min as a defect", () => {
    expect(() =>
      step(queued(), { type: "claim", workerId: "worker", leaseMs: 1000 }, NOW, policy),
    ).toThrow(/lease lasts/);
  });

  it("renews the lease on every report", () => {
    const renewed = next(report(claim(queued()), {}, NOW + 3000));

    expect(renewed).toMatchObject({ status: "running", leaseExpiresAt: NOW + 3000 + LEASE_MS });
  });

  it("keeps a lease renewed after it expired but before the cron released it", () => {
    const running = claim(queued());
    const late = NOW + LEASE_MS + 2000;

    expect(next(report(running, {}, late))).toMatchObject({
      status: "running",
      attempts: 1,
      leaseExpiresAt: late + LEASE_MS,
    });
  });

  it("leaves a lease that has not expired, and releases one that has to the queue", () => {
    const running = claim(queued());

    expect(run(running, { type: "lapse" }, NOW + LEASE_MS - 1)).toBe(running);
    expect(lapse(running)).toMatchObject({
      status: "queued",
      attempts: 1,
      strikes: 1,
      lastError: LAPSED_ERROR,
    });
  });

  it("fails a job whose leases lapse three times without progress", () => {
    const once = lapse(claim(queued()));
    const twice = lapse(claim(once));
    const thrice = lapse(claim(twice));

    expect(thrice).toMatchObject({ status: "failed", attempts: 3, error: LAPSED_ERROR });
  });

  it("resets the strikes when a lapsed attempt moved its items forward", () => {
    const struck = lapse(claim(lapse(claim(queued(noItems)))));

    const progressed = next(
      report(claim(struck), { append: { from: 0, items: items(0, 3), sealed: false } }),
    );

    expect(struck.strikes).toBe(2);
    expect(lapse(progressed)).toMatchObject({ status: "queued", strikes: 0, attempts: 3 });
  });

  it("strikes a lapsed attempt that only reported counts, which a restart repeats", () => {
    const struck = lapse(claim(lapse(claim(queued()))));
    const reportedOnly = next(report(claim(struck), { progress: { done: 10, total: 100 } }));

    expect(reportedOnly).toMatchObject({ work: { done: 10, total: 100 }, progressed: false });
    expect(lapse(reportedOnly)).toMatchObject({ status: "failed", strikes: 3, attempts: 3 });
  });

  it("re-queues a failed attempt while strikes remain, then fails it", () => {
    const first = fail(claim(queued()), true);
    const second = fail(claim(first), true);
    const third = fail(claim(second), true);

    expect([first.status, second.status, third.status]).toEqual(["queued", "queued", "failed"]);
    expect(third).toMatchObject({ attempts: 3, error: "boom" });
  });

  it("counts a failure after progress as the first strike, forgiving earlier ones", () => {
    const struck = lapse(claim(lapse(claim(queued(noItems)))));

    const progressed = next(
      report(claim(struck), { append: { from: 0, items: items(0, 2), sealed: false } }),
    );

    expect(struck.strikes).toBe(2);
    expect(progressed.strikes).toBe(0);
    expect(fail(progressed, true)).toMatchObject({ status: "queued", strikes: 1, attempts: 3 });
  });

  it("fails at once when the worker asks for no retry", () => {
    expect(fail(claim(queued()), false)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("keeps a worker's message and error cut to 4,096 characters with a mark, never refusing one", () => {
    const huge = "e".repeat(1024 * 1024);
    const cutText = `${"e".repeat(JOB_TEXT_MAX - CUT_MARK.length)}${CUT_MARK}`;

    const finishFailed = (job: JobFields, retry: boolean) =>
      run(job, {
        type: "finish",
        lease: { attempt: job.attempts },
        finish: { outcome: "failed", error: huge, retry },
      });

    expect(finishFailed(claim(queued()), false)).toMatchObject({
      status: "failed",
      error: cutText,
    });
    expect(finishFailed(claim(queued()), true)).toMatchObject({
      status: "queued",
      lastError: cutText,
    });
    expect(next(report(claim(queued()), { message: huge }))).toMatchObject({ message: cutText });
    expect(
      run(claim(queued()), {
        type: "finish",
        lease: { attempt: 1 },
        finish: { outcome: "succeeded", message: huge },
      }),
    ).toMatchObject({ status: "succeeded", message: cutText });
    expect(next(report(claim(queued()), { message: "short" }))).toMatchObject({ message: "short" });

    const kept = JOB_TEXT_MAX - CUT_MARK.length;
    const split = `${"a".repeat(kept - 1)}😀${"z".repeat(JOB_TEXT_MAX)}`;

    // The cut falls inside the emoji's surrogate pair, so the emoji goes whole.
    expect(next(report(claim(queued()), { message: split }))).toMatchObject({
      message: `${"a".repeat(kept - 1)}${CUT_MARK}`,
    });
  });

  it("refuses a stale lease once the job went back to the queue or to another attempt", () => {
    const first = claim(queued());
    const released = lapse(first);
    const second = claim(released);

    expect(report(released)).toEqual({ ok: false, refused: "lost" });
    expect(
      step(
        second,
        { type: "report", lease: { attempt: 1 }, report: { leaseMs: LEASE_MS } },
        NOW,
        policy,
      ),
    ).toEqual({ ok: false, refused: "lost" });
    expect(
      step(
        second,
        { type: "finish", lease: { attempt: 1 }, finish: { outcome: "succeeded" } },
        NOW,
        policy,
      ),
    ).toEqual({ ok: false, refused: "lost" });
  });

  it("cancels a queued job at once", () => {
    expect(run(queued(), { type: "cancel", attempt: null })).toMatchObject({
      status: "canceled",
      finishedAt: NOW,
    });
  });

  it("keeps a canceled running job until its worker's next lease call answers canceled", () => {
    const requested = run(claim(queued()), { type: "cancel", attempt: null });
    const acked = next(report(requested));

    expect(requested).toMatchObject({ status: "running", cancelRequestedAt: NOW });
    expect(run(requested, { type: "cancel", attempt: null })).toBe(requested);
    expect(acked.status).toBe("canceled");
    expect(report(acked)).toEqual({ ok: false, refused: "canceled" });
    expect(run(acked, { type: "cancel", attempt: null })).toBe(acked);
  });

  it("ends a canceling job at a check, as at every lease call, and changes nothing else", () => {
    const running = claim(queued(noItems));

    const check = (job: JobFields, attempt = job.attempts): Step =>
      step(job, { type: "check", lease: { attempt } }, NOW, policy);

    expect(check(running)).toEqual({ ok: true, changed: false, next: running, writes: [] });
    expect(next(check(run(running, { type: "cancel", attempt: null })))).toMatchObject({
      status: "canceled",
      finishedAt: NOW,
    });
    expect(check(claim(lapse(running)), 1)).toEqual({ ok: false, refused: "lost" });
  });

  it("cancels only the attempt the canceller saw, and answers movedOn once another holds the job", () => {
    const first = claim(queued());
    const requeued = lapse(first);
    const second = claim(requeued, NOW + LEASE_MS + 2);

    const cancelAt = (job: JobFields, attempt: number): Step =>
      step(job, { type: "cancel", attempt }, NOW + LEASE_MS + 3, policy);

    expect(second.attempts).toBe(first.attempts + 1);
    expect(cancelAt(second, first.attempts)).toEqual({ ok: false, refused: "movedOn" });
    expect(next(cancelAt(second, second.attempts))).toMatchObject({
      status: "running",
      attempts: second.attempts,
      cancelRequestedAt: NOW + LEASE_MS + 3,
    });
    expect(next(cancelAt(requeued, first.attempts))).toMatchObject({ status: "canceled" });
    expect(next(cancelAt(queued(), 0)).status).toBe("canceled");

    const done = next(succeed(second));

    expect(cancelAt(done, first.attempts)).toEqual({
      ok: true,
      changed: false,
      next: done,
      writes: [],
    });
  });

  it("drops a canceling job's dedupe key, so a new job of the same key can be queued", () => {
    const running = claim({ ...queued(), dedupeKey: "probe.wide:x" });

    expect(run(running, { type: "cancel", attempt: null })).toMatchObject({
      status: "running",
      dedupeKey: null,
    });
  });

  it("cancels a canceling job whose lease lapses instead of re-queueing it", () => {
    expect(lapse(run(claim(queued()), { type: "cancel", attempt: null })).status).toBe("canceled");
  });

  it("answers a repeated finish of the same attempt with the same state and no writes", () => {
    const done = next(succeed(claim(queued())));

    expect(succeed(done)).toEqual({ ok: true, changed: false, next: done, writes: [] });
    expect(
      step(
        done,
        {
          type: "finish",
          lease: { attempt: 1 },
          finish: { outcome: "failed", error: "late", retry: true },
        },
        NOW,
        policy,
      ),
    ).toEqual({ ok: false, refused: "lost" });
  });

  it("answers a repeated retried failure with the queued state it already reached", () => {
    const requeued = fail(claim(queued()), true);

    expect(
      step(
        requeued,
        {
          type: "finish",
          lease: { attempt: 1 },
          finish: { outcome: "failed", error: "boom", retry: true },
        },
        NOW,
        policy,
      ),
    ).toEqual({ ok: true, changed: false, next: requeued, writes: [] });
  });

  it("appends items only at the job's count, and refuses a retried append", () => {
    const running = claim(queued(noItems));
    const result = report(running, { append: { from: 0, items: items(0, 3), sealed: false } });

    expect(result).toMatchObject({
      ok: true,
      next: { work: { mode: "items", done: 0, appended: 3, sealed: false }, progressed: true },
      writes: [{ type: "insert", from: 0, items: items(0, 3) }],
    });
    expect(
      report(next(result), { append: { from: 0, items: items(0, 3), sealed: false } }),
    ).toEqual({ ok: false, refused: "outOfOrder", appended: 3 });
  });

  it("accepts a repeated empty append that seals the items, and refuses items after the seal", () => {
    const sealed = next(
      report(claim(queued(noItems)), { append: { from: 0, items: [], sealed: true } }),
    );

    expect(next(report(sealed, { append: { from: 0, items: [], sealed: true } }))).toMatchObject({
      work: { appended: 0, sealed: true },
    });
    expect(() => report(sealed, { append: { from: 0, items: items(0, 1), sealed: true } })).toThrow(
      /after the items were sealed/,
    );
  });

  it("treats an oversized append or a watermark past the items as a defect", () => {
    const running = claim(queued(noItems));

    expect(() =>
      report(running, {
        append: { from: 0, items: items(0, ITEM_BATCH_MAX + 1), sealed: false },
      }),
    ).toThrow(/at most/);
    expect(() => report(running, { through: 1 })).toThrow(/past the 0 appended/);
  });

  it("moves the watermark and drops the done items", () => {
    const appended = next(
      report(claim(queued(noItems)), { append: { from: 0, items: items(0, 10), sealed: true } }),
    );

    expect(report(appended, { through: 4 })).toMatchObject({
      ok: true,
      next: { work: { mode: "items", done: 4, appended: 10, sealed: true } },
      writes: [{ type: "drop", from: 0, to: 4 }],
    });
  });

  it("succeeds an item job only when its items are sealed and done", () => {
    const open = next(
      report(claim(queued(noItems)), { append: { from: 0, items: items(0, 5), sealed: false } }),
    );

    const sealed = next(report(open, { append: { from: 5, items: [], sealed: true }, through: 5 }));

    expect(succeed(open)).toEqual({
      ok: false,
      refused: "unfinished",
      work: { mode: "items", done: 0, appended: 5, sealed: false },
    });
    expect(next(succeed(sealed)).status).toBe("succeeded");
  });

  it("purges the items left when an item job is canceled or fails", () => {
    const halfway = next(
      report(claim(queued(noItems)), {
        append: { from: 0, items: items(0, 10), sealed: true },
        through: 6,
      }),
    );

    expect(step(halfway, { type: "cancel", attempt: null }, NOW, policy)).toMatchObject({
      ok: true,
      next: { status: "running" },
      writes: [],
    });
    expect(report(run(halfway, { type: "cancel", attempt: null }))).toMatchObject({
      ok: true,
      next: { status: "canceled" },
      writes: [{ type: "purge", from: 6 }],
    });
    expect(
      step(
        halfway,
        {
          type: "finish",
          lease: { attempt: 1 },
          finish: { outcome: "failed", error: "boom", retry: false },
        },
        NOW,
        policy,
      ),
    ).toMatchObject({ ok: true, next: { status: "failed" }, writes: [{ type: "purge", from: 6 }] });
  });

  it("puts a job a restore caught running back in the queue at once, with no strike", () => {
    const running = claim(lapse(claim(queued(noItems))));

    const progressed = next(
      report(running, { append: { from: 0, items: items(0, 4), sealed: false }, through: 2 }),
    );

    const requeue = { type: "restored", end: { outcome: "requeue" } } as const;

    expect(run(running, requeue, NOW + 1)).toMatchObject({
      status: "queued",
      attempts: 2,
      strikes: 1,
      lastError: RESTORED_ERROR,
    });
    expect(step(progressed, requeue, NOW, policy)).toMatchObject({
      ok: true,
      next: {
        status: "queued",
        work: { mode: "items", done: 2, appended: 4, sealed: false },
        strikes: 0,
      },
      writes: [],
    });
    expect(claim(run(running, requeue))).toMatchObject({ status: "running", attempts: 3 });
    expect(run(run(running, { type: "cancel", attempt: null }), requeue).status).toBe("canceled");
  });

  it("ends a job whose result the restore is as succeeded, and leaves jobs not running", () => {
    const restoredOk = {
      type: "restored",
      end: { outcome: "succeed", message: "Restored" },
    } as const;

    const waiting = queued();
    const released = lapse(claim(queued()));

    expect(run(claim(queued()), restoredOk)).toMatchObject({
      status: "succeeded",
      finishedAt: NOW,
      message: "Restored",
    });
    expect(run(run(claim(queued()), { type: "cancel", attempt: null }), restoredOk).status).toBe(
      "succeeded",
    );
    expect(step(waiting, restoredOk, NOW, policy)).toEqual({
      ok: true,
      changed: false,
      next: waiting,
      writes: [],
    });
    expect(run(released, { type: "restored", end: { outcome: "requeue" } })).toBe(released);
  });

  it("claims the oldest queued job among kinds below their cap", () => {
    expect(
      pickClaim([
        { cap: 2, running: 2, head: { jobId: "full", createdAt: 1 } },
        { cap: 3, running: 1, head: { jobId: "newer", createdAt: 5 } },
        { cap: 1, running: 0, head: { jobId: "older", createdAt: 3 } },
      ]),
    ).toBe("older");
    expect(pickClaim([{ cap: 2, running: 2, head: { jobId: "full", createdAt: 1 } }])).toBeNull();
    expect(pickClaim([{ cap: 2, running: 0, head: null }])).toBeNull();
  });
});

const finishWith = (job: JobFields, end: Extract<JobEvent, { type: "finish" }>["finish"]) =>
  step(job, { type: "finish", lease: { attempt: job.attempts }, finish: end }, NOW, policy);

describe("step: deferred attempts and waiting retries", () => {
  it("puts a deferred attempt back in the queue with no strike, keeping its error", () => {
    const running = claim(queued());
    const back = next(finishWith(running, { outcome: "deferred", error: "429", pauseMs: 5000 }));

    expect(back).toMatchObject({ status: "queued", strikes: 0, attempts: 1, lastError: "429" });
    expect("waitUntil" in back).toBe(false);
  });

  it("answers a repeated deferral of the same attempt as settled, changing nothing", () => {
    const running = claim(queued());
    const back = next(finishWith(running, { outcome: "deferred", error: "429", pauseMs: 5000 }));

    expect(finishWith(back, { outcome: "deferred", error: "429", pauseMs: 5000 })).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it("makes a retry that asks to wait unclaimable until its time, with a strike", () => {
    const running = claim(queued());

    const waiting = next(
      finishWith(running, { outcome: "failed", error: "bad", retry: true, retryInMs: 60_000 }),
    );

    expect(waiting).toMatchObject({ status: "queued", strikes: 1, waitUntil: NOW + 60_000 });
  });

  it("fails a waiting retry for good on its last strike, without waiting", () => {
    const struck = { ...claim(queued()), strikes: policy.maxStrikes - 1 };

    expect(
      next(finishWith(struck, { outcome: "failed", error: "bad", retry: true, retryInMs: 60_000 })),
    ).toMatchObject({ status: "failed", error: "bad" });
  });

  it("wakes a waiting retry only when its time came and it waits for the attempt named", () => {
    const running = claim(queued());

    const waiting = next(
      finishWith(running, { outcome: "failed", error: "bad", retry: true, retryInMs: 60_000 }),
    );

    expect(step(waiting, { type: "wake", attempt: 1 }, NOW + 59_999, policy)).toMatchObject({
      changed: false,
    });
    expect(step(waiting, { type: "wake", attempt: 2 }, NOW + 60_000, policy)).toMatchObject({
      changed: false,
    });

    const woken = next(step(waiting, { type: "wake", attempt: 1 }, NOW + 60_000, policy));

    expect(woken).toMatchObject({ status: "queued", strikes: 1, attempts: 1, lastError: "bad" });
    expect("waitUntil" in woken).toBe(false);
    expect(next(step(waiting, { type: "wake", attempt: null }, NOW + 60_000, policy))).toEqual(
      woken,
    );
  });

  it("refuses a pause or a wait past a day as a defect", () => {
    const running = claim(queued());

    expect(() =>
      finishWith(running, { outcome: "deferred", error: "x", pauseMs: 25 * 3600 * 1000 }),
    ).toThrow(/waits 0 to/u);
    expect(() =>
      finishWith(running, { outcome: "failed", error: "x", retry: true, retryInMs: -1 }),
    ).toThrow(/waits 0 to/u);
  });
});
