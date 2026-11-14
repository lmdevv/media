import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { JobRowView, JobsView, jobFacts } from "./jobs";
import type { Scan } from "./jobs";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Library, LibraryId } from "./types";

const libraryId = Brand.nominal<LibraryId>();

const jobId = Brand.nominal<Scan["jobId"]>();

const music: Library = {
  libraryId: libraryId("l1"),
  name: "Music",
  kind: "music",
  level: "manage",
};

const scan = (fields: Partial<Scan>): Scan => ({
  jobId: jobId("j1"),
  status: "running",
  done: 7,
  total: 28,
  error: null,
  message: "probing",
  startedAt: 0,
  attempt: 1,
  canceling: false,
  finishedAt: null,
  ...fields,
});

const row = (library: Library, current: Scan | null) => (
  <JobRowView library={library} scan={current} running={null} onCancel={noop} onRetry={noop} />
);

describe("jobFacts", () => {
  it("says the kind, the status, and how far a running scan got", () => {
    expect(jobFacts(music, scan({}))).toBe("Music · Running · 7 / 28 files");
    expect(jobFacts(music, null)).toBe("Music · Never scanned");
    expect(jobFacts(music, scan({ status: "queued", done: null }))).toBe("Music · Waiting");
  });
});

describe("JobRowView", () => {
  it("offers Cancel while a scan runs, and waits while a cancel lands", () => {
    expect(textOf(row(music, scan({})))).toContain("Cancel");
    expect(disabledButton(row(music, scan({ canceling: true })), "Canceling…")).toBe(true);
  });

  it("offers Retry after a scan failed and shows its error", () => {
    const failed = textOf(row(music, scan({ status: "failed", error: "Folder is gone" })));

    expect(failed).toContain("Retry");
    expect(failed).toContain("Folder is gone");
  });

  it("offers nothing to someone who only views the library", () => {
    const viewer = textOf(row({ ...music, level: "view" }, scan({})));

    expect(viewer).not.toContain("Cancel");
  });
});

describe("JobsView", () => {
  it("says when no library is shared, so there are no jobs", () => {
    expect(textOf(<JobsView libraries={loaded([])} filter="all" onFilter={noop} />)).toContain(
      "No library is shared with you, so there are no jobs.",
    );
  });
});
