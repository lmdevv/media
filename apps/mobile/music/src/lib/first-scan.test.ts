import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { firstScan } from "./first-scan";

type Scan = NonNullable<Parameters<typeof firstScan>[0]["scan"]>;

const MINUTE = 60_000;

const asJobId = Brand.nominal<Scan["jobId"]>();

const scan = (patch: Partial<Scan>): Parameters<typeof firstScan>[0] => ({
  folders: ["/music"],
  scan: {
    jobId: asJobId("job"),
    status: "running",
    done: 0,
    total: null,
    error: null,
    message: null,
    startedAt: 0,
    attempt: 1,
    canceling: false,
    finishedAt: null,
    ...patch,
  },
});

describe("firstScan", () => {
  it("waits for the scanner before the scan starts", () => {
    expect(firstScan({ folders: ["/music"], scan: null }, 0)).toEqual({
      kind: "running",
      percent: null,
      left: "WAITING FOR THE SCANNER",
    });
    expect(firstScan(scan({ status: "queued" }), 0)).toMatchObject({
      left: "WAITING FOR THE SCANNER",
    });
  });

  it("estimates the time left from the rate so far", () => {
    const halfway = scan({ done: 200, total: 400 });

    expect(firstScan(halfway, MINUTE)).toEqual({
      kind: "running",
      percent: 50,
      left: "UNDER A MINUTE LEFT",
    });
    expect(firstScan(halfway, 10 * MINUTE)).toMatchObject({ left: "ABOUT 10 MIN LEFT" });
  });

  it("counts files before it has a percent", () => {
    expect(firstScan(scan({ done: 30 }), MINUTE)).toEqual({
      kind: "running",
      percent: null,
      left: "COUNTING FILES",
    });
  });

  it("is done once the scan succeeded, and stopped once it failed or was canceled", () => {
    expect(firstScan(scan({ status: "succeeded" }), 0)).toEqual({ kind: "done" });
    expect(firstScan(scan({ status: "failed" }), 0)).toEqual({
      kind: "stopped",
      folders: ["/music"],
    });
    expect(firstScan(scan({ status: "canceled" }), 0)).toMatchObject({ kind: "stopped" });
  });
});
