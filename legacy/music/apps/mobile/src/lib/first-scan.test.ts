import { LibraryId } from "@music/commands/ids";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { firstScan } from "./first-scan";

const music = Schema.decodeSync(LibraryId)("lib-music");

const jazz = Schema.decodeSync(LibraryId)("lib-jazz");

const library = (id: LibraryId, path: string) =>
  ({ id, path, lastScanAt: null, scanning: true, trackCount: 0 }) as const;

const job = (libraryId: LibraryId, createdAt = 0) =>
  ({
    libraryId,
    status: "running",
    done: 0,
    total: null,
    createdAt,
    startedAt: 0,
  }) as const;

const MINUTE = 60_000;

describe("firstScan", () => {
  it("waits for the scanner before any job starts", () => {
    expect(
      firstScan([library(music, "/music")], [{ ...job(music), status: "pending" }], 0),
    ).toEqual({ kind: "running", percent: null, left: "WAITING FOR THE SCANNER" });
  });

  it("adds up every folder's progress and estimates the time left", () => {
    const libraries = [library(music, "/music"), library(jazz, "/jazz")];

    const jobs = [
      { ...job(music), done: 150, total: 300 },
      { ...job(jazz), done: 50, total: 100 },
    ];

    expect(firstScan(libraries, jobs, MINUTE)).toEqual({
      kind: "running",
      percent: 50,
      left: "UNDER A MINUTE LEFT",
    });
    expect(firstScan(libraries, jobs, 10 * MINUTE)).toMatchObject({ left: "ABOUT 10 MIN LEFT" });
  });

  it("counts files before it has a percent", () => {
    const libraries = [library(music, "/music"), library(jazz, "/jazz")];
    const jobs = [{ ...job(music), done: 10, total: 100 }, job(jazz)];

    expect(firstScan(libraries, jobs, MINUTE)).toEqual({
      kind: "running",
      percent: null,
      left: "COUNTING FILES",
    });
  });

  it("is done once every library has been read", () => {
    const read = { ...library(music, "/music"), lastScanAt: 5, scanning: false };

    expect(firstScan([read], [{ ...job(music), status: "done" }], 0)).toEqual({ kind: "done" });
  });

  it("reports the stopped folder and what made it in, by each library's newest job", () => {
    const libraries = [{ ...library(music, "/music"), trackCount: 804, scanning: false }];
    const retried = [{ ...job(music, 1), status: "failed" }, job(music, 2)] as const;

    expect(firstScan(libraries, [{ ...job(music), status: "failed" }], 0)).toEqual({
      kind: "stopped",
      libraryId: music,
      path: "/music",
      added: 804,
    });
    expect(firstScan(libraries, retried, 0).kind).toBe("running");
  });
});
