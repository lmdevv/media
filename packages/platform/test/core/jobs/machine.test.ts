import { describe, expect, it } from "vitest";

import type { JobItem } from "../../../convex/core/jobs/kinds";
import { ITEM_BATCH_MAX, LAPSED_ERROR, pickClaim, step } from "../../../convex/core/jobs/machine";
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

  it("resets the strikes when a lapsed attempt made progress", () => {
    const struck = lapse(claim(lapse(claim(queued()))));
    const progressed = next(report(claim(struck), { progress: { done: 10, total: 100 } }));

    expect(struck.strikes).toBe(2);
    expect(lapse(progressed)).toMatchObject({ status: "queued", strikes: 0, attempts: 3 });
  });

  it("re-queues a failed attempt while strikes remain, then fails it", () => {
    const first = fail(claim(queued()), true);
    const second = fail(claim(first), true);
    const third = fail(claim(second), true);

    expect([first.status, second.status, third.status]).toEqual(["queued", "queued", "failed"]);
    expect(third).toMatchObject({ attempts: 3, error: "boom" });
  });

  it("fails at once when the worker asks for no retry", () => {
    expect(fail(claim(queued()), false)).toMatchObject({ status: "failed", attempts: 1 });
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
    expect(run(queued(), { type: "cancel" })).toMatchObject({
      status: "canceled",
      finishedAt: NOW,
    });
  });

  it("keeps a canceled running job until its worker's next lease call answers canceled", () => {
    const requested = run(claim(queued()), { type: "cancel" });
    const acked = next(report(requested));

    expect(requested).toMatchObject({ status: "running", cancelRequestedAt: NOW });
    expect(run(requested, { type: "cancel" })).toBe(requested);
    expect(acked.status).toBe("canceled");
    expect(report(acked)).toEqual({ ok: false, refused: "canceled" });
    expect(run(acked, { type: "cancel" })).toBe(acked);
  });

  it("cancels a canceling job whose lease lapses instead of re-queueing it", () => {
    expect(lapse(run(claim(queued()), { type: "cancel" })).status).toBe("canceled");
  });

  it("answers a repeated finish of the same attempt with the same state and no writes", () => {
    const done = next(succeed(claim(queued())));

    expect(succeed(done)).toEqual({ ok: true, next: done, writes: [] });
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

    expect(step(halfway, { type: "cancel" }, NOW, policy)).toMatchObject({
      ok: true,
      next: { status: "running" },
      writes: [],
    });
    expect(report(run(halfway, { type: "cancel" }))).toMatchObject({
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
