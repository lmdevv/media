import { describe, expect, it } from "vitest";

import { jobEta, jobPercent } from "./job-progress";

const MINUTE = 60_000;

describe("jobEta", () => {
  it("estimates the time left from the rate so far", () => {
    const scan = { status: "running", done: 100, total: 1000, startedAt: 0 } as const;

    expect(jobEta(scan, MINUTE)).toBe("~9 MIN LEFT");
    expect(jobEta({ ...scan, done: 900 }, MINUTE)).toBe("UNDER A MINUTE LEFT");
  });

  it("waits for progress before estimating", () => {
    expect(jobEta({ status: "running", done: 0, total: 1000, startedAt: 0 }, MINUTE)).toBeNull();
    expect(jobEta({ status: "running", done: 5, total: null, startedAt: 0 }, MINUTE)).toBeNull();
    expect(jobEta({ status: "running", done: 5, total: 10, startedAt: null }, MINUTE)).toBeNull();
    expect(jobEta({ status: "running", done: null, total: 10, startedAt: 0 }, MINUTE)).toBeNull();
  });

  it("has nothing left once the scan finished or read everything", () => {
    const finished = { done: 20_000, total: 20_000, startedAt: 0 } as const;

    expect(jobEta({ ...finished, status: "succeeded" }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "running" }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "failed", done: 10 }, MINUTE)).toBeNull();
    expect(jobEta({ ...finished, status: "canceled", done: 10 }, MINUTE)).toBeNull();
  });
});

describe("jobPercent", () => {
  it("is full once the scan succeeded and unknown without a total", () => {
    expect(jobPercent({ status: "succeeded", done: null, total: null })).toBe(100);
    expect(jobPercent({ status: "running", done: 5, total: null })).toBeNull();
    expect(jobPercent({ status: "running", done: 25, total: 100 })).toBe(25);
  });
});
