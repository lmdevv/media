import { describe, expect, it } from "vitest";

import { jobEta, jobPercent } from "./job-progress";

const MINUTE = 60_000;

describe("jobEta", () => {
  it("estimates the time left from the rate so far", () => {
    const job = { status: "running", done: 100, total: 1000, startedAt: 0 } as const;

    expect(jobEta(job, MINUTE)).toBe("~9 MIN LEFT");
    expect(jobEta({ ...job, done: 900 }, MINUTE)).toBe("UNDER A MINUTE LEFT");
  });

  it("waits for progress before estimating", () => {
    expect(jobEta({ status: "running", done: 0, total: 1000, startedAt: 0 }, MINUTE)).toBeNull();
    expect(jobEta({ status: "running", done: 5, total: null, startedAt: 0 }, MINUTE)).toBeNull();
    expect(jobEta({ status: "running", done: 5, total: 10, startedAt: null }, MINUTE)).toBeNull();
  });

  // Setup's last step showed "100% · UNDER A MINUTE LEFT" once the scan had finished.
  it("has nothing left once the job finished or read everything", () => {
    const finished = { done: 20_000, total: 20_000, startedAt: 0 } as const;

    expect(jobEta({ ...finished, status: "done" }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "running" }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "failed", done: 10 }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "cancelled", done: 10 }, MINUTE)).toBeNull();
  });
});

describe("jobPercent", () => {
  it("is 100 once done and unknown without a total", () => {
    expect(jobPercent({ status: "done", done: 3, total: null })).toBe(100);
    expect(jobPercent({ status: "running", done: 3, total: null })).toBeNull();
    expect(jobPercent({ status: "running", done: 1, total: 3 })).toBe(33);
  });
});
