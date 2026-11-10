import { randomUUID } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { logMark, runFunction, usageSince } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { movie, seedLibrary } from "../probe";
import { importRows, importRowsAt, newestRows } from "../rows";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

/** What one collections page may read: its 21 collections, their members, and the titles. */
const PAGE_DOCUMENTS_MAX = 300;

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack wrote these through a `v.id(...)` validator, which checks each again when sent back.
const isId =
  <Table extends "titles" | "collections" | "people">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const Stored = <Table extends "titles" | "collections">(table: Table) =>
  Schema.fromJsonString(
    Schema.Struct({ _id: Schema.declare(isId(table)), name: Schema.String, tie: Schema.String }),
  );

const byTie = (left: { readonly tie: string }, right: { readonly tie: string }): number =>
  left.tie < right.tie ? -1 : left.tie > right.tie ? 1 : 0;

/** The newest rows of `table` named `name`, as an import stored them, in tie order. */
const storedNamed = <Table extends "titles" | "collections">(
  table: Table,
  name: string,
  limit = 500,
): ReadonlyArray<{ readonly _id: Id<Table>; readonly tie: string }> =>
  newestRows(table, limit)
    .map((line) => Schema.decodeSync(Stored(table))(line))
    .filter((row) => row.name === name)
    .toSorted(byTie);

/** A creation time several rows share, as a restore can write. */
const sharedTime = (): number => Math.floor(Date.now()) + 0.5;

/** One movie library `who` manages, holding one seeded title, and that title. */
const libraryOf = async (core: CoreStack, who: Member, label: string) => {
  const seeded = await seedLibrary(core, who, {
    name: `ties ${label}`,
    kind: "movies",
    items: [movie(`Tied ${label}`, 0)],
  });

  const [titleId] = seeded.itemIds;

  if (titleId === undefined) throw new Error("no title seeded");

  return { libraryId: seeded.libraryId, titleId };
};

/**
 * Imports collections named `name`, one per tie, all of creation time `time`, each holding
 * `titleId`, and answers the ids of every collection of that name, in tie order.
 */
const tiedCollections = (
  name: string,
  ties: ReadonlyArray<string>,
  titleId: Id<"titles">,
  time: number,
): ReadonlyArray<{ readonly _id: Id<"collections">; readonly tie: string }> => {
  importRowsAt(
    "collections",
    ties.map((tie) => ({
      name,
      sortKey: name,
      sourceKey: null,
      createdAt: 1,
      updatedAt: 1,
      overview: null,
      poster: null,
      backdrop: null,
      tie,
      _creationTime: time,
    })),
  );

  const stored = storedNamed("collections", name, ties.length + 500);
  const fresh = stored.filter((row) => ties.includes(row.tie));

  importRows(
    "collectionItems",
    fresh.map((row) => ({
      collectionId: row._id,
      titleId,
      position: 0,
      source: "import" as const,
    })),
  );

  return stored;
};

const idsOf = (rows: ReadonlyArray<{ readonly _id: Id<"collections"> }>) =>
  rows.map((row) => row._id);

/** Deletes collections a test seeded, 500 a call, so no later suite pages through them. */
const forget = async (core: CoreStack, collectionIds: ReadonlyArray<Id<"collections">>) => {
  await inOrder(
    Array.from({ length: Math.ceil(collectionIds.length / 500) }, (_, n) =>
      collectionIds.slice(n * 500, (n + 1) * 500),
    ),
    async (batch) =>
      runFunction(
        core,
        internal.movies.rowsProbe.deleteCollections,
        { collectionIds: [...batch] },
        Schema.Null,
      ),
  );
};

interface Listing {
  readonly ids: ReadonlyArray<string>;
  readonly pages: number;
  /** The cursor after the last page read. */
  readonly cursor: string | null;
}

/**
 * The collections of `ours` that `who` lists, `numItems` a page, from `cursor` until the end, or
 * until `enough` of them are listed.
 */
