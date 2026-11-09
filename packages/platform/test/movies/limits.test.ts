import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member } from "../devices";
import { openTitle, visibleTitles } from "../probe";
import { runServer } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
  answer,
  applyMetadataAll,
  askRefresh,
  cancelQueued,
  claimJob,
  finishJob,
  knownFiles,
  markMissingAll,
  moviesLibrary,
  purgePage,
  purgeStage,
  rowsOf,
  setFoldersQuietly,
  titleStateOf,
  totalsOf,
  upsert,
  upsertAll,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

/** The most genres a title keeps. */
const GENRES_HARD_MAX = 256;

const genres = (prefix: string, count: number): Array<string> =>
  Array.from({ length: count }, (_, n) => `${prefix} ${n}`);

const inside = (calls: ReadonlyArray<CallUsage>): boolean =>
  calls.every((call) => call.reads < READS_MAX && call.writes < WRITES_MAX);

const show = (n: number, prefix: string, count: number): ScannedItem["title"] => ({
  ...scannedTitle("show", `show:${n}`, `Show ${n}`),
  genres: genres(prefix, count),
});

type Episode = NonNullable<ScannedItem["episode"]>;

const episodeAt = (season: number, number: number): Episode => {
  const { episode } = episodeFile("/unused", show(0, "x", 0), season, number);

  if (episode === null) throw new Error("an episode file has an episode");

  return episode;
};

const Credited = answer(
  Schema.Struct({ written: Schema.Boolean, people: Schema.Array(Schema.Unknown) }),
);

const credits = (owner: number, offset: number) =>
  Array.from({ length: 100 }, (_, n) => ({
    person: {
      name: `Person ${owner}-${offset + n}`,
      externalIds: { tmdb: `${owner}-${offset + n}`, imdb: null, tvdb: null },
      profile: null,
    },
    kind: "actor" as const,
    role: null,
    order: n,
  }));

