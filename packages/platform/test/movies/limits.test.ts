import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { logMark, usageSince } from "../admin";
import { member } from "../devices";
import { coreStackFromEnvFile } from "../stack-env";
import { cancelQueued, claimJob, finishJob, moviesLibrary, totalsOf, upsert } from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

describe.skipIf(stack === undefined)("movies scanner limits", { timeout: 300_000 }, () => {
  it("write a full batch of new video files, each queuing thumbnails, inside one call's limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "limits-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Full batch");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const show = scannedTitle("show", "tmdb:99", "Long show");

    const episodes = Array.from({ length: 250 }, (_, n) =>
      episodeFile(join(root, "show", `${n}.mkv`), show, 1 + Math.floor(n / 50), n, true),
    );

    const movies = Array.from({ length: 250 }, (_, n) =>
      movieFile(join(root, `${n}.mkv`), 1, 1, scannedTitle("movie", `m:${n}`, `Movie ${n}`), true),
    );

    const mark = await logMark(stack);

    expect(await upsert(stack, lease, [...episodes, ...movies])).toMatchObject({ outcome: "held" });
    expect(await upsert(stack, lease, [...episodes, ...movies])).toMatchObject({ outcome: "held" });

    const usage = await usageSince(stack, mark, api.movies.scanner.upsert, 2);
    const committed = usage.filter((call) => call.committed);

    expect(committed.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...committed.map((call) => call.reads))).toBeLessThan(READS_MAX);
    expect(Math.max(...committed.map((call) => call.writes))).toBeLessThan(WRITES_MAX);
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 251, episodes: 250, files: 500 });
    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");
  });
});
