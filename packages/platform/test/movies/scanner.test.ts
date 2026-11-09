import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import { runFunction } from "../admin";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import { runServer } from "../service";
import { coreStackFromEnvFile } from "../stack-env";
import {
  Landed,
  claimJob,
  finishJob,
  knownFiles,
  markMissing,
  moviesLibrary,
  rowsOf,
  totalsOf,
  upsert,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("movies scanner callbacks", { timeout: 180_000 }, () => {
  it("write titles, episodes, and files, keep missing files' rows, and count all three", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Scanned");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const show = scannedTitle("show", "tmdb:1", "Pioneer One", 13);

    const items = [
      movieFile(join(root, "Sintel.mkv"), 10, 1, scannedTitle("movie", "tmdb:2", "Sintel", 13)),
      movieFile(join(root, "Tears.mkv"), 20, 1, scannedTitle("movie", "tmdb:3", "Tears", null)),
      episodeFile(join(root, "Pioneer", "s01e01.mkv"), show, 1, 1),
      episodeFile(join(root, "Pioneer", "s01e02.mkv"), show, 1, 2),
      episodeFile(join(root, "Pioneer", "s01e03.mkv"), show, 1, 3),
    ];

    const landed = await upsert(stack, lease, items);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    expect(landed.value.files).toHaveLength(5);
    expect(new Set(landed.value.files.map((file) => file.titleId)).size).toBe(3);

    const counted = { titles: 3, episodes: 3, files: 5 };

    expect(await totalsOf(stack, libraryId)).toEqual(counted);
    expect(await rowsOf(stack, libraryId)).toEqual(counted);
    expect((await admin.signedIn.client.query(api.core.libraries.get, { libraryId })).items).toBe(
      3,
    );

    expect(await upsert(stack, lease, items)).toMatchObject({ outcome: "held" });
    expect(await totalsOf(stack, libraryId)).toEqual(counted);

    const gone = join(root, "Pioneer", "s01e03.mkv");

    expect(await markMissing(stack, lease, [gone, gone])).toEqual({
      outcome: "held",
      value: { marked: 1 },
    });
    expect(await markMissing(stack, lease, [gone])).toEqual({
      outcome: "held",
      value: { marked: 0 },
    });

    const known = await knownFiles(stack, lease);

    expect(known.filter((file) => file.missing).map((file) => file.path)).toEqual([gone]);
    expect(await totalsOf(stack, libraryId)).toEqual(counted);

    await upsert(stack, lease, [episodeFile(gone, show, 1, 3)]);

    expect((await knownFiles(stack, lease)).some((file) => file.missing)).toBe(false);
    expect(await rowsOf(stack, libraryId)).toEqual(counted);
    await finishJob(stack, lease);
  });

  it("refuse a batch over 500 and a path outside the library's folders", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-bounds", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Bounded");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);

    const many = Array.from({ length: 501 }, (_, n) => movieFile(join(root, `${n}.mkv`)));

    await expect(upsert(stack, lease, many)).rejects.toThrow(/at most 500/u);
    await expect(upsert(stack, lease, [movieFile("/elsewhere/a.mkv")])).rejects.toThrow(
      /not a path inside/u,
    );
    await expect(
      markMissing(
        stack,
        lease,
        many.map((item) => item.file.path),
      ),
    ).rejects.toThrow(/at most 500/u);
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
    await finishJob(stack, lease);
  });

  it("write nothing for a canceled scan or for a lease the cron released", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-stale", "admin");
    const first = await moviesLibrary(admin, "Canceled");
    const lease = await claimJob(stack, "movies.scan", first.scanJobId);

    await runFunction(
      stack,
      internal.core.jobs.admin.cancel,
      { jobId: lease.jobId },
      Schema.Struct({ outcome: Schema.String }),
    );

    expect(await upsert(stack, lease, [movieFile(join(first.roots[0] ?? "", "a.mkv"))])).toEqual({
      outcome: "canceled",
    });
    expect(await totalsOf(stack, first.libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });

    const second = await moviesLibrary(admin, "Lapsed");
    const short = await claimJob(stack, "movies.scan", second.scanJobId, 5000);

    await eventually(
      "the cron to release the lapsed lease",
      async () => {
        const job = await admin.signedIn.client.query(api.core.libraries.get, {
          libraryId: second.libraryId,
        });

        return job.scan?.status === "queued" ? true : null;
      },
      60_000,
    );

    expect(
      await runServer(
        stack,
        api.movies.scanner.upsert,
        { lease: short, items: [movieFile(join(second.roots[0] ?? "", "a.mkv"))] },
        Landed,
      ),
    ).toEqual({ outcome: "lost" });
    expect(await totalsOf(stack, second.libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
  });
});
