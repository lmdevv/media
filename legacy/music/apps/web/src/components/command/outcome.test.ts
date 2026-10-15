import { Job } from "@music/commands/models";
import type { JobStatus } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { jobMeta, outcomeOf } from "./outcome";

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

describe("outcomeOf", () => {
  it("follows the job a scan starts", () => {
    const result = Schema.decodeSync(commands["libraries.scan"].result)({ jobId: "j1" });

    expect(outcomeOf(result)).toEqual({ kind: "job", jobId: "j1" });
  });

  it("follows the job when a result also carries other IDs", () => {
    const result = Schema.decodeSync(commands["libraries.create"].result)({
      libraryId: "l1",
      jobId: "j2",
    });

    expect(outcomeOf(result)).toEqual({ kind: "job", jobId: "j2" });
  });

  it("shows a new key", () => {
    const result = Schema.decodeSync(commands["keys.create"].result)({
      key: "mk_secret",
      apiKey: { id: "k1", name: "Laptop", prefix: "mk_", createdAt: 0, lastUsedAt: null },
    });

    expect(outcomeOf(result)).toEqual({ kind: "key", key: "mk_secret" });
  });

  it("shows a new invite's code", () => {
    const result = Schema.decodeSync(commands["invites.create"].result)({
      id: "i1",
      code: "abc123",
      email: null,
      role: "member",
      status: "open",
      createdAt: 0,
      expiresAt: 1,
      acceptedAt: null,
    });

    expect(outcomeOf(result)).toEqual({ kind: "invite", code: "abc123" });
  });

  it("shows a new password reset link", () => {
    const result = Schema.decodeSync(commands["people.reset"].result)({
      userId: "u1",
      token: "reset-token",
      expiresAt: 1,
    });

    expect(outcomeOf(result)).toEqual({ kind: "reset", token: "reset-token" });
  });

  it("opens a new playlist", () => {
    const result = Schema.decodeSync(commands["playlists.create"].result)({ playlistId: "p1" });

    expect(outcomeOf(result)).toEqual({ kind: "playlist", playlistId: "p1" });
  });

  it("shows nothing for a plain acknowledgement", () => {
    const result = Schema.decodeSync(commands["playback.pause"].result)({ ok: true });

    expect(outcomeOf(result)).toEqual({ kind: "none" });
  });
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
