import { Job } from "@music/commands/models";
import type { JobStatus } from "@music/commands/models";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { jobMeta } from "./outcome";

const job = (fields: {
  readonly status: JobStatus;
  readonly message?: string;
  readonly error?: string;
}) =>
  Schema.decodeSync(Job)({
    id: "j1",
    kind: "scan",
    status: fields.status,
    libraryId: "l1",
    label: "Scan",
    done: 28,
    total: 28,
    message: fields.message ?? null,
    error: fields.error ?? null,
    createdAt: 0,
    startedAt: 0,
    finishedAt: null,
  });

describe("jobMeta", () => {
  it("says the job runs on its own while it loads, waits, or runs", () => {
    const note = "Runs in the background. Close this any time.";

    expect(jobMeta(undefined)).toBe(note);
    expect(jobMeta(job({ status: "pending" }))).toBe(note);
    expect(jobMeta(job({ status: "running" }))).toBe(note);
  });

  it("shows the scanner's summary or the failure once the job ends", () => {
    expect(jobMeta(job({ status: "done", message: "28 files, 0 updated, 0 missing" }))).toBe(
      "28 files, 0 updated, 0 missing",
    );
    expect(jobMeta(job({ status: "done" }))).toBe("Finished.");
    expect(jobMeta(job({ status: "failed", error: "The folder is gone." }))).toBe(
      "The folder is gone.",
    );
    expect(jobMeta(job({ status: "failed" }))).toBe("The job failed.");
  });
});
