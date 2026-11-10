import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { logMark, runFunction, usageSince } from "../admin";
import { retrying } from "../core/jobs/driver";
import { member } from "../devices";
import { runServer } from "../service";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  PersonId,
  answer,
  claimJob,
  finishJob,
  knownFiles,
  moviesLibrary,
  upsert,
  upsertAll,
} from "./catalog";
import type { Lease } from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";
import { seasonOf } from "./shelf";

const stack = coreStackFromEnvFile();

/** What one call may read in bytes: Convex's limit. */
const BYTES_MAX = 16 * 1024 * 1024;

/** Text far past every bound, as a broken or hostile provider might send it. */
const absurd = (length: number, fill = "x") => fill.repeat(length);

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered these through a `v.id(...)` validator, which checks each again when sent back.
const isId =
  <Table extends "libraries" | "titles">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const Seeded = Schema.Array(
  Schema.Struct({
    libraryId: Schema.declare(isId("libraries")),
    titles: Schema.Array(Schema.Struct({ titleId: Schema.declare(isId("titles")) })),
  }),
);

const Credits = answer(
  Schema.Struct({
    written: Schema.Boolean,
    people: Schema.Array(Schema.Struct({ personId: PersonId })),
  }),
);

const Target = Schema.Struct({
  episodes: Schema.Array(Schema.Struct({ episodeNumber: Schema.Finite })),
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

const credit = (name: string, order: number, profile: string | null) => ({
  person: { name, externalIds: { tmdb: null, imdb: null, tvdb: null }, profile },
  kind: "actor" as const,
  role: null,
  order,
});

/** Every committed call of `callable` since `mark` read under Convex's byte limit. */
const readWithinLimit = async (
  core: CoreStack,
  mark: Awaited<ReturnType<typeof logMark>>,
  callable: Parameters<typeof usageSince>[2],
): Promise<void> => {
  const usage = (await usageSince(core, mark, callable, 1)).filter((call) => call.committed);

  expect(usage.length).toBeGreaterThan(0);

  for (const call of usage) expect(call.bytes).toBeLessThan(BYTES_MAX);
};

/**
 * Writes `items` under the scan `lease`, `perCall` a call and what a call's budget left again, and
 * answers the title the first of them landed in.
 */
const landAll = async (
  core: CoreStack,
  lease: Lease,
  items: ReadonlyArray<ScannedItem>,
  perCall: number,
): Promise<Id<"titles">> => {
  const batches = Array.from({ length: Math.ceil(items.length / perCall) }, (_, n) =>
    items.slice(n * perCall, (n + 1) * perCall),
  );

  const titleIds = await inOrder(batches, async (batch) => {
    const landed = await upsert(core, lease, batch);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    await upsertAll(core, lease, batch.slice(landed.value.done));

    return landed.value.files[0]?.titleId;
  });

  const [titleId] = titleIds;

  if (titleId === undefined) throw new Error("no title landed");

  return titleId;
};

describe.skipIf(stack === undefined)(
  "movies documents within their bounds",
  { timeout: 600_000 },
  () => {
    it("fit a person's merged profile, so a search never reads past 16 MiB", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-people-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound people ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);

      const titleId = await landAll(
        stack,
        lease,
        [
          movieFile(
            join(roots[0] ?? "", "a.mkv"),
            1,
            1,
            scannedTitle("movie", "nfo:p", "Credited"),
          ),
        ],
        1,
      );

      const names = Array.from({ length: 20 }, (_, n) => `Bounded ${label} ${n}`);

      const creditAll = (credits: ReadonlyArray<ReturnType<typeof credit>>, hash: string) =>
        retrying(async () =>
          runServer(
            stack,
            api.movies.metadata.applyCredits,
            { lease, titleId, episodeId: null, credits: [...credits], hash },
            Credits,
          ),
        );

      await creditAll(
        names.map((name, order) => credit(name, order, null)),
        `${label}-0`,
      );

      // The people exist now, so each of these merges a profile into a stored person.
      await inOrder([0, 1, 2, 3, 4], async (part) =>
        creditAll(
          names
            .slice(part * 4, part * 4 + 4)
            .map((name, order) => credit(name, order, absurd(900_000, "p"))),
          `${label}-${part + 1}`,
        ),
      );

      const mark = await logMark(stack);

      const found = await admin.signedIn.client.query(api.movies.people.search, {
        query: `Bounded ${label}`,
      });

      expect(found.length).toBeGreaterThan(0);
      await readWithinLimit(stack, mark, api.movies.people.search);

      const personId = found[0]?.id;

      if (personId === undefined) throw new Error("no person found");

      const person = await admin.signedIn.client.query(api.movies.people.get, { personId });

      expect(person.profile?.length ?? 0).toBeGreaterThan(0);
      expect(person.profile?.length ?? 0).toBeLessThan(900_000);

      await finishJob(stack, lease);
    });

    it("fit the probe's seeded titles, so counting genres never reads past 16 MiB", async () => {
      if (stack === undefined) return;

      const label = unique();
      const viewer = await member(stack, `bound-seed-${label}`);

      await inOrder(
        Array.from({ length: 33 }, (_, n) => n),
        async (n) =>
          retrying(async () =>
            runFunction(
              stack,
              internal.movies.probe.seed,
              {
                managerId: viewer.userId,
                libraries: [
                  {
                    name: `bound seed ${label} ${n}`,
                    titles: [
                      {
                        name: `Seeded ${label} ${n}`,
                        age: 0,
                        episodes: 0,
                        genres: [`seeded${label}`],
                        overview: absurd(900_000),
                      },
                    ],
                  },
                ],
                viewers: [],
              },
              Seeded,
            ),
          ),
      );

      const mark = await logMark(stack);
      const genres = await viewer.signedIn.client.query(api.movies.titles.genres, {});

      expect(genres.find((genre) => genre.name === `seeded${label}`)?.count).toBe(33);
      await readWithinLimit(stack, mark, api.movies.titles.genres);
    });

    it("store an episode's id past its maximum as null and keep the episode", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-ids-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound ids ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);
      const show = scannedTitle("show", "nfo:ids", `Long Ids ${label}`);

      const items = Array.from({ length: 200 }, (_, n) => {
        const item = episodeFile(join(roots[0] ?? "", `${n + 1}.mkv`), show, 1, n + 1);

        return item.episode === null
          ? item
          : {
              ...item,
              episode: {
                ...item.episode,
                externalIds: { tmdb: null, imdb: null, tvdb: absurd(100_000, "z") },
              },
            };
      });

      const titleId = await landAll(stack, lease, items, 40);

      await finishJob(stack, lease);
      const mark = await logMark(stack);

      const target = await runServer(
        stack,
        api.movies.metadata.metadataTarget,
        { titleId, cursor: null },
        Target,
      );

      expect(target.episodes.length).toBeGreaterThan(0);
      await readWithinLimit(stack, mark, api.movies.metadata.metadataTarget);

      const episodes = await seasonOf(admin.signedIn.client, titleId, 1);

      expect(episodes).toHaveLength(200);
      expect(episodes.every((episode) => episode.externalIds.tvdb === null)).toBe(true);
    });

    it("keep two people whose long names differ only at the end apart, and find each again", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-keys-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound keys ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);

      const titleId = await landAll(
        stack,
        lease,
        [movieFile(join(roots[0] ?? "", "a.mkv"), 1, 1, scannedTitle("movie", "nfo:k", "Keyed"))],
        1,
      );

      const long = `${label} ${absurd(600, "n")}`;

      const creditOf = async (names: ReadonlyArray<string>, hash: string) => {
        const answered = await runServer(
          stack,
          api.movies.metadata.applyCredits,
          {
            lease,
            titleId,
            episodeId: null,
            credits: names.map((name, order) => credit(name, order, null)),
            hash,
          },
          Credits,
        );

        if (answered.outcome !== "held") throw new Error(`credits answered ${answered.outcome}`);

        return answered.value.people.map((person) => person.personId);
      };

      const [first, second] = await creditOf([`${long} A`, `${long} B`], `${label}-1`);

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first).not.toBe(second);
      expect(await creditOf([`${long} B`, `${long} A`], `${label}-2`)).toEqual([second, first]);

      await finishJob(stack, lease);
    });

    it("keep two titles whose long match keys differ only at the end apart across rescans", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-match-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound match ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);
      const key = `nfo:${label}:${absurd(600, "k")}`;

      const fileOf = (name: string, suffix: string) =>
        movieFile(
          join(roots[0] ?? "", `${name}.mkv`),
          1,
          1,
          scannedTitle("movie", `${key}${suffix}`, name),
        );

      const first = await landAll(stack, lease, [fileOf("A", "A")], 1);
      const second = await landAll(stack, lease, [fileOf("B", "B")], 1);

      expect(second).not.toBe(first);
      expect(await landAll(stack, lease, [fileOf("A", "A")], 1)).toBe(first);
      expect(await landAll(stack, lease, [fileOf("A again", "A")], 1)).toBe(first);
      expect(await landAll(stack, lease, [fileOf("B", "B")], 1)).toBe(second);

      await finishJob(stack, lease);

      const names = await Promise.all(
        [first, second].map(
          async (titleId) =>
            (await admin.signedIn.client.query(api.movies.titles.get, { titleId })).name,
        ),
      );

      expect(names).toEqual(["A again", "B"]);
    });

    it("fit media files with long chapter titles, so listing known files never reads past 16 MiB", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-files-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound files ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);
      const film = scannedTitle("movie", `nfo:${label}`, "Chaptered");

      const items = Array.from({ length: 20 }, (_, n) => {
        const item = movieFile(join(roots[0] ?? "", `${n}.mkv`), 1, 1, film);

        return {
          ...item,
          file: {
            ...item.file,
            probe: {
              ...item.file.probe,
              chapters: [{ startMs: 0, endMs: 1000, title: absurd(900_000, "c") }],
            },
          },
        };
      });

      await inOrder(
        Array.from({ length: 5 }, (_, n) => items.slice(n * 4, n * 4 + 4)),
        async (batch) => retrying(async () => landAll(stack, lease, batch, 4)),
      );

      const mark = await logMark(stack);

      expect(await knownFiles(stack, lease)).toHaveLength(20);
      await readWithinLimit(stack, mark, api.movies.scanner.known);
      await finishJob(stack, lease);
    });

    it("fit a media file whose probe alone is past Convex's document maximum", async () => {
      if (stack === undefined) return;

      const label = unique();
      const admin = await member(stack, `bound-probe-${label}`, "admin");
      const { scanJobId, roots } = await moviesLibrary(admin, `bound probe ${label}`);
      const lease = await claimJob(stack, "movies.scan", scanJobId, 300_000);

      const item = movieFile(
        join(roots[0] ?? "", "huge.mkv"),
        1,
        1,
        scannedTitle("movie", `nfo:${label}`, "Huge"),
      );

      const titleId = await landAll(
        stack,
        lease,
        [
          {
            ...item,
            file: { ...item.file, probe: { ...item.file.probe, container: absurd(1_100_000) } },
          },
        ],
        1,
      );

      expect(await knownFiles(stack, lease)).toHaveLength(1);
      await finishJob(stack, lease);

      const versions = await admin.signedIn.client.query(api.movies.titles.versions, { titleId });

      expect(versions.length).toBe(1);
    });
  },
);