describe.skipIf(stack === undefined)("movies call budgets", { timeout: 900_000 }, () => {
  it("write the worst upsert, every genre replaced on 256-genre shows, partly a call, inside its limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "budget-upsert", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Worst upsert");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId, 600_000);
    const paths = Array.from({ length: 30 }, (_, n) => join(root, `${n}.mkv`));

    const shows = (prefix: string, episode: number, size: number): ReadonlyArray<ScannedItem> =>
      paths.map((path, n) =>
        episodeFile(path, show(n, prefix, GENRES_HARD_MAX), episode, episode, true, size),
      );

    const mark = await logMark(stack);

    await upsertAll(stack, lease, shows("first", 1, 1));

    // Each show rewritten with all 256 genre rows replaced, its file moved to another episode,
    // and its thumbnails queued again: far more than one call may do.
    const written = await upsertAll(stack, lease, shows("second", 2, 2));
    const usage = await usageSince(stack, mark, api.movies.scanner.upsert, written.length + 1);

    expect(written.length).toBeGreaterThan(1);
    expect(Math.min(...written)).toBeGreaterThanOrEqual(1);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 30, episodes: 60, files: 30 });
    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");
  });

  it("mark 500 files missing whose thumbnail jobs are queued, partly a call, inside its limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "budget-missing", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Worst missing");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId, 600_000);

    const items = Array.from({ length: 500 }, (_, n) =>
      movieFile(join(root, `${n}.mkv`), 1, 1, scannedTitle("movie", `m:${n}`, `Movie ${n}`), true),
    );

    await upsertAll(stack, lease, items);

    const mark = await logMark(stack);

    const done = await markMissingAll(
      stack,
      lease,
      items.map((item) => item.file.path),
    );

    const usage = await usageSince(stack, mark, api.movies.scanner.missing, done.length);

    expect(done.length).toBeGreaterThan(1);
    expect(done.reduce((sum, one) => sum + one, 0)).toBe(500);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect((await knownFiles(stack, lease)).every((file) => file.missing)).toBe(true);
    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");
  });

  it("write a 256-genre show's metadata and 500 episodes, partly a call, inside its limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "budget-metadata", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Worst metadata");
    const scan = await claimJob(stack, "movies.scan", scanJobId);

    const landed = await upsert(stack, scan, [
      episodeFile(join(roots[0] ?? "", "1.mkv"), show(0, "first", GENRES_HARD_MAX), 1, 1),
    ]);

    await finishJob(stack, scan);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const titleId = landed.value.files[0]?.titleId;

    if (titleId === undefined) throw new Error("no title landed");

    const jobId = await askRefresh(stack, titleId);

    const lease = await claimJob(stack, "movies.metadata", jobId);
    const episodes = Array.from({ length: 500 }, (_, n) => episodeAt(1 + (n % 10), n + 2));
    const mark = await logMark(stack);

    const { written } = await applyMetadataAll(
      stack,
      lease,
      titleId,
      show(0, "second", GENRES_HARD_MAX),
      episodes,
    );

    const usage = await usageSince(stack, mark, api.movies.metadata.applyMetadata, written.length);

    expect(written.length).toBeGreaterThan(1);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await titleStateOf(stack, titleId)).toMatchObject({
      episodes: 501,
      genres: GENRES_HARD_MAX,
      seasonsHoldEpisodes: true,
    });
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 1, episodes: 501, files: 1 });
    await finishJob(stack, lease);
  });

  it("purge ten big shows page by page, partly a title a call, keeping totals to live rows", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "budget-purge", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Worst purge", 2);
    const [kept, dropped] = roots;

    if (kept === undefined || dropped === undefined) throw new Error("made too few folders");

    const lease = await claimJob(stack, "movies.scan", scanJobId, 600_000);

    const titleIds = await Array.from({ length: 10 }, (_, s) => s).reduce<
      Promise<ReadonlyArray<Id<"titles">>>
    >(async (previous, s) => {
      const done = await previous;

      const items = Array.from({ length: 200 }, (_, e) =>
        episodeFile(join(dropped, `${s}`, `${e}.mkv`), show(s, "purge", 20), 1 + (e % 10), e),
      );

      await upsertAll(stack, lease, items.slice(1));

      const first = await upsert(stack, lease, items.slice(0, 1));

      if (first.outcome !== "held") throw new Error(`upsert answered ${first.outcome}`);

      const landed = first.value.files[0];

      if (landed?.episodeId === null || landed === undefined) throw new Error("no episode");

      const { titleId, episodeId } = landed;

      await runServer(
        stack,
        api.movies.metadata.applyCredits,
        { lease, titleId, episodeId: null, credits: credits(s, 0), hash: "t" },
        Credited,
      );
      await runServer(
        stack,
        api.movies.metadata.applyCredits,
        { lease, titleId, episodeId, credits: credits(s, 100), hash: "e" },
        Credited,
      );

      return [...done, titleId];
    }, Promise.resolve([]));

    await finishJob(stack, lease);
    await setFoldersQuietly(stack, libraryId, [kept]);
    await purgeStage(stack, libraryId, "files");

    expect(await totalsOf(stack, libraryId)).toEqual(await rowsOf(stack, libraryId));

    const mark = await logMark(stack);

    const pages = async (cursor: string | null = null, count = 0): Promise<number> => {
      const next = await purgePage(stack, libraryId, "titles", cursor);

      expect(await totalsOf(stack, libraryId)).toEqual(await rowsOf(stack, libraryId));

      const states = await Promise.all(titleIds.map(async (id) => titleStateOf(stack, id)));
      const purging = titleIds.filter((_, n) => states[n]?.purging === true);
      const listed = new Set<string>(await visibleTitles(stack, admin, libraryId));

      expect(purging.some((id) => listed.has(id))).toBe(false);
      expect(
        await Promise.all(purging.map(async (id) => refusal(openTitle(stack, admin, id)))),
      ).toEqual(purging.map(() => "not_found"));

      if (count > 200) throw new Error("the purge made no progress");

      return next.more ? pages(next.cursor, count + 1) : count + 1;
    };

    const called = await pages();
    const usage = await usageSince(stack, mark, internal.movies.probe.purgePage, called);

    expect(called).toBeGreaterThan(1);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await Promise.all(titleIds.map(async (id) => titleStateOf(stack, id)))).toEqual(
      titleIds.map(() => null),
    );
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
  });
});