const listedOf = async (
  who: Member,
  ours: ReadonlySet<string>,
  numItems: number,
  cursor: string | null = null,
  enough = Number.POSITIVE_INFINITY,
  found: Listing = { ids: [], pages: 0, cursor: null },
): Promise<Listing> => {
  if (found.pages > 3000) throw new Error("the collections list never ended");

  const page = await who.signedIn.client.query(api.movies.collections.list, {
    paginationOpts: { numItems, cursor },
  });

  const next = {
    ids: [...found.ids, ...page.page.flatMap((entry) => (ours.has(entry.id) ? [entry.id] : []))],
    pages: found.pages + 1,
    cursor: page.continueCursor,
  };

  return page.isDone || next.ids.length >= enough
    ? next
    : listedOf(who, ours, numItems, page.continueCursor, enough, next);
};

const importedTitle = (
  libraryId: Id<"libraries">,
  name: string,
  addedAt: number,
  genres: ReadonlyArray<string>,
) => ({
  libraryId,
  kind: "movie" as const,
  matchKey: `seed:${name}`,
  name,
  sortName: name,
  sortKey: name.toLowerCase(),
  year: null,
  overview: null,
  tagline: null,
  genres: [...genres],
  certification: null,
  ageRating: 0,
  runtimeMs: null,
  artwork: { poster: null, backdrop: null, logo: null },
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  matchStatus: "unmatched" as const,
  presentFileCount: 1,
  episodeCount: 0,
  matchGeneration: 0,
  addedAt,
  updatedAt: addedAt,
  searchText: name,
});

