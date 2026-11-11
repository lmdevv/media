import { SCAN_FAILURE_PREFIXES } from "@media/contracts/scan-failure";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { isActive, isUnreachable, lastScanLabel, scanFraction } from "./scan";
import type { Scan } from "./types";

const jobId = Brand.nominal<Scan["jobId"]>();

const NOW = new Date(2026, 10, 10, 12).getTime();

const scan = (fields: Partial<Scan>): Scan => ({
  jobId: jobId("j1"),
  status: "succeeded",
  done: null,
  total: null,
  error: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  ...fields,
});

describe("scan", () => {
  it("counts queued and running scans as active", () => {
    expect(isActive(scan({ status: "queued" }))).toBe(true);
    expect(isActive(scan({ status: "running" }))).toBe(true);
    expect(isActive(scan({ status: "failed" }))).toBe(false);
    expect(isActive(null)).toBe(false);
  });

  it("tells an unreachable folder from other failures", () => {
    const offline = `${SCAN_FAILURE_PREFIXES.rootUnavailable} /srv/films`;

    expect(isUnreachable(scan({ status: "failed", error: offline }))).toBe(true);
    expect(isUnreachable(scan({ status: "failed", error: "ffprobe crashed" }))).toBe(false);
    expect(isUnreachable(scan({ status: "succeeded", error: offline }))).toBe(false);
  });

  it("labels the last scan", () => {
    expect(lastScanLabel(null, NOW)).toBe("never");
    expect(lastScanLabel(scan({ status: "queued" }), NOW)).toBe("queued");
    expect(lastScanLabel(scan({ status: "running" }), NOW)).toBe("running");
    expect(lastScanLabel(scan({ status: "running", startedAt: NOW - 95_000 }), NOW)).toBe(
      "running 1m",
    );
    expect(lastScanLabel(scan({ finishedAt: NOW - 2 * 60_000 }), NOW)).toBe("2 min ago");
  });

  it("knows the share done only with a total", () => {
    expect(scanFraction(scan({ done: 3, total: 12 }))).toBe(0.25);
    expect(scanFraction(scan({ done: 3, total: null }))).toBeNull();
  });
});
