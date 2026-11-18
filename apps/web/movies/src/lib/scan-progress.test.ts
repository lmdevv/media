import { describe, expect, it } from "vitest";

import { isActive, scanProgress } from "./scan-progress";

const running = { status: "running", startedAt: 0 } as const;

describe("scan progress", () => {
  it("has no fraction until the total is known", () => {
    expect(scanProgress({ ...running, done: 0, total: null }, 60_000)).toEqual({
      fraction: null,
      done: 0,
      total: null,
      minutesLeft: null,
    });
  });

  it("estimates minutes left from the pace since the scan started", () => {
    const progress = scanProgress({ ...running, done: 100, total: 400 }, 120_000);

    expect(progress.fraction).toBe(0.25);
    expect(progress.minutesLeft).toBe(6);
  });

  it("has no time left before it runs or reads anything", () => {
    expect(
      scanProgress({ status: "queued", done: 0, total: 10, startedAt: null }, 1).minutesLeft,
    ).toBeNull();
    expect(scanProgress({ ...running, done: 0, total: 10 }, 60_000).minutesLeft).toBeNull();
  });

  it("never estimates less than a minute", () => {
    expect(scanProgress({ ...running, done: 399, total: 400 }, 60_000).minutesLeft).toBe(1);
  });

  it("reads counts the core hides as none yet", () => {
    expect(
      scanProgress({ status: "queued", done: null, total: null, startedAt: null }, 0).done,
    ).toBe(0);
  });

  it("reports a finished scan as complete", () => {
    expect(
      scanProgress({ status: "succeeded", done: 3, total: 4, startedAt: null }, 0).fraction,
    ).toBe(1);
  });

  it("counts queued and running jobs as active", () => {
    const statuses = ["queued", "running", "succeeded", "failed", "canceled"] as const;

    expect(statuses.map((status) => isActive({ status }))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