describe.skipIf(stack === undefined)("movies rows tied on time", { timeout: 600_000 }, () => {
  it("list every collection of one name and creation time, a page of any size at a time", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-collections");
    const { titleId } = await libraryOf(stack, viewer, label);

    const tied = idsOf(
      tiedCollections(
        `aaa tied ${label}`,
        Array.from({ length: 8 }, () => randomUUID()),
        titleId,
        sharedTime(),
      ),
    );

    expect(tied).toHaveLength(8);

    const listings = await inOrder([1, 2, 3, 20], async (numItems) =>
      listedOf(viewer, new Set(tied), numItems, null, tied.length),
    );

    for (const { ids } of listings) expect(ids.toSorted()).toEqual([...tied].toSorted());

    await forget(stack, tied);
  });

  it("list every tied collection left after one already listed is deleted between pages", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-deleted");
    const { titleId } = await libraryOf(stack, viewer, label);
    const ties = ["a", "b", "c", "d"].map((tie) => `${label}-${tie}`);

    const tied = idsOf(tiedCollections(`!!! deleted ${label}`, ties, titleId, sharedTime()));
    const [a, ...after] = tied;

    if (a === undefined) throw new Error("no collection imported");

    // Other suites' collections may come first, unseen by this viewer: page to the first of ours.
    const first = await listedOf(viewer, new Set(tied), 1, null, 1);

    expect(first.ids).toEqual([a]);

    await forget(stack, [a]);

    const rest = await listedOf(viewer, new Set(tied), 1, first.cursor, after.length);

    expect(rest.ids).toEqual(after);

    await forget(stack, after);
  });

  it("neither repeat nor skip a collection when tied ones are added before the cursor", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-inserted");
    const { titleId } = await libraryOf(stack, viewer, label);
    const name = `!!! inserted ${label}`;
    const time = sharedTime();
    const tieOf = (tie: string) => `${label}-${tie}`;

    const ours = idsOf(tiedCollections(name, ["m1", "m3", "m5", "m7"].map(tieOf), titleId, time));
    const first = await listedOf(viewer, new Set(ours), 1, null, 1);
    const all = tiedCollections(name, ["m0", "m2", "m4"].map(tieOf), titleId, time);
    const byName = new Map(all.map((row) => [row.tie, row._id]));
    const ids = (ties: ReadonlyArray<string>) => ties.map((tie) => byName.get(tieOf(tie)));

    expect(first.ids).toEqual(ids(["m1"]));

    const rest = await listedOf(viewer, new Set(idsOf(all)), 1, first.cursor, 5);

    // m0 came before the cursor and m1 was listed already: neither comes again, none is missed.
    expect(rest.ids).toEqual(ids(["m2", "m3", "m4", "m5", "m7"]));

    await forget(stack, idsOf(all));
  });

  it("read only forward through a thousand collections of one name and time", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-many");
    const { titleId } = await libraryOf(stack, viewer, label);

    // They sort last, so other suites' lists never page through them.
    const tied = idsOf(
      tiedCollections(
        `~~~ many ${label}`,
        Array.from({ length: 1000 }, () => randomUUID()),
        titleId,
        sharedTime(),
      ),
    );

    expect(tied).toHaveLength(1000);

    const ours = new Set(tied);
    const first = await listedOf(viewer, ours, 20, null, 1);
    const mark = await logMark(stack);
    const rest = await listedOf(viewer, ours, 20, first.cursor, tied.length - first.ids.length);
    const listed = [...first.ids, ...rest.ids];

    expect(new Set(listed).size).toBe(1000);
    expect(listed).toHaveLength(1000);

    const usage = await usageSince(stack, mark, api.movies.collections.list, rest.pages, 120_000);
    const reads = usage.filter((call) => call.committed).map((call) => call.reads);

    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads)).toBeLessThan(PAGE_DOCUMENTS_MAX);

    await forget(stack, tied);
  });

  it("show every newest title of one added and creation time on home", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-titles");
    const { libraryId } = await libraryOf(stack, viewer, label);
    const name = `Tied newest ${label}`;
    const addedAt = Date.now() + 1_000_000;
    const time = sharedTime();

    importRowsAt(
      "titles",
      Array.from({ length: 5 }, () => ({
        ...importedTitle(libraryId, name, addedAt, []),
        tie: randomUUID(),
        _creationTime: time,
      })),
    );

    const tied = storedNamed("titles", name).map((row) => row._id);

    expect(tied).toHaveLength(5);

    const home = await viewer.signedIn.client.query(api.movies.titles.home, {});

    expect(
      home.recentlyAddedMovies
        .map((title) => title.id)
        .filter((id) => tied.some((tiedId) => tiedId === id))
        .toSorted(),
    ).toEqual([...tied].toSorted());
  });

  it("count genres over a thousand titles that share their added and creation times", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "tied-genres");
    const { libraryId } = await libraryOf(stack, viewer, label);
    const genre = `tied${label}`;
    const addedAt = Date.now() + 2_000_000;
    const time = sharedTime();

    importRowsAt(
      "titles",
      Array.from({ length: 1000 }, (_, n) => ({
        ...importedTitle(libraryId, `Tied genre ${label} ${n}`, addedAt, [genre]),
        tie: randomUUID(),
        _creationTime: time,
      })),
    );

    const genres = await viewer.signedIn.client.query(api.movies.titles.genres, {});

    expect(genres.find((entry) => entry.name === genre)?.count).toBe(1000);
  });

  it("find people whose one visible credit comes after a thousand of one creation time", async () => {
    if (stack === undefined) return;

    const label = unique();
    const owner = await member(stack, "tied-credits-owner");
    const viewer = await member(stack, "tied-credits-viewer");
    const hidden = await libraryOf(stack, owner, `${label} hidden`);
    const shown = await libraryOf(stack, viewer, `${label} shown`);
    const name = `Tied Credited ${label}`;

    const people = await inOrder(
      Array.from({ length: 4 }, (_, n) => n),
      async (n) =>
        runFunction(
          stack,
          internal.movies.probe.seedCredits,
          { name: `${name} ${n}`, titleIds: [] },
          Schema.declare(isId("people")),
        ),
    );

    const time = sharedTime();

    // Each person's one visible credit comes last in tie order, after 1,000 hidden ones.
    importRowsAt(
      "credits",
      people.flatMap((personId) =>
        Array.from({ length: 1001 }, (_, order) => ({
          titleId: order === 1000 ? shown.titleId : hidden.titleId,
          episodeId: null,
          personId,
          kind: "actor" as const,
          role: null,
          order,
          tie: `${label}-${String(order).padStart(4, "0")}`,
          _creationTime: time,
        })),
      ),
    );

    const found = await viewer.signedIn.client.query(api.movies.people.search, {
      query: name,
      limit: 50,
    });

    expect(found.map((person) => person.id).toSorted()).toEqual([...people].toSorted());
  });
});
