import { describe, expect, it } from "vitest";

import { JobId, LibraryId } from "./ids";
import {
  jobEta,
  jobLine,
  jobName,
  jobPercent,
  jobProgress,
  jobStatusLine,
  keptLine,
  splitJobs,
  stoppedReason,
} from "./jobs";
import type { Job } from "./jobs";

const now = new Date(2026, 9, 22, 15, 0).getTime();

const MINUTE = 60_000;

const started = now - 3 * MINUTE;

const job = (fields: Partial<Job> = {}): Job => ({
  jobId: JobId.make("job"),
  kind: "music.scan",
  status: "running",
  library: { libraryId: LibraryId.make("music"), name: "Personal collection", level: "manage" },
  attempts: 1,
  done: 804,
  total: 1248,
  message: null,
  error: null,
  canceling: false,
  createdAt: started,
  finishedAt: null,
  ...fields,
});

describe("jobPercent", () => {
  it("is 100 once done, and unknown without a total", () => {
    expect(jobPercent(job())).toBe(64);
    expect(jobPercent(job({ status: "succeeded", total: null }))).toBe(100);
    expect(jobPercent(job({ total: null }))).toBeNull();
    expect(jobPercent(job({ total: 0, done: 0 }))).toBeNull();
  });
});

describe("jobProgress", () => {
  it("says a rescan that found nothing changed read nothing new", () => {
    expect(jobProgress({ status: "succeeded", done: 0, total: 0 })).toEqual({
      stat: "100%",
      caption: "Nothing new to read",
      fill: 100,
    });
  });

  it("shows the percent and files read, as F19 does", () => {
    expect(jobProgress(job())).toEqual({
      stat: "64%",
      caption: "804 of 1,248 files read",
      fill: 64,
    });
  });

  it("waits, counts without a total, and fills once done", () => {
    expect(jobProgress(job({ status: "queued", done: 0, total: null })).caption).toBe(
      "Waiting for the scanner",
    );
    expect(jobProgress(job({ total: null }))).toEqual({
      stat: "804",
      caption: "Files read so far",
      fill: null,
    });
    expect(jobProgress(job({ status: "succeeded", done: 142, total: null }))).toEqual({
      stat: "100%",
      caption: "142 files read",
      fill: 100,
    });
  });
});

describe("jobEta", () => {
  it("estimates the time left from the rate so far", () => {
    expect(jobEta(job({ done: 400, total: 1200 }), now - 2 * MINUTE, now)).toBe(
      "About 4 minutes left",
    );
    expect(jobEta(job({ done: 1190, total: 1200 }), started, now)).toBe("Less than a minute left");
  });

  it("says nothing until there is a rate, or once nothing is left", () => {
    expect(jobEta(job({ done: 0 }), started, now)).toBeNull();
    expect(jobEta(job({ total: null }), started, now)).toBeNull();
    expect(jobEta(job({ done: 1248 }), started, now)).toBeNull();
    expect(jobEta(job({ status: "queued" }), started, now)).toBeNull();
    expect(jobEta(job(), null, now)).toBeNull();
  });
});

describe("jobLine", () => {
  it("words each status as F18's rows do", () => {
    const yesterday = new Date(2026, 9, 21, 9, 0).getTime();

    expect(jobLine(job(), now)).toBe("804 / 1,248 files · 64%");
    expect(jobLine(job({ status: "succeeded", done: 142, total: 142, finishedAt: now }), now)).toBe(
      "Completed · 142 files · Today",
    );
    expect(jobLine(job({ status: "succeeded", done: 0, total: 0, finishedAt: now }), now)).toBe(
      "Completed · Nothing new · Today",
    );
    expect(
      jobLine(job({ status: "failed", error: "Folder unavailable", finishedAt: yesterday }), now),
    ).toBe("Failed · Folder unavailable · Yesterday");
    expect(jobLine(job({ status: "canceled", finishedAt: now }), now)).toBe("Cancelled · Today");
  });

  it("shows the scanner's own words before it has counted", () => {
    expect(jobLine(job({ total: null, message: "Listing files" }), now)).toBe("Listing files");
    expect(jobLine(job({ status: "queued" }), now)).toBe("Waiting for the scanner");
  });
});

describe("jobStatusLine", () => {
  it("says how long a job has been at it", () => {
    expect(jobStatusLine(job(), now)).toBe("Running · Started 3 minutes ago");
    expect(jobStatusLine(job({ status: "queued", createdAt: now - 1000 }), now)).toBe(
      "Waiting · Queued just now",
    );
    expect(jobStatusLine(job({ status: "succeeded", finishedAt: now - 2 * MINUTE }), now)).toBe(
      "Done · Finished 2 minutes ago",
    );
  });
});

describe("a stopped scan", () => {
  it("says what was kept", () => {
    expect(keptLine(804)).toBe("804 songs were added");
    expect(keptLine(1)).toBe("1 song was added");
    expect(keptLine(0)).toBe("No songs were added");
  });

  it("gives the server's reason, or that someone cancelled it", () => {
    expect(stoppedReason(job({ status: "failed", error: "Can’t read /music" }))).toBe(
      "Can’t read /music",
    );
    expect(stoppedReason(job({ status: "canceled" }))).toContain("stopped this scan");
  });
});

describe("jobName", () => {
  it("names a scan after its library, and any other job after what it does", () => {
    expect(jobName(job())).toBe("Personal collection");
    expect(jobName(job({ kind: "music.lyrics", library: null }))).toBe("Lyrics lookup");
  });
});

describe("splitJobs", () => {
  it("puts waiting and running jobs first, keeping the server's order", () => {
    const running = job({ jobId: JobId.make("a") });
    const waiting = job({ jobId: JobId.make("b"), status: "queued" });
    const done = job({ jobId: JobId.make("c"), status: "succeeded" });
    const failed = job({ jobId: JobId.make("d"), status: "failed" });

    expect(splitJobs([done, running, failed, waiting])).toEqual({
      running: [running, waiting],
      recent: [done, failed],
    });
  });
});
