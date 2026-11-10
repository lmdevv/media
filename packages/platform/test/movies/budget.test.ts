import type { FunctionReference } from "convex/server";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { logMark, runFunction, usageSince } from "../admin";
import { retrying } from "../core/jobs/driver";
import { member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { seedLibraries, share, song } from "../probe";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

/** What one call may read: Convex's limit, which a passing call stayed under for ranges. */
const DOCUMENTS_MAX = 32_000;

/** What one call may read in bytes: Convex's limit. */
const BYTES_MAX = 16 * 1024 * 1024;

/**
 * What counting the 1,000 newest titles across 33 libraries of 300 may read: the titles it needs
 * and a little more, never 300 from each library as a per-library minimum would.
 */
const GENRES_DOCUMENTS_MAX = 5_000;

type Callable = FunctionReference<"query" | "mutation">;

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered these through a `v.id(...)` validator, which checks each again when sent back.
const isId =
  <Table extends "libraries" | "titles" | "episodes" | "collections" | "people">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const Seeded = Schema.Array(
  Schema.Struct({
    libraryId: Schema.declare(isId("libraries")),
    titles: Schema.Array(
      Schema.Struct({
        titleId: Schema.declare(isId("titles")),
        episodeIds: Schema.Array(Schema.declare(isId("episodes"))),
      }),
    ),
  }),
);

type SeededLibrary = (typeof Seeded.Type)[number];

interface Title {
  readonly name: string;
  readonly age: number | null;
  readonly episodes: number;
  readonly genres?: ReadonlyArray<string>;
  readonly overview?: string;
}

/** Seeds movies libraries `manager` manages, 200 a call, each shared `view` with `viewers`. */
const seedMovies = async (
  core: CoreStack,
  manager: Member,
  libraries: ReadonlyArray<{ readonly name: string; readonly titles: ReadonlyArray<Title> }>,
  viewers: ReadonlyArray<Id<"users">> = [],
  perCall = 200,
): Promise<ReadonlyArray<SeededLibrary>> => {
  const batches = Array.from({ length: Math.ceil(libraries.length / perCall) }, (_, n) =>
    libraries.slice(n * perCall, (n + 1) * perCall),
  );

  const seeded = await inOrder(batches, async (batch) =>
    retrying(async () =>
      runFunction(
        core,
        internal.movies.probe.seed,
        {
          managerId: manager.userId,
          libraries: batch.map((library) => ({
            name: library.name,
            titles: library.titles.map((title) => ({
              ...title,
              genres: [...(title.genres ?? [])],
            })),
          })),
          viewers: [...viewers],
        },
        Seeded,
      ),
    ),
  );

  return seeded.flat();
};

/** Puts `who` in 16 groups, the most a person may be in, so each library check reads 18 grants. */
const inEveryGroup = async (core: CoreStack, who: Member): Promise<void> => {
  const admin = await sharedAdmin(core);

  await inOrder(
    Array.from({ length: 16 }, (_, n) => n),
    async (n) => {
      const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
        name: `budget-${unique()}-${n}`,
      });

      await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
        groupId,
        userId: who.userId,
      });
    },
  );
};

/** The documents each committed call of `callable` since `mark` read, at least `calls` of them. */
const documentsRead = async (
  core: CoreStack,
  mark: Awaited<ReturnType<typeof logMark>>,
  callable: Callable,
  calls = 1,
): Promise<ReadonlyArray<number>> =>
  (await usageSince(core, mark, callable, calls))
    .filter((call) => call.committed)
    .map((call) => call.reads);

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const titleOf = (library: SeededLibrary | undefined): Id<"titles"> => {
  const titleId = library?.titles[0]?.titleId;

  if (titleId === undefined) throw new Error("no title seeded");

  return titleId;
};

