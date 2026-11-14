import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { JobRowView, JobsView, jobFacts, jobTitle } from "./jobs";
import { disabledButton, loaded, noop, textOf } from "./testing";
import type { Job, LibraryId } from "./types";

const libraryId = Brand.nominal<LibraryId>();

const jobId = Brand.nominal<Job["jobId"]>();

const musicLibrary = { libraryId: libraryId("l1"), name: "Music", level: "manage" as const };

const job = (fields: Partial<Job>): Job => ({
  jobId: jobId("j1"),
  kind: "music.scan",
  status: "running",
  library: musicLibrary,
  attempts: 1,
  done: 7,
  total: 28,
  message: "probing",
  error: null,
  canceling: false,
  createdAt: 0,
  finishedAt: null,
  ...fields,
});

const row = (shown: Job) => (
  <JobRowView job={shown} running={null} onCancel={noop} onRetry={noop} />
);

const nameOf = (shown: Job): string => `${jobTitle(shown)} row`;

describe("jobTitle and jobFacts", () => {
  it("name a scan by its library and say how far it got", () => {
    expect(jobTitle(job({}))).toBe("Music");
    expect(jobFacts(job({}))).toBe("Music · Running · 7 / 28");
    expect(jobFacts(job({ status: "queued", done: 0 }))).toBe("Music · Waiting");
  });

  it("name another kind by what it does, and count its attempts once it was tried again", () => {
    const backup = job({
      kind: "server.backup",
      library: null,
      status: "failed",
      attempts: 3,
      finishedAt: null,
    });

    expect(jobTitle(backup)).toBe("Backup");
    expect(jobFacts(backup)).toBe("Failed · attempt 3");
  });

  it("name a lyrics lookup, show its error, and offer no action on it", () => {
    const lookup = job({
      kind: "music.lyrics",
      library: null,
      status: "queued",
      attempts: 2,
      done: 0,
      total: null,
      error: "LRCLIB unavailable: timeout",
    });

    expect(jobTitle(lookup)).toBe("Lyrics lookup");
    expect(jobFacts(lookup)).toBe("Waiting · attempt 2");

    const shown = textOf(row(lookup));

    expect(shown).toContain("LRCLIB unavailable: timeout");
    expect(shown).not.toContain("Cancel");
    expect(shown).not.toContain("Retry");
  });
});

describe("JobRowView", () => {
  it("offers Cancel while a scan runs, and waits while a cancel lands", () => {
    expect(textOf(row(job({})))).toContain("Cancel");
    expect(disabledButton(row(job({ canceling: true })), "Canceling…")).toBe(true);
  });

  it("offers Retry after a scan failed and shows its error", () => {
    const failed = textOf(row(job({ status: "failed", error: "Folder is gone" })));

    expect(failed).toContain("Retry");
    expect(failed).toContain("Folder is gone");
  });

  it("offers nothing to someone who only views the library, nor on another kind", () => {
    const viewer = textOf(row(job({ library: { ...musicLibrary, level: "view" } })));
    const backup = textOf(row(job({ kind: "server.backup", library: null })));

    expect(viewer).not.toContain("Cancel");
    expect(backup).not.toContain("Cancel");
  });
});

describe("JobsView", () => {
  it("says when there are no jobs", () => {
    expect(
      textOf(
        <JobsView
          jobs={loaded([])}
          failed={loaded([])}
          filter="all"
          onFilter={noop}
          row={nameOf}
        />,
      ),
    ).toContain("No jobs yet.");
  });

  it("counts the failed jobs and lists them when asked", () => {
    const failed = loaded([job({ kind: "movies.trickplay", library: null, status: "failed" })]);

    const shown = textOf(
      <JobsView jobs={failed} failed={failed} filter="failed" onFilter={noop} row={nameOf} />,
    );

    expect(shown).toContain("Failed · 1");
    expect(shown).toContain("Scrub thumbnails row");
  });

  it("says when no job failed", () => {
    expect(
      textOf(
        <JobsView
          jobs={loaded([])}
          failed={loaded([])}
          filter="failed"
          onFilter={noop}
          row={nameOf}
        />,
      ),
    ).toContain("No failed jobs.");
  });
});
