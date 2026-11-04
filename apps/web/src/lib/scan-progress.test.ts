import { Job } from "@media/contracts/models/jobs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { scanProgress } from "./scan-progress";

const job = (overrides: Partial<typeof Job.Encoded>): Job =>
  Schema.decodeSync(Job)({
    id: "job1",
    kind: "scan",
    status: "running",
    payload: { kind: "scan", libraryId: "lib1", mode: "full" },
    progress: { done: 0, total: null, message: null },
    error: null,
    requestedBy: null,
    attempts: 1,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
    ...overrides,
  });

describe("scan progress", () => {
  it("has no fraction or estimate until the total is known", () => {
    expect(scanProgress(job({}), 10_000)).toEqual({
      fraction: null,
      done: 0,
      total: null,
      minutesLeft: null,
    });
  });

  it("estimates minutes left from the pace so far", () => {
    const progress = scanProgress(
      job({ progress: { done: 100, total: 400, message: null } }),
      120_000,
    );

    expect(progress.fraction).toBe(0.25);
    expect(progress.minutesLeft).toBe(6);
  });

  it("reports a finished scan as complete", () => {
    expect(scanProgress(job({ status: "succeeded" }), 0).fraction).toBe(1);
  });
});
