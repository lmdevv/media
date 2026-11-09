import { beforeAll, describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Member } from "../devices";
import { movie, seedLibrary } from "../probe";
import { failureOf, refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { NONE, shelfOf, titleIn } from "./shelf";
import type { Shelf } from "./shelf";

const stack = coreStackFromEnvFile();

type Sort = "name" | "added" | "year";

/** Every title name `who` lists across their libraries, a page of `numItems` at a time. */
const listedNames = async (
  who: Member,
  options: {
    readonly numItems?: number;
    readonly libraryId?: Id<"libraries">;
    readonly sort?: Sort;
    readonly genre?: string;
  } = {},
  cursor: string | null = null,
  names: ReadonlyArray<string> = [],
  calls = 0,
): Promise<{ readonly names: ReadonlyArray<string>; readonly calls: number }> => {
  const { numItems = 100, ...filter } = options;

  const page = await who.signedIn.client.query(api.movies.titles.list, {
    paginationOpts: { numItems, cursor },
    ...filter,
  });

  const next = [...names, ...page.page.map((title) => title.name)];

  return page.isDone
    ? { names: next, calls: calls + 1 }
    : listedNames(who, options, page.continueCursor, next, calls + 1);
};

const sorted = (names: ReadonlyArray<string>): ReadonlyArray<string> => names.toSorted();

const ALL = [
  "Big Buck Bunny",
  "Caminandes",
  "Pioneer One",
  "Sintel",
  "Tears of Steel",
  "Unrated Short",
];

describe.skipIf(stack === undefined)("movies browse commands", { timeout: 180_000 }, () => {
  let shelf: Shelf;

  beforeAll(async () => {
    if (stack === undefined) return;

    shelf = await shelfOf(stack, `browse-${Math.random().toString(36).slice(2, 8)}`);
  }, 180_000);

  it("list each person's titles a library at a time, each once, through can()", async () => {
    expect(sorted((await listedNames(shelf.aiko)).names)).toEqual(ALL);
    expect(sorted((await listedNames(shelf.sam)).names)).toEqual(["Caminandes", "Pioneer One"]);
    expect((await listedNames(shelf.outsider)).names).toEqual([]);
    expect(sorted((await listedNames(shelf.kid)).names)).toEqual([
      "Big Buck Bunny",
      "Caminandes",
      "Pioneer One",
      "Unrated Short",
    ]);

    const paged = await listedNames(shelf.aiko, { numItems: 1 });

    expect(sorted(paged.names)).toEqual(ALL);
    expect(paged.calls).toBeGreaterThanOrEqual(ALL.length);

    expect((await listedNames(shelf.aiko, { libraryId: shelf.films, sort: "name" })).names).toEqual(
      ["Big Buck Bunny", "Sintel", "Tears of Steel", "Unrated Short"],
    );
    expect((await listedNames(shelf.aiko, { libraryId: shelf.films, sort: "year" })).names).toEqual(
      ["Unrated Short", "Tears of Steel", "Sintel", "Big Buck Bunny"],
    );
    expect(
      (await listedNames(shelf.aiko, { libraryId: shelf.films, genre: "ANIMATION" })).names,
    ).toEqual(["Big Buck Bunny", "Sintel"]);
    expect(
      await refusal(
        shelf.sam.signedIn.client.query(api.movies.titles.list, {
          paginationOpts: { numItems: 10, cursor: null },
          libraryId: shelf.films,
        }),
      ),
    ).toBe("not_found");
  });

  it("hide unrated titles from a kid only when an admin turns that on", async () => {
    await shelf.owner.signedIn.client.mutation(api.core.restrictions.set, {
      userId: shelf.kid.userId,
      restrictions: { ...NONE, maxMovieAge: 7, hideUnrated: true },
    });

    try {
      expect(sorted((await listedNames(shelf.kid)).names)).toEqual([
        "Big Buck Bunny",
        "Caminandes",
        "Pioneer One",
      ]);
      expect(
        (await shelf.kid.signedIn.client.query(api.movies.titles.search, { query: "Unrated" })).map(
          (title) => title.name,
        ),
      ).toEqual([]);
    } finally {
      await shelf.owner.signedIn.client.mutation(api.core.restrictions.set, {
        userId: shelf.kid.userId,
        restrictions: { ...NONE, maxMovieAge: 7 },
      });
    }
  });

  it("page one library of 250 titles by index, each title once", async () => {
    if (stack === undefined) return;

    const names = Array.from({ length: 250 }, (_, n) => `Paged ${String(n).padStart(3, "0")}`);

    const seeded = await seedLibrary(stack, shelf.aiko, {
      name: "Paged",
      kind: "movies",
      items: names.map((name) => movie(name, 0)),
    });

    const paged = await listedNames(shelf.aiko, { libraryId: seeded.libraryId, numItems: 100 });

    expect(paged.names).toEqual(names);
    expect(paged.calls).toBe(3);
  });

  it("refuse a title outside a person's grants as if it did not exist", async () => {
    const sintel = titleIn(shelf, "Sintel");
    const pioneer = titleIn(shelf, "Pioneer One");
    const client = shelf.sam.signedIn.client;

    const refusals = await Promise.all([
      refusal(client.query(api.movies.titles.get, { titleId: sintel })),
      refusal(client.query(api.movies.titles.versions, { titleId: sintel })),
      refusal(client.query(api.movies.titles.similar, { titleId: sintel })),
      refusal(client.query(api.movies.titles.episodes, { titleId: sintel, seasonNumber: 1 })),
      refusal(client.mutation(api.movies.play.start, { titleId: sintel })),
      refusal(client.mutation(api.movies.myList.add, { titleId: sintel })),
      refusal(client.mutation(api.movies.history.markWatched, { titleId: sintel })),
      refusal(
        client.mutation(api.movies.metadata.edit, { titleId: sintel, set: { name: "Mine" } }),
      ),
      refusal(shelf.kid.signedIn.client.query(api.movies.titles.get, { titleId: sintel })),
      refusal(shelf.outsider.signedIn.client.query(api.movies.titles.get, { titleId: pioneer })),
    ]);

    expect(refusals).toEqual(Array.from({ length: refusals.length }, () => "not_found"));
    expect((await client.query(api.movies.titles.get, { titleId: pioneer })).name).toBe(
      "Pioneer One",
    );
  });

  it("show a title with its seasons, episodes, versions, and cast", async () => {
    const client = shelf.aiko.signedIn.client;
    const sintel = await client.query(api.movies.titles.get, { titleId: titleIn(shelf, "Sintel") });

    expect(sintel).toMatchObject({
      name: "Sintel",
      kind: "movie",
      ageRating: 13,
      available: true,
      inMyList: false,
      progress: null,
      nextEpisode: null,
      collection: { name: shelf.collectionName },
    });
    expect(sintel.cast.map((credit) => credit.personId)).toEqual([shelf.castId]);
    expect(sintel.files).toHaveLength(1);
    expect(sintel.versions).toHaveLength(1);

    const pioneerId = titleIn(shelf, "Pioneer One");
    const pioneer = await client.query(api.movies.titles.get, { titleId: pioneerId });

    expect(pioneer.seasons.map((season) => season.seasonNumber)).toEqual([1]);
    expect(pioneer.nextEpisode?.episodeNumber).toBe(1);

    const episodes = await client.query(api.movies.titles.episodes, {
      titleId: pioneerId,
      seasonNumber: 1,
    });

    expect(episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3]);

    const [first, second] = episodes;

    if (first === undefined || second === undefined) throw new Error("no episodes");

    expect((await client.query(api.movies.titles.nextEpisode, { episodeId: first.id }))?.id).toBe(
      second.id,
    );
    expect(
      await client.query(api.movies.titles.versions, { titleId: pioneerId, episodeId: first.id }),
    ).toHaveLength(1);
    expect(
      (await failureOf(client.query(api.movies.titles.versions, { titleId: pioneerId }))).code,
    ).toBe("invalid_args");
  });

  it("search titles, count genres, and show home rows of what each person sees", async () => {
    const aiko = shelf.aiko.signedIn.client;
    const kid = shelf.kid.signedIn.client;

    expect(
      (await aiko.query(api.movies.titles.search, { query: "Sintel" })).map((title) => title.id),
    ).toContain(titleIn(shelf, "Sintel"));
    expect(
      (await kid.query(api.movies.titles.search, { query: "Sintel" })).map((title) => title.id),
    ).not.toContain(titleIn(shelf, "Sintel"));

    const genres = await kid.query(api.movies.titles.genres, { kind: "movie" });

    expect(genres.find((genre) => genre.name === "Animation")?.count).toBeGreaterThanOrEqual(1);
    expect(genres.map((genre) => genre.name)).not.toContain("Fantasy");

    const home = await kid.query(api.movies.titles.home, {});

    const shown = [...home.recentlyAddedMovies, ...home.recentlyAddedShows].map(
      (title) => title.name,
    );

    expect(shown).toEqual(expect.arrayContaining(["Big Buck Bunny", "Pioneer One", "Caminandes"]));
    expect(shown).not.toContain("Sintel");
    expect(shown).not.toContain("Tears of Steel");
  });

  it("show a person and collections only through titles each person sees", async () => {
    const aiko = shelf.aiko.signedIn.client;
    const person = await aiko.query(api.movies.people.get, { personId: shelf.castId });

    expect(person.credits.map((credit) => credit.title.name)).toEqual(["Sintel"]);
    expect(person.detailsPending).toBe(true);
    expect(
      await refusal(
        shelf.sam.signedIn.client.query(api.movies.people.get, { personId: shelf.castId }),
      ),
    ).toBe("not_found");
    expect(
      (await aiko.query(api.movies.people.search, { query: person.name })).map((found) => found.id),
    ).toEqual([shelf.castId]);
    expect(
      await shelf.sam.signedIn.client.query(api.movies.people.search, { query: person.name }),
    ).toEqual([]);
    expect(
      await aiko.mutation(api.movies.people.requestDetails, { personId: shelf.castId }),
    ).toBeNull();
    expect(
      await refusal(
        shelf.sam.signedIn.client.mutation(api.movies.people.requestDetails, {
          personId: shelf.castId,
        }),
      ),
    ).toBe("not_found");

    const collectionId = (
      await aiko.query(api.movies.titles.get, { titleId: titleIn(shelf, "Sintel") })
    ).collection?.id;

    if (collectionId === undefined) throw new Error("Sintel has no collection");

    expect(
      (await aiko.query(api.movies.collections.get, { collectionId })).titles.map((t) => t.name),
    ).toEqual(["Big Buck Bunny", "Sintel"]);
    expect(
      (
        await shelf.kid.signedIn.client.query(api.movies.collections.get, { collectionId })
      ).titles.map((t) => t.name),
    ).toEqual(["Big Buck Bunny"]);
    expect(
      await refusal(shelf.sam.signedIn.client.query(api.movies.collections.get, { collectionId })),
    ).toBe("not_found");

    const firstPage = await aiko.query(api.movies.collections.list, {
      paginationOpts: { numItems: 20, cursor: null },
    });

    expect(firstPage.page.every((entry) => entry.titles.length > 0)).toBe(true);
  });

  it("edit and match metadata only with an edit grant on the title's library", async () => {
    const sintel = titleIn(shelf, "Sintel");

    expect(
      await refusal(
        shelf.aiko.signedIn.client.mutation(api.movies.metadata.edit, {
          titleId: sintel,
          set: { name: "Aiko's Sintel" },
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        shelf.aiko.signedIn.client.mutation(api.movies.metadata.refresh, { titleId: sintel }),
      ),
    ).toBe("forbidden");

    const mateo = shelf.mateo.signedIn.client;

    await mateo.mutation(api.movies.metadata.edit, {
      titleId: sintel,
      set: { name: "Sintel (Director's Cut)", ageRating: 7 },
    });

    expect(
      await shelf.aiko.signedIn.client.query(api.movies.titles.get, { titleId: sintel }),
    ).toMatchObject({
      name: "Sintel (Director's Cut)",
      ageRating: 7,
    });
    expect(
      (await shelf.kid.signedIn.client.query(api.movies.titles.get, { titleId: sintel })).name,
    ).toBe("Sintel (Director's Cut)");

    await mateo.mutation(api.movies.metadata.edit, {
      titleId: sintel,
      set: {},
      clear: ["name", "ageRating"],
    });

    expect(
      await refusal(shelf.kid.signedIn.client.query(api.movies.titles.get, { titleId: sintel })),
    ).toBe("not_found");
    expect(
      (
        await failureOf(
          mateo.mutation(api.movies.metadata.edit, { titleId: sintel, set: { year: 2010.5 } }),
        )
      ).code,
    ).toBe("invalid_args");

    const matched = await mateo.mutation(api.movies.metadata.match, {
      titleId: sintel,
      provider: "tmdb",
      providerId: "45745",
    });

    const refreshed = await mateo.mutation(api.movies.metadata.refresh, { titleId: sintel });

    expect(matched.jobId).not.toBe(refreshed.jobId);
    expect(
      (
        await failureOf(
          mateo.mutation(api.movies.metadata.match, {
            titleId: sintel,
            provider: "tmdb",
            providerId: " ",
          }),
        )
      ).code,
    ).toBe("invalid_args");
  });
});
