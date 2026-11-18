import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import type { Scan } from "./owner";
import { folderTrouble, isActive, scanCount, scanLine, scanStateLabel } from "./scans";

const asJobId = Brand.nominal<Scan["jobId"]>();

const job = (
  overrides: Partial<{
    status: Scan["status"];
    done: number | null;
    total: number | null;
    message: string | null;
    error: string | null;
    canceling: boolean;
  }> = {},
): Scan => ({
  jobId: asJobId("jobs_1"),
  status: overrides.status ?? "running",
  done: overrides.done === undefined ? 0 : overrides.done,
  total: overrides.total ?? null,
  error: overrides.error ?? null,
  message: overrides.message ?? null,
  startedAt: 1,
  attempt: 1,
  canceling: overrides.canceling ?? false,
  finishedAt: null,
});

describe("scans", () => {
  it("tells running scans from finished ones and names their state", () => {
    expect(isActive(job({ status: "queued" }))).toBe(true);
    expect(isActive(job({ status: "succeeded" }))).toBe(false);
    expect(isActive(null)).toBe(false);
    expect(scanStateLabel(job({ status: "succeeded" }))).toBe("Complete");
    expect(scanStateLabel(job({ status: "failed" }))).toBe("Failed");
    expect(scanStateLabel(job({ canceling: true }))).toBe("Cancelling");
  });

  it("counts files once the total is known, and a finished scan as complete", () => {
    expect(scanCount(job({ done: 42, total: 186 }))).toStrictEqual({
      label: "42 of 186",
      fraction: 42 / 186,
    });
    expect(scanCount(job({ done: 3 }))).toBeNull();
    expect(scanCount(job({ done: null, total: 10 }))).toBeNull();
    expect(scanCount(job({ done: 1252, total: 1842 }))?.label).toBe("1,252 of 1,842");
    expect(scanCount(job({ status: "succeeded", done: 0, total: null }))).toStrictEqual({
      label: "Complete",
      fraction: 1,
    });
    expect(scanCount(job({ status: "succeeded", done: 9, total: 9 }))).toStrictEqual({
      label: "9 of 9",
      fraction: 1,
    });
  });

  it("describes the phase a scan is in, or how it ended", () => {
    expect(scanLine(job({ message: "processing" }))).toBe("Matching titles and reading media.");
    expect(scanLine(job({ message: "walking" }))).toBe("Finding files.");
    expect(scanLine(job({ status: "queued" }))).toBe("Waiting for the media service.");
    expect(scanLine(job({ status: "failed", error: "Disk on fire" }))).toBe("Disk on fire");
    expect(scanLine(job({ canceling: true }))).toBe("Stopping the scan.");
  });

  it("recognizes an unreachable or refused folder in a failed scan", () => {
    const failed = (error: string) => job({ status: "failed", error });

    expect(folderTrouble(failed("Library root unavailable: /mnt/nas (missing); known files"))).toBe(
      "offline",
    );
    expect(folderTrouble(failed("Library folder unreadable: Movies (EIO); known files"))).toBe(
      "offline",
    );
    expect(folderTrouble(failed("Library root not approved: /etc is outside LIBRARY_ROOTS"))).toBe(
      "notApproved",
    );
    expect(folderTrouble(failed("This library was removed"))).toBeNull();
    expect(folderTrouble(job())).toBeNull();
  });
});
