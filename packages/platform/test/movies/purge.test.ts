import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import { openTitle, visibleTitles } from "../probe";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
  claimJob,
  finishJob,
  hasRows,
  hasTotals,
  moviesLibrary,
  rowsOf,
  purgePage,
  purgeStage,
  setFoldersQuietly,
  titleStateOf,
  totalsOf,
  upsert,
  upsertAll,
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

    const items = [
      ...Array.from({ length: 600 }, (_, n) => movieFile(join(kept, `kept-${n}.mkv`))),
      episodeFile(join(kept, "show", "e1.mkv"), show, 1, 1),
      episodeFile(join(dropped, "show", "e2.mkv"), show, 1, 2),
      ...Array.from({ length: 30 }, (_, n) => movieFile(join(dropped, `dropped-${n}.mkv`))),
    ];

    await upsertAll(stack, lease, items);

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

  it("build a new title for a show that returns while the purge is deleting its old one", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "purge-return", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Returning", 3);
    const [kept, dropped, moved] = roots;

    if (kept === undefined || dropped === undefined || moved === undefined) {
      throw new Error("made too few folders");
    }

    const show = { ...scannedTitle("show", "tmdb:11", "Long show"), genres: ["Drama"] };
    const first = await claimJob(stack, "movies.scan", scanJobId);

    await upsertAll(
      stack,
      first,
      Array.from({ length: 200 }, (_, n) =>
        episodeFile(join(dropped, `${n + 1}.mkv`), show, 1, n + 1),
      ),
    );

    const landed = await upsert(stack, first, [
      episodeFile(join(dropped, "201.mkv"), show, 1, 201),
    ]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    await finishJob(stack, first);

    const oldTitle = landed.value.files[0]?.titleId;

    if (oldTitle === undefined) throw new Error("no title landed");

    await setFoldersQuietly(stack, libraryId, [kept]);
    await purgeStage(stack, libraryId, "files");

    // A page that stops partway through the show's episodes.
    expect(await purgePage(stack, libraryId, "titles", null, 150)).toMatchObject({ more: true });
    expect(await titleStateOf(stack, oldTitle)).toMatchObject({ purging: true });

    // Out of every read, list, and total from the page that marked it.
    expect(await refusal(openTitle(stack, admin, oldTitle))).toBe("not_found");
    expect(await visibleTitles(stack, admin, libraryId)).not.toContain(oldTitle);
    expect(await totalsOf(stack, libraryId)).toEqual(await rowsOf(stack, libraryId));
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });

    await setFoldersQuietly(stack, libraryId, [kept, dropped, moved]);

    const { jobId } = await admin.signedIn.client.mutation(api.core.libraries.scan, { libraryId });
    const second = await claimJob(stack, "movies.scan", jobId);

    const returned = await upsert(stack, second, [
      episodeFile(join(dropped, "201.mkv"), show, 1, 201),
      episodeFile(join(moved, "202.mkv"), show, 1, 202),
    ]);

    await finishJob(stack, second);

    if (returned.outcome !== "held") throw new Error(`upsert answered ${returned.outcome}`);

    const newTitles = new Set(returned.value.files.map((file) => file.titleId));
    const [newTitle] = newTitles;

    expect(newTitles.size).toBe(1);
    expect(newTitle).not.toBe(oldTitle);
    expect((await admin.signedIn.client.query(api.core.libraries.get, { libraryId })).items).toBe(
      1,
    );
    expect(await totalsOf(stack, libraryId)).toEqual(await rowsOf(stack, libraryId));

    await purgeStage(stack, libraryId, "titles");

    expect(await titleStateOf(stack, oldTitle)).toBeNull();

    if (newTitle === undefined) throw new Error("no new title");

    expect(await titleStateOf(stack, newTitle)).toEqual({
      purging: false,
      episodes: 2,
      seasons: 1,
      genres: 1,
      seasonsHoldEpisodes: true,
    });
    expect(await totalsOf(stack, libraryId)).toEqual(await rowsOf(stack, libraryId));
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 1, episodes: 2, files: 2 });
  });
});
