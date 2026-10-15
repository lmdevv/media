import { JobId, LibraryId } from "@music/commands/ids";
import type { Job } from "@music/commands/models";
import { describe, expect, it } from "vitest";

import { progressLine } from "./jobs";

const job = (fields: Partial<Job>): Job => ({
  id: JobId.make("j1"),
  kind: "scan",
  status: "running",
  libraryId: LibraryId.make("l1"),
  label: "Scan Music",
  done: 120,
  total: 500,
  message: "reading tags",
  error: null,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
  ...fields,
});

describe("progressLine", () => {
  it("shows the job's label, status, count, and note", () => {
    expect(progressLine(job({}))).toBe("Scan Music: running 120/500 (reading tags)");
  });

  it("writes out control characters in the label and note", () => {
    const line = progressLine(
      job({ label: "Scan \u001b]0;x\u0007", error: "bad file \u009b2J.flac", status: "failed" }),
    );

    expect(line).toBe(String.raw`Scan \u001b]0;x\u0007: failed 120/500 (bad file \u009b2J.flac)`);
    expect(/\p{Cc}/u.test(line)).toBe(false);
  });
});
