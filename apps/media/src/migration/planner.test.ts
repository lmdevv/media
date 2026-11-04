import { EpisodeId, LibraryId, MediaFileId, ProfileId, TitleId } from "@media/contracts/ids";
import type { CatalogFile, LocalProgress } from "@media/contracts/models/migration-service";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import { assert, describe, it } from "@effect/vitest";

import { planMigration } from "./planner.ts";
import type { PlanInput, ResolvedUser } from "./planner.ts";
import type { SourceItem, SourceItemState } from "./source-plugin.ts";

const noIds = { tmdb: null, imdb: null, tvdb: null };

const ALICE = ProfileId.make("alice");

const file = (titleId: string, path: string, episode: number | null = null): CatalogFile => ({
  fileId: MediaFileId.make(`file-${path}`),
  libraryId: LibraryId.make("movies"),
  path,
  missing: false,
  titleId: TitleId.make(titleId),
  kind: episode === null ? "movie" : "show",
  externalIds: noIds,
  episodeId: episode === null ? null : EpisodeId.make(`${titleId}-${String(episode)}`),
  seasonNumber: episode === null ? null : 1,
  episodeNumber: episode,
});

const item = (
  itemId: string,
  kind: SourceItem["kind"],
  paths: ReadonlyArray<string>,
  extra: Partial<SourceItem> = {},
): SourceItem => ({
  itemId,
  kind,
  name: itemId,
  libraryId: "lib",
  paths,
  ids: noIds,
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  overrides: {},
  ...extra,
});

const state = (itemId: string, extra: Partial<SourceItemState>): SourceItemState => ({
  itemId,
  played: false,
  positionMs: 0,
  playCount: 0,
  lastPlayedAt: null,
  favorite: false,
  ...extra,
});

const users: ReadonlyArray<ResolvedUser> = [
  { sourceUserId: "u1", name: "Alice", profileId: ALICE, action: "import", history: "full" },
  { sourceUserId: "u2", name: "Bob", profileId: null, action: "invite", history: "full" },
];

const input = (overrides: Partial<PlanInput>): PlanInput => ({
  source: "jellyfin",
  server: { serverId: "server", name: "Home", version: "10.10.7" },
  libraries: [
    {
      libraryId: "lib",
      name: "Movies",
      kind: "movies",
      paths: ["/data/movies"],
      access: { kind: "everyone" },
    },
    {
      libraryId: "new",
      name: "Kids",
      kind: "movies",
      paths: ["/data/kids"],
      access: { kind: "users", userIds: ["u1", "u2"] },
    },
    {
      libraryId: "music",
      name: "Music",
      kind: "other",
      paths: ["/data/music"],
      access: { kind: "unknown" },
    },
    {
      libraryId: "lost",
      name: "Lost",
      kind: "shows",
      paths: ["/offline/shows"],
      access: { kind: "unknown" },
    },
  ],
  items: [
    item("heat", "movie", ["/data/movies/Heat.mkv"], { overrides: { sortName: "Heat 1995" } }),
    item("alien", "movie", ["/data/movies/Alien.mkv"]),
    item("show", "series", ["/data/movies/Show"]),
    item("e1", "episode", ["/data/movies/Show/e1.mkv"], { seriesId: "show" }),
    item("fresh", "movie", ["/data/kids/Fresh.mkv"]),
    item("ghost", "movie", ["/offline/shows/Ghost.mkv"]),
  ],
  collections: [
    { collectionId: "box", name: "Box", sortName: null, itemIds: ["heat", "alien", "heat"] },
    { collectionId: "empty", name: "Empty", sortName: null, itemIds: ["ghost"] },
  ],
  users,
  states: new Map([
    [
      "u1",
      [
        state("heat", { played: true, positionMs: 999, playCount: 2, lastPlayedAt: 3_000 }),
        state("alien", { positionMs: 60_000, lastPlayedAt: 1_000 }),
        state("show", { favorite: true }),
        state("e1", { favorite: true, played: true, lastPlayedAt: 2_000 }),
        state("ghost", { played: true }),
      ],
    ],
  ]),
  mappings: [{ from: "/data", to: "/mnt/nas" }],
  roots: ["/mnt/nas"],
  existingLibraries: [
    { id: LibraryId.make("movies"), name: "Movies", kind: "movies", roots: ["/mnt/nas/movies"] },
  ],
  catalog: [
    file("heat", "/mnt/nas/movies/Heat.mkv"),
    file("alien", "/mnt/nas/movies/Alien.mkv"),
    file("show", "/mnt/nas/movies/Show/e1.mkv", 1),
  ],
  localProgress: new Map(),
  ...overrides,
});

const local = (titleId: string, lastPlayedAt: number, positionMs: number): LocalProgress => ({
  titleId: TitleId.make(titleId),
  episodeId: null,
  watched: false,
  positionMs: Milliseconds.make(positionMs),
  lastPlayedAt: EpochMillis.make(lastPlayedAt),
});

const fresh = (extra: Partial<SourceItemState>) =>
  new Map([["u1", [state("fresh", { lastPlayedAt: 4_000, ...extra })]]]);