describe.skipIf(stack === undefined)("movies reads within one call", { timeout: 900_000 }, () => {
  it("walk past 800 shared music libraries to a movie, in 16 groups", async () => {
    if (stack === undefined) return;

    const label = unique();
    const manager = await member(stack, "walk-manager");
    const viewer = await member(stack, "walk-viewer");

    await inEveryGroup(stack, viewer);

    const music = await seedLibraries(
      stack,
      manager,
      Array.from({ length: 1200 }, (_, n) => ({
        name: `walk tunes ${label} ${n}`,
        kind: "music" as const,
        items: [song(`song ${n}`, false)],
      })),
    );

    const films = await seedMovies(
      stack,
      manager,
      Array.from({ length: 20 }, (_, n) => ({
        name: `walk films ${label} ${n}`,
        titles: [{ name: `Walk ${label} ${n}`, age: 0, episodes: 0, genres: [`walk${label}`] }],
      })),
    );

    const musicIds = music.map((library) => library.libraryId).toSorted(byCodeUnits);
    const before = (id: string) => musicIds.filter((other) => byCodeUnits(other, id) < 0);

    const film = films
      .filter((library) => before(library.libraryId).length >= 800)
      .toSorted((left, right) => byCodeUnits(left.libraryId, right.libraryId))[0];

    if (film === undefined) throw new Error("no movies library sorts after 800 music libraries");

    const principal = { kind: "user", userId: viewer.userId } as const;

    await inOrder([...before(film.libraryId).slice(0, 800), film.libraryId], async (libraryId) =>
      share(manager, libraryId, principal, "view"),
    );

    const mark = await logMark(stack);
    const home = await viewer.signedIn.client.query(api.movies.titles.home, {});
    const genres = await viewer.signedIn.client.query(api.movies.titles.genres, {});

    expect(home.recentlyAddedMovies.map((title) => title.id)).toContain(titleOf(film));
    expect(genres.map((genre) => genre.name)).toContain(`walk${label}`);

    for (const read of await documentsRead(stack, mark, api.movies.titles.home)) {
      expect(read).toBeLessThan(DOCUMENTS_MAX);
    }
  });

  it("count genres of the 1,000 newest titles across 33 libraries, reading little more", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "genres-viewer");

    const seeded = await seedMovies(
      stack,
      viewer,
      Array.from({ length: 33 }, (_, n) => ({
        name: `genres ${label} ${n}`,
        titles: Array.from({ length: 300 }, (__, t) => ({
          name: `Genre ${label} ${n} ${t}`,
          age: 0,
          episodes: 0,
          genres: [n % 2 === 0 ? `even${label}` : `odd${label}`],
        })),
      })),
      [],
      1,
    );

    expect(seeded).toHaveLength(33);

    const mark = await logMark(stack);
    const genres = await viewer.signedIn.client.query(api.movies.titles.genres, {});
    const ours = genres.filter((genre) => genre.name.endsWith(label));

    expect(ours).toEqual([
      { name: `even${label}`, count: 600 },
      { name: `odd${label}`, count: 400 },
    ]);

    const similar = await viewer.signedIn.client.query(api.movies.titles.similar, {
      titleId: titleOf(seeded[0]),
    });

    expect(similar.length).toBeGreaterThan(0);

    for (const read of await documentsRead(stack, mark, api.movies.titles.genres)) {
      expect(read).toBeLessThan(GENRES_DOCUMENTS_MAX);
    }
  });

  it("count genres of titles with long overviews without reading past 16 MiB", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "rich-viewer");
    const overview = `A family returns home after years abroad. `.repeat(400).slice(0, 16 * 1024);

    await seedMovies(
      stack,
      viewer,
      Array.from({ length: 6 }, (_, n) => ({
        name: `rich ${label} ${n}`,
        titles: Array.from({ length: 200 }, (__, t) => ({
          name: `Rich ${label} ${n} ${t}`,
          age: 0,
          episodes: 0,
          genres: [`rich${label}`],
          overview,
        })),
      })),
      [],
      1,
    );

    const mark = await logMark(stack);
    const genres = await viewer.signedIn.client.query(api.movies.titles.genres, {});

    expect(genres.find((genre) => genre.name === `rich${label}`)?.count).toBeGreaterThan(0);

    const usage = await usageSince(stack, mark, api.movies.titles.genres, 1);

    for (const call of usage.filter((one) => one.committed)) {
      expect(call.bytes).toBeGreaterThan(0);
      expect(call.bytes).toBeLessThan(BYTES_MAX);
      expect(call.reads).toBeLessThan(DOCUMENTS_MAX);
    }
  });

  it("show home rows of a mixed library from its own index per kind", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "mixed-viewer");

    const [library] = await seedMovies(stack, viewer, [
      {
        name: `mixed ${label}`,
        titles: [
          { name: `Older Show ${label}`, age: 0, episodes: 1 },
          ...Array.from({ length: 2000 }, (_, n) => ({
            name: `Newer Movie ${label} ${n}`,
            age: 0,
            episodes: 0,
          })),
        ],
      },
    ]);

    const showId = titleOf(library);
    const home = await viewer.signedIn.client.query(api.movies.titles.home, {});

    expect(home.recentlyAddedShows.map((title) => title.id)).toContain(showId);
    expect(home.recentlyAddedMovies).toHaveLength(20);
  });

  it("list every collection a page at a time, however many titles each holds", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "paged-collections");

    const [library] = await seedMovies(stack, viewer, [
      {
        name: `collected ${label}`,
        titles: Array.from({ length: 200 }, (_, n) => ({
          name: `Collected ${label} ${n}`,
          age: 0,
          episodes: 0,
        })),
      },
    ]);

    const titleIds = (library?.titles ?? []).map((title) => title.titleId);

    const made = await inOrder(
      Array.from({ length: 20 }, (_, n) => n),
      async (n) =>
        runFunction(
          stack,
          internal.movies.probe.seedCollection,
          {
            name: `aaa collection ${label} ${String(n).padStart(2, "0")}`,
            titleIds: [...titleIds],
          },
          Schema.declare(isId("collections")),
        ),
    );

    const listed = await listCollections(viewer, new Set(made));

    expect(listed.map((entry) => entry.id).toSorted()).toEqual([...made].toSorted());
    expect(listed.every((entry) => entry.titles > 0)).toBe(true);
  });

  it("list a collection only once a member of it is visible, however much deciding costs", async () => {
    if (stack === undefined) return;

    const label = unique();
    const manager = await member(stack, "unseen-manager");
    const viewer = await member(stack, "unseen-viewer");

    await inEveryGroup(stack, viewer);

    const hidden = await seedMovies(
      stack,
      manager,
      Array.from({ length: 200 }, (_, n) => ({
        name: `unseen ${label} ${n}`,
        titles: [{ name: `Unseen ${label} ${n}`, age: 0, episodes: 0 }],
      })),
    );

    const [shared] = await seedMovies(
      stack,
      manager,
      [{ name: `seen ${label}`, titles: [{ name: `Seen ${label}`, age: 0, episodes: 0 }] }],
      [viewer.userId],
    );

    const hiddenTitles = hidden.map((library) => titleOf(library));

    const collect = (name: string, titleIds: ReadonlyArray<Id<"titles">>) =>
      runFunction(
        stack,
        internal.movies.probe.seedCollection,
        { name, titleIds: [...titleIds] },
        Schema.declare(isId("collections")),
      );

    // Deciding all 200 members, each in a library of its own, costs more than one call can pay.
    const unseen = await collect(`aaa unseen ${label}`, hiddenTitles);

    const seenLast = await collect(`aaa unseen ${label} last`, [
      ...hiddenTitles.slice(0, 199),
      titleOf(shared),
    ]);

    expect(await listCollections(viewer, new Set([unseen, seenLast]))).toEqual([
      { id: seenLast, titles: 1 },
    ]);
  });

  it("list, open, and credit across 300 libraries of one title each, in 16 groups", async () => {
    if (stack === undefined) return;

    const label = unique();
    const manager = await member(stack, "wide-manager");
    const viewer = await member(stack, "wide-viewer");

    await inEveryGroup(stack, viewer);

    const wide = await seedMovies(
      stack,
      manager,
      Array.from({ length: 300 }, (_, n) => ({
        name: `wide ${label} ${n}`,
        titles: [{ name: `Wide ${label} ${n}`, age: 0, episodes: 1 }],
      })),
      [viewer.userId],
    );

    const hidden = await seedMovies(
      stack,
      manager,
      Array.from({ length: 300 }, (_, n) => ({
        name: `hidden ${label} ${n}`,
        titles: [{ name: `Hidden ${label} ${n}`, age: 0, episodes: 0 }],
      })),
    );

    const wideTitles = wide.map((library) => titleOf(library));
    const client = viewer.signedIn.client;

    const collections = await inOrder(
      Array.from({ length: 20 }, (_, n) => n),
      async (n) =>
        runFunction(
          stack,
          internal.movies.probe.seedCollection,
          {
            name: `aaa wide ${label} ${String(n).padStart(2, "0")}`,
            titleIds: wideTitles.slice(n * 12, (n + 1) * 12),
          },
          Schema.declare(isId("collections")),
        ),
    );

    const mark = await logMark(stack);
    const listed = await listCollections(viewer, new Set(collections));

    expect(listed.map((entry) => entry.id).toSorted()).toEqual([...collections].toSorted());

    const [firstCollection] = collections;

    if (firstCollection === undefined) throw new Error("no collection seeded");

    const opened = await client.query(api.movies.collections.get, {
      collectionId: firstCollection,
    });

    expect(opened.titles).toHaveLength(12);

    const personId = await runFunction(
      stack,
      internal.movies.probe.seedCredits,
      { name: `Wide Actor ${label}`, titleIds: wideTitles.slice(0, 300) },
      Schema.declare(isId("people")),
    );

    const person = await client.query(api.movies.people.get, { personId });
    const credited = new Set<string>(wideTitles.slice(0, 300));

    expect(person.credits.length).toBeGreaterThan(0);
    expect(person.credits.every((credit) => credited.has(credit.title.id))).toBe(true);

    await inOrder(
      Array.from({ length: 15 }, (_, n) => n),
      async (n) =>
        runFunction(
          stack,
          internal.movies.probe.seedCredits,
          {
            name: `Searchable ${label} ${n}`,
            titleIds: hidden.slice(n * 20, (n + 1) * 20).map((library) => titleOf(library)),
          },
          Schema.declare(isId("people")),
        ),
    );

    expect(await client.query(api.movies.people.search, { query: `Searchable ${label}` })).toEqual(
      [],
    );

    await inOrder(wide.slice(0, 200), async (library) => {
      const episodeId = library.titles[0]?.episodeIds[0];

      if (episodeId === undefined) throw new Error("no episode seeded");

      return client.mutation(api.movies.history.markWatched, {
        titleId: titleOf(library),
        episodeId,
      });
    });

    const history = await historyOf(viewer);

    expect(new Set(history).size).toBe(200);
    expect(await client.query(api.movies.history.continueWatching, {})).toEqual([]);

    const usage = await Promise.all(
      [
        api.movies.collections.list,
        api.movies.collections.get,
        api.movies.people.get,
        api.movies.people.search,
        api.movies.history.list,
        api.movies.history.continueWatching,
      ].map(async (callable) => documentsRead(stack, mark, callable)),
    );

    for (const read of usage.flat()) expect(read).toBeLessThan(DOCUMENTS_MAX);
  });
});

/** Every collection of `ours` that `who` lists, with how many titles each showed. */
const listCollections = async (
  who: Member,
  ours: ReadonlySet<string>,
  cursor: string | null = null,
  found: ReadonlyArray<{ readonly id: string; readonly titles: number }> = [],
): Promise<ReadonlyArray<{ readonly id: string; readonly titles: number }>> => {
  const page = await who.signedIn.client.query(api.movies.collections.list, {
    paginationOpts: { numItems: 20, cursor },
  });

  const next = [
    ...found,
    ...page.page.flatMap((entry) =>
      ours.has(entry.id) ? [{ id: entry.id, titles: entry.titles.length }] : [],
    ),
  ];

  return page.isDone ? next : listCollections(who, ours, page.continueCursor, next);
};

/** The title of every history entry of `who`, a page at a time. */
const historyOf = async (
  who: Member,
  cursor: string | null = null,
  found: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  const page = await who.signedIn.client.query(api.movies.history.list, {
    paginationOpts: { numItems: 200, cursor },
  });

  const next = [...found, ...page.page.map((entry) => entry.title.id)];

  return page.isDone ? next : historyOf(who, page.continueCursor, next);
};
