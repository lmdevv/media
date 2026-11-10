import { describe, expect, it } from "vitest";

import { isActive, scanProgress } from "./scan-progress";

describe("scan progress", () => {
  it("has no fraction until the total is known", () => {
    expect(scanProgress({ status: "running", done: 0, total: null })).toEqual({
      fraction: null,
      done: 0,
      total: null,
    });
  });

  it("reads the fraction from the counts", () => {
    expect(scanProgress({ status: "running", done: 100, total: 400 }).fraction).toBe(0.25);
  });

  it("reads counts the core hides as none yet", () => {
    expect(scanProgress({ status: "queued", done: null, total: null }).done).toBe(0);
  });

  it("reports a finished scan as complete", () => {
    expect(scanProgress({ status: "succeeded", done: 3, total: 4 }).fraction).toBe(1);
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