describe("planMigration", () => {
  it("summarises users, libraries, matches, and what will be imported", () => {
    const plan = planMigration(input({}));

    assert.deepStrictEqual(plan.summary, {
      usersMapped: 1,
      usersUnmapped: 1,
      librariesToAdd: 1,
      librariesExisting: 1,
      itemsByPath: 3,
      itemsByProviderId: 0,
      itemsAwaitingScan: 1,
      itemsUnmatched: 1,
      watched: 2,
      inProgress: 1,
      playCounts: 3,
      favorites: 1,
      collections: 1,
      overrides: 1,
      conflicts: 0,
    });
    assert.deepStrictEqual(
      plan.libraries.map((library) => [library.name, library.newRoots, library.unmappedFolders]),
      [
        ["Movies", [], []],
        ["Kids", ["/mnt/nas/kids"], []],
        ["Lost", [], ["/offline/shows"]],
      ],
    );
    assert.deepStrictEqual(plan.unmatchedSamples, [
      { name: "ghost", path: "/offline/shows/Ghost.mkv", reason: "path_unmapped" },
    ]);
  });

  it("carries provider IDs and keeps overrides when two source items match one title", () => {
    const plan = planMigration(
      input({
        items: [
          item("heat-4k", "movie", ["/data/movies/Heat.mkv"], {
            overrides: { sortName: "Heat 1995" },
            ids: { tmdb: null, imdb: "tt0113277", tvdb: null },
          }),
          item("heat-copy", "movie", ["/data/movies/Heat.mkv"], {
            ids: { tmdb: "949", imdb: null, tvdb: null },
          }),
          item("alien", "movie", ["/data/movies/Alien.mkv"]),
        ],
      }),
    );

    assert.deepStrictEqual(plan.overrides, [
      {
        titleId: TitleId.make("heat"),
        overrides: { sortName: "Heat 1995" },
        externalIds: { tmdb: "949", imdb: "tt0113277", tvdb: null },
      },
    ]);
  });

  it("shares added libraries as the source did, with imported users only", () => {
    const plan = planMigration(input({}));

    assert.deepStrictEqual(
      plan.libraries.map((library) => [library.name, library.access]),
      [
        ["Movies", { kind: "everyone" }],
        ["Kids", { kind: "users", sourceUserIds: ["u1"] }],
        ["Lost", { kind: "users", sourceUserIds: [] }],
      ],
    );
  });

  it("reuses a library inside a source folder instead of adding one around it", () => {
    const inner = {
      id: LibraryId.make("inner"),
      name: "Inner",
      kind: "movies" as const,
      roots: ["/mnt/nas/kids/inner"],
    };

    const plan = planMigration(
      input({ existingLibraries: [...input({}).existingLibraries, inner] }),
    );

    assert.deepStrictEqual(
      plan.libraries.map((library) => [library.name, library.existingLibraryId, library.newRoots]),
      [
        ["Movies", LibraryId.make("movies"), []],
        ["Kids", LibraryId.make("inner"), []],
        ["Lost", null, []],
      ],
    );
  });

  it("counts what items in folders being added will import, but writes only matched items", () => {
    const watched = planMigration(input({ states: fresh({ played: true, playCount: 1 }) }));
    const partial = planMigration(input({ states: fresh({ positionMs: 5_000, favorite: true }) }));

    assert.deepStrictEqual(
      [watched.summary.watched, watched.summary.playCounts, watched.summary.inProgress],
      [1, 1, 0],
    );
    assert.deepStrictEqual([partial.summary.inProgress, partial.summary.favorites], [1, 1]);
    assert.deepStrictEqual(watched.watchState[0]?.items, []);
  });

  it("writes played items at position zero and keeps favorites to movies and shows", () => {
    const plan = planMigration(input({}));
    const [alice] = plan.watchState;

    assert.deepStrictEqual(
      alice?.items.map((write) => [
        write.titleId,
        write.episodeId,
        write.watched,
        write.positionMs,
        write.playCount,
        write.favorite,
      ]),
      [
        ["alien", null, false, 60_000, 0, false],
        ["show", "show-1", true, 0, 0, false],
        ["heat", null, true, 0, 2, false],
        ["show", null, false, 0, 0, true],
      ],
    );
    assert.deepStrictEqual(plan.collections, [
      {
        sourceKey: "jellyfin:server:box",
        name: "Box",
        sortName: null,
        titleIds: [TitleId.make("heat"), TitleId.make("alien")],
      },
    ]);
    assert.deepStrictEqual(plan.overrides, [
      { titleId: TitleId.make("heat"), overrides: { sortName: "Heat 1995" } },
    ]);
  });

  it("counts a conflict when [movies] played an item more recently than the source", () => {
    const newer = planMigration(
      input({ localProgress: new Map([[ALICE, [local("alien", 5_000, 10_000)]]]) }),
    );

    const older = planMigration(
      input({ localProgress: new Map([[ALICE, [local("alien", 500, 10_000)]]]) }),
    );

    const same = planMigration(
      input({ localProgress: new Map([[ALICE, [local("alien", 5_000, 60_000)]]]) }),
    );

    assert.strictEqual(newer.summary.conflicts, 1);
    assert.strictEqual(older.summary.conflicts, 0);
    assert.strictEqual(same.summary.conflicts, 0);
  });
});
