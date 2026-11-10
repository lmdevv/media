import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { runFunction } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { movie, seedLibrary } from "../probe";
import { importRows, importRowsAt, newestRows } from "../rows";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack wrote these through a `v.id(...)` validator, which checks each again when sent back.
const isId =
  <Table extends "titles" | "collections" | "people">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const Stored = <Table extends "titles" | "collections">(table: Table) =>
  Schema.fromJsonString(Schema.Struct({ _id: Schema.declare(isId(table)), name: Schema.String }));

/** The ids of the newest rows of `table` named `name`, as an import stored them. */
const storedNamed = <Table extends "titles" | "collections">(
  table: Table,
  name: string,
): ReadonlyArray<Id<Table>> =>
  newestRows(table, 500)
    .map((line) => Schema.decodeSync(Stored(table))(line))
    .filter((row) => row.name === name)
    .map((row) => row._id);

/** A creation time several rows share, as a restore can write; the rows then order by id. */
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

/** Every collection `who` lists of `ours`, `numItems` a page, following each page's cursor. */
const listedOf = async (
  who: Member,
  ours: ReadonlySet<string>,
  numItems: number,
  cursor: string | null = null,
  found: ReadonlyArray<string> = [],
  pages = 0,
): Promise<ReadonlyArray<string>> => {
  if (pages > 200) throw new Error("the collections list never ended");

  const page = await who.signedIn.client.query(api.movies.collections.list, {
    paginationOpts: { numItems, cursor },
  });

  const next = [...found, ...page.page.flatMap((entry) => (ours.has(entry.id) ? [entry.id] : []))];

  return page.isDone ? next : listedOf(who, ours, numItems, page.continueCursor, next, pages + 1);
};

describe.skipIf(stack === undefined)(
  "movies rows only their ids order",
  { timeout: 300_000 },
  () => {
    it("list every collection of one name and creation time, a page of any size at a time", async () => {
      if (stack === undefined) return;

      const label = unique();
      const viewer = await member(stack, "tied-collections");
      const { titleId } = await libraryOf(stack, viewer, label);
      const name = `aaa tied ${label}`;
      const time = sharedTime();

      importRowsAt(
        "collections",
        Array.from({ length: 8 }, () => ({
          name,
          sortKey: name,
          sourceKey: null,
          createdAt: 1,
          updatedAt: 1,
          overview: null,
          poster: null,
          backdrop: null,
          _creationTime: time,
        })),
      );

      const tied = storedNamed("collections", name);

      expect(tied).toHaveLength(8);

      importRows(
        "collectionItems",
        tied.map((collectionId) => ({
          collectionId,
          titleId,
          position: 0,
          source: "import" as const,
        })),
      );

      const listings = await inOrder([1, 2, 3, 20], async (numItems) =>
        listedOf(viewer, new Set(tied), numItems),
      );

      for (const listed of listings) expect(listed.toSorted()).toEqual([...tied].toSorted());
    });

    it("show every newest title of one added and creation time on home", async () => {
      if (stack === undefined) return;

      const label = unique();
      const viewer = await member(stack, "tied-titles");
      const { libraryId } = await libraryOf(stack, viewer, label);
      const name = `Tied newest ${label}`;
      const time = sharedTime();
      const addedAt = Date.now() + 1_000_000;

      importRowsAt(
        "titles",
        Array.from({ length: 5 }, () => ({
          libraryId,
          kind: "movie" as const,
          matchKey: `seed:${name}`,
          name,
          sortName: name,
          sortKey: name.toLowerCase(),
          year: null,
          overview: null,
          tagline: null,
          genres: [],
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
          _creationTime: time,
        })),
      );

      const tied = storedNamed("titles", name);

      expect(tied).toHaveLength(5);

      const home = await viewer.signedIn.client.query(api.movies.titles.home, {});

      expect(
        home.recentlyAddedMovies
          .map((title) => title.id)
          .filter((id) => tied.some((tiedId) => tiedId === id))
          .toSorted(),
      ).toEqual([...tied].toSorted());
    });

    it("find people whose one visible credit is among many of one creation time", async () => {
      if (stack === undefined) return;

      const label = unique();
      const owner = await member(stack, "tied-credits-owner");
      const viewer = await member(stack, "tied-credits-viewer");
      const hidden = await libraryOf(stack, owner, `${label} hidden`);
      const shown = await libraryOf(stack, viewer, `${label} shown`);
      const name = `Tied Credited ${label}`;

      const people = await inOrder(
        Array.from({ length: 8 }, (_, n) => n),
        async (n) =>
          runFunction(
            stack,
            internal.movies.probe.seedCredits,
            { name: `${name} ${n}`, titleIds: [] },
            Schema.declare(isId("people")),
          ),
      );

      const time = sharedTime();

      // Each person's visible credit sits among 40 that only their ids order, so whichever ids
      // the import gave, a search that skipped past ties would miss most of them.
      importRowsAt(
        "credits",
        people.flatMap((personId) =>
          Array.from({ length: 40 }, (_, order) => ({
            titleId: order === 39 ? shown.titleId : hidden.titleId,
            episodeId: null,
            personId,
            kind: "actor" as const,
            role: null,
            order,
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
  },
);
