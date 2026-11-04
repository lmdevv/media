import { Job } from "@media/contracts/models/jobs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { folderTrouble, isActive, scanCount, scanLine, scanStateLabel } from "./scans";

const job = (
  id: string,
  libraryId: string,
  overrides: Partial<{
    status: Job["status"];
    done: number;
    total: number | null;
    message: string | null;
    error: string | null;
  }> = {},
): Job =>
  Schema.decodeSync(Job)({
    id,
    kind: "scan",
    status: overrides.status ?? "running",
    payload: { kind: "scan", libraryId, mode: "full" },
    progress: {
      done: overrides.done ?? 0,
      total: overrides.total ?? null,
      message: overrides.message ?? null,
    },
    error: overrides.error ?? null,
    requestedBy: null,
    attempts: 1,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
  });

describe("scans", () => {
  it("tells running scans from finished ones and names their state", () => {
    expect(isActive(job("a", "movies", { status: "pending" }))).toBe(true);
    expect(isActive(job("a", "movies", { status: "succeeded" }))).toBe(false);
    expect(isActive(undefined)).toBe(false);
    expect(scanStateLabel(job("a", "movies", { status: "succeeded" }))).toBe("Complete");
    expect(scanStateLabel(job("a", "movies", { status: "failed" }))).toBe("Failed");
  });

  it("counts files once the total is known, and a finished scan as complete", () => {
    expect(scanCount(job("a", "movies", { done: 42, total: 186 }))).toStrictEqual({
      label: "42 of 186",
      fraction: 42 / 186,
    });
    expect(scanCount(job("a", "movies", { done: 3 }))).toBeNull();
    expect(scanCount(job("a", "movies", { done: 1252, total: 1842 }))?.label).toBe(
      "1,252 of 1,842",
    );
    expect(scanCount(job("a", "movies", { status: "succeeded", done: 9, total: 9 }))).toStrictEqual(
      { label: "9 of 9", fraction: 1 },
    );
  });

  it("describes the phase a scan is in, or how it ended", () => {
    expect(scanLine(job("a", "movies", { message: "processing" }))).toBe(
      "Matching titles and reading media.",
    );
    expect(scanLine(job("a", "movies", { message: "walking" }))).toBe("Finding files.");
    expect(scanLine(job("a", "movies", { status: "pending" }))).toBe(
      "Waiting for the media service.",
    );
    expect(scanLine(job("a", "movies", { status: "failed", error: "Disk on fire" }))).toBe(
      "Disk on fire",
    );
  });

  it("recognizes an unreachable or refused folder in a failed scan", () => {
    const failed = (error: string) => job("a", "movies", { status: "failed", error });

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
    expect(folderTrouble(job("a", "movies"))).toBeNull();
  });
});
