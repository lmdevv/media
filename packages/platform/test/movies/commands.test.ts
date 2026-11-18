import { join } from "node:path";

import type { ConvexHttpClient } from "convex/browser";
import { beforeAll, describe, expect, it } from "vitest";

import { openingSeason } from "@media/contracts/opening-season";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Member } from "../devices";
import { movie, seedLibrary, share, unshare } from "../probe";
import { failureOf, refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { finishJob } from "./catalog";
import { episodeFile, scannedTitle } from "./scanned";
import { NONE, scanInto, seasonOf, shelfOf, titleIn } from "./shelf";
import type { SeasonEpisode, Shelf } from "./shelf";

const stack = coreStackFromEnvFile();

type Sort = "name" | "added" | "year";

interface Listed {
  readonly id: Id<"titles">;
  readonly name: string;
}

/** The shelf's titles, by id: other suites' libraries may share names and the household. */
let shelfIds: ReadonlySet<string> = new Set();

const listedNames = async (
  who: Member,
  options: {
    readonly numItems?: number;
    readonly libraryId?: Id<"libraries">;
    readonly sort?: Sort;
    readonly genre?: string;
  } = {},
  cursor: string | null = null,
  titles: ReadonlyArray<Listed> = [],
  calls = 0,
): Promise<{
  readonly names: ReadonlyArray<string>;
  readonly titles: ReadonlyArray<Listed>;
  readonly calls: number;
}> => {
  const { numItems = 100, ...filter } = options;

  const page = await who.signedIn.client.query(api.movies.titles.list, {
    paginationOpts: { numItems, cursor },
    ...filter,
  });

  const next = [...titles, ...page.page.map(({ id, name }) => ({ id, name }))];

  return page.isDone
    ? { names: next.map((title) => title.name), titles: next, calls: calls + 1 }
    : listedNames(who, options, page.continueCursor, next, calls + 1);
};

const ALL = [
  "Big Buck Bunny",
  "Caminandes",
  "Pioneer One",
  "Sintel",
  "Tears of Steel",
  "Unrated Short",
];

/** The first page of the season a show's page opens on, with the season left to the server. */
const openedOn = async (
  client: ConvexHttpClient,
  titleId: Id<"titles">,
): Promise<ReadonlyArray<SeasonEpisode>> =>
  (
    await client.query(api.movies.titles.episodes, {
      titleId,
      paginationOpts: { numItems: 100, cursor: null },
    })
  ).page;

const sorted = (names: ReadonlyArray<string>): ReadonlyArray<string> => names.toSorted();

const shelfTitlesIn = (listed: { readonly titles: ReadonlyArray<Listed> }): ReadonlyArray<string> =>
  sorted(listed.titles.flatMap((title) => (shelfIds.has(title.id) ? [title.name] : [])));

describe.skipIf(stack === undefined)("movies browse commands", { timeout: 180_000 }, () => {
  let shelf: Shelf;

  beforeAll(async () => {
    if (stack === undefined) return;

    shelf = await shelfOf(stack, `browse-${Math.random().toString(36).slice(2, 8)}`);
    shelfIds = new Set(shelf.titles.values());
  }, 180_000);

  it("list each person's titles a library at a time, each once, through can()", async () => {
    expect(shelfTitlesIn(await listedNames(shelf.aiko, { genre: shelf.genre }))).toEqual(ALL);
    expect(shelfTitlesIn(await listedNames(shelf.sam, { genre: shelf.genre }))).toEqual([
      "Caminandes",
      "Pioneer One",
    ]);
    expect(shelfTitlesIn(await listedNames(shelf.outsider, { genre: shelf.genre }))).toEqual([]);
    expect(shelfTitlesIn(await listedNames(shelf.kid, { genre: shelf.genre }))).toEqual([
      "Big Buck Bunny",
      "Caminandes",
      "Pioneer One",
      "Unrated Short",
    ]);

    const paged = await listedNames(shelf.aiko, { numItems: 1, genre: shelf.genre });

    expect(shelfTitlesIn(paged)).toEqual(ALL);
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

  it("keep listing when a library is taken away mid-list", async () => {
    const client = shelf.mateo.signedIn.client;

    const first = await client.query(api.movies.titles.list, {
      paginationOpts: { numItems: 1, cursor: null },
      genre: shelf.genre,
    });

    const series = ["Caminandes", "Pioneer One"];
    const inSeries = series.includes(first.page[0]?.name ?? "");
    const taken = inSeries ? shelf.series : shelf.films;
    const principal = { kind: "user", userId: shelf.mateo.userId } as const;

    await unshare(shelf.owner, taken, principal);

    try {
      const rest = await listedNames(
        shelf.mateo,
        { numItems: 1, genre: shelf.genre },
        first.continueCursor,
      );

      expect(shelfTitlesIn(rest)).toEqual(
        inSeries ? ["Big Buck Bunny", "Sintel", "Tears of Steel", "Unrated Short"] : series,
      );
    } finally {
      await share(shelf.owner, taken, principal, inSeries ? "view" : "edit");
    }
  });

  it("hide unrated titles from a kid only when an admin turns that on", async () => {
    await shelf.owner.signedIn.client.mutation(api.core.restrictions.set, {
      userId: shelf.kid.userId,
      restrictions: { ...NONE, maxMovieAge: 7, hideUnrated: true },
    });

    try {
      expect(shelfTitlesIn(await listedNames(shelf.kid, { genre: shelf.genre }))).toEqual([
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
      refusal(client.query(api.movies.collections.ofTitle, { titleId: sintel })),
      refusal(
        client.query(api.movies.titles.episodes, {
          titleId: sintel,
          seasonNumber: 1,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
      refusal(
        client.query(api.movies.titles.episodes, {
          titleId: sintel,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
      refusal(client.mutation(api.movies.play.start, { titleId: sintel })),
      refusal(client.mutation(api.movies.myList.add, { titleId: sintel })),
      refusal(client.mutation(api.movies.history.markWatched, { titleId: sintel })),
      refusal(
        client.mutation(api.movies.metadata.edit, { titleId: sintel, set: { name: "Mine" } }),
      ),
      refusal(shelf.kid.signedIn.client.query(api.movies.titles.get, { titleId: sintel })),
      refusal(shelf.outsider.signedIn.client.query(api.movies.titles.get, { titleId: pioneer })),
      refusal(
        shelf.outsider.signedIn.client.query(api.movies.titles.versions, { titleId: pioneer }),
      ),
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

    const episodes = await seasonOf(client, pioneerId, 1);

    expect(episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3]);
    expect(await openedOn(client, pioneerId)).toEqual(episodes);
    expect(await openedOn(client, titleIn(shelf, "Sintel"))).toEqual([]);

    const [first, second] = episodes;

    if (first === undefined || second === undefined) throw new Error("no episodes");

    expect((await client.query(api.movies.titles.nextEpisode, { episodeId: first.id }))?.id).toBe(
      second.id,
    );

    const named = await client.query(api.movies.titles.episode, { episodeId: second.id });

    expect({ id: named.id, titleId: named.titleId, number: named.episodeNumber }).toEqual({
      id: second.id,
      titleId: pioneerId,
      number: 2,
    });
    expect(
      await refusal(
        shelf.outsider.signedIn.client.query(api.movies.titles.episode, { episodeId: second.id }),
      ),
    ).toBe("not_found");
    expect(
      await client.query(api.movies.titles.versions, { titleId: pioneerId, episodeId: first.id }),
    ).toHaveLength(1);
    expect(await client.query(api.movies.titles.versions, { titleId: pioneerId })).toEqual(
      await client.query(api.movies.titles.versions, {
        titleId: pioneerId,
        episodeId: pioneer.nextEpisode?.id ?? first.id,
      }),
    );
  });

  it("open a show's episodes on its next episode's season, else its first regular one", async () => {
    if (stack === undefined) return;

    const label = `specials-${Math.random().toString(36).slice(2, 8)}`;

    const numbers = [
      [0, 1],
      [1, 1],
      [1, 2],
      [2, 1],
    ] as const;

    const scanned = await scanInto(stack, shelf.owner, `${label} Series`, (root) =>
      numbers.map(([season, episode]) =>
        episodeFile(
          join(root, "Specials Show", `${season}-${episode}.mkv`),
          scannedTitle("show", `nfo:${label}`, "Specials Show", 0),
          season,
          episode,
        ),
      ),
    );

    await finishJob(stack, scanned.lease);
    await share(
      shelf.owner,
      scanned.libraryId,
      { kind: "user", userId: shelf.aiko.userId },
      "view",
    );

    const titleId = scanned.files[0]?.titleId;

    if (titleId === undefined) throw new Error("the scan landed no files");

    const client = shelf.aiko.signedIn.client;

    const opened = async () =>
      (await openedOn(client, titleId)).map((episode) => [
        episode.seasonNumber,
        episode.episodeNumber,
      ]);

    /** The season the clients head the list with, from what `movies.titles.get` answers. */
    const clientsOpenOn = async () => {
      const show = await client.query(api.movies.titles.get, { titleId });

      return openingSeason({
        nextSeason: show.nextEpisode?.seasonNumber ?? null,
        seasons: show.seasons.map((season) => season.seasonNumber),
      });
    };

    expect(await opened()).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(await clientsOpenOn()).toBe(1);

    const lastOfFirst = (await seasonOf(client, titleId, 1))[1];

    if (lastOfFirst === undefined) throw new Error("no second episode of season 1");

    await client.mutation(api.movies.history.markWatched, { titleId, episodeId: lastOfFirst.id });

    expect(await opened()).toEqual([[2, 1]]);

    const nextOne = (await seasonOf(client, titleId, 2))[0];

    expect(
      (await client.query(api.movies.titles.versions, { titleId })).map((version) => version.id),
    ).toEqual(
      scanned.files.flatMap((file) => (file.episodeId === nextOne?.id ? [file.fileId] : [])),
    );
    expect(await clientsOpenOn()).toBe(2);

    await client.mutation(api.movies.history.markWatched, { titleId });

    expect((await client.query(api.movies.titles.get, { titleId })).nextEpisode).toBeNull();
    expect(await client.query(api.movies.titles.versions, { titleId })).toEqual([]);
    expect(await opened()).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(await clientsOpenOn()).toBe(1);
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

    const kid = shelf.kid.signedIn.client;

    expect(
      await aiko.query(api.movies.collections.ofTitle, { titleId: titleIn(shelf, "Sintel") }),
    ).toEqual(await aiko.query(api.movies.collections.get, { collectionId }));
    expect(
      await kid.query(api.movies.collections.ofTitle, {
        titleId: titleIn(shelf, "Big Buck Bunny"),
      }),
    ).toEqual(await kid.query(api.movies.collections.get, { collectionId }));
    expect(
      await refusal(
        kid.query(api.movies.collections.ofTitle, { titleId: titleIn(shelf, "Sintel") }),
      ),
    ).toBe("not_found");
    expect(
      await aiko.query(api.movies.collections.ofTitle, { titleId: titleIn(shelf, "Pioneer One") }),
    ).toBeNull();

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
