import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import { coreStackFromEnvFile } from "../stack-env";
import {
  claimJob,
  finishJob,
  hasRows,
  hasTotals,
  moviesLibrary,
  rowsOf,
  totalsOf,
  upsert,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("the movies purge", { timeout: 180_000 }, () => {
  it("drop a removed folder's rows from the totals, then everything of a removed library", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "purge-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Purged", 2);
    const [kept, dropped] = roots;

    if (kept === undefined || dropped === undefined) throw new Error("made too few folders");

    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const show = scannedTitle("show", "tmdb:7", "Split show");

    await upsert(
      stack,
      lease,
      [
        ...Array.from({ length: 600 }, (_, n) => movieFile(join(kept, `kept-${n}.mkv`))),
        episodeFile(join(kept, "show", "e1.mkv"), show, 1, 1),
        episodeFile(join(dropped, "show", "e2.mkv"), show, 1, 2),
      ].slice(0, 500),
    );
    await upsert(stack, lease, [
      ...Array.from({ length: 100 }, (_, n) => movieFile(join(kept, `kept-${n + 500}.mkv`))),
      episodeFile(join(kept, "show", "e1.mkv"), show, 1, 1),
      episodeFile(join(dropped, "show", "e2.mkv"), show, 1, 2),
      ...Array.from({ length: 30 }, (_, n) => movieFile(join(dropped, `dropped-${n}.mkv`))),
    ]);

    const before = { titles: 631, episodes: 2, files: 632 };

    expect(await totalsOf(stack, libraryId)).toEqual(before);
    expect(await rowsOf(stack, libraryId)).toEqual(before);
    await finishJob(stack, lease);

    await admin.signedIn.client.mutation(api.core.libraries.setFolders, {
      libraryId,
      folders: [kept],
    });

    const after = { titles: 601, episodes: 2, files: 601 };

    expect(
      await eventually(
        "the dropped folder's rows to leave the totals",
        async () => {
          const totals = await totalsOf(stack, libraryId);

          return totals.titles === after.titles && totals.files === after.files ? totals : null;
        },
        60_000,
      ),
    ).toEqual(after);
    expect(await rowsOf(stack, libraryId)).toEqual(after);
    expect((await admin.signedIn.client.query(api.core.libraries.get, { libraryId })).items).toBe(
      after.titles,
    );

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });

    expect(
      await eventually(
        "the removed library's rows and totals to go",
        async () =>
          (await hasRows(stack, libraryId)) || (await hasTotals(stack, libraryId)) ? null : true,
        120_000,
      ),
    ).toBe(true);
  });
});
