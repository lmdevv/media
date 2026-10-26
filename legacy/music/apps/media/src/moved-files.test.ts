import { describe, expect, it } from "vitest";

import type { Fingerprint, ScannedTrack } from "./media-backend.ts";
import { movedFileMatcher } from "./moved-files.ts";
import { describeScan } from "./scan.ts";
import { NO_LYRICS } from "./testing/fixtures.ts";

const gone = (path: string, changes: Partial<Fingerprint> = {}): Fingerprint => ({
  path,
  size: 1000,
  mtimeMs: 5000,
  missing: false,
  durationMs: 180_000,
  title: "Song",
  artist: "Artist",
  album: "Album",
  ...changes,
});

const found = (path: string, changes: Partial<ScannedTrack> = {}): ScannedTrack => ({
  path,
  size: 1000,
  mtimeMs: 5000,
  title: "Song",
  artist: "Artist",
  album: "Album",
  durationMs: 180_000,
  codec: "flac",
  lossless: true,
  ...NO_LYRICS,
  ...changes,
});

describe("movedFileMatcher", () => {
  it("matches the same size and length with the same time or the same tags", () => {
    const match = movedFileMatcher([
      gone("a.flac"),
      gone("b.flac", { size: 2000, title: "Other" }),
      gone("c.flac", { size: 3000 }),
    ]);

    expect(match(found("new/a.flac", { title: "Renamed" }))).toBe("a.flac");
    expect(match(found("new/b.flac", { size: 2000, mtimeMs: 1, title: "Other" }))).toBe("b.flac");
    expect(match(found("new/c.flac", { size: 3000, mtimeMs: 1, title: "Retagged" }))).toBe(
      undefined,
    );
  });

  it("never matches another length or size, or a track without a stored length", () => {
    const match = movedFileMatcher([
      gone("a.flac"),
      gone("b.flac", { size: 2000, durationMs: undefined }),
    ]);

    expect(match(found("x.flac", { durationMs: 180_001 }))).toBeUndefined();
    expect(match(found("y.flac", { size: 1001 }))).toBeUndefined();
    expect(match(found("z.flac", { size: 2000 }))).toBeUndefined();
  });

  it("gives each gone track to one file, and none when two gone tracks fit", () => {
    const single = movedFileMatcher([gone("a.flac")]);

    expect(single(found("one.flac"))).toBe("a.flac");
    expect(single(found("two.flac"))).toBeUndefined();

    const twins = movedFileMatcher([gone("a.flac"), gone("b.flac")]);

    expect(twins(found("one.flac"))).toBeUndefined();
  });
});

describe("describeScan", () => {
  it("mentions moved and unreadable files only when there are some", () => {
    expect(describeScan({ files: 10, updated: 2, moved: 0, missing: 1, failed: 0 })).toBe(
      "10 files, 2 updated, 1 missing",
    );
    expect(describeScan({ files: 10, updated: 2, moved: 3, missing: 0, failed: 1 })).toBe(
      "10 files, 2 updated, 3 moved, 0 missing, 1 unreadable",
    );
  });
});
