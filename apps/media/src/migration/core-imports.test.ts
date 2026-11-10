import { LibraryId, MediaFileId, TitleId, UserId } from "@media/contracts/ids";
import { failureLine } from "@media/contracts/migration-plan";
import type { ImportSourceUser } from "@media/contracts/models/migration";
import type { CatalogFile } from "@media/contracts/models/migration-service";
import { assert, describe, it } from "@effect/vitest";

import { doneMessage, sourceJobFailure } from "./core-import-job.ts";
import { coreReportOf, resolveImportUsers, suggestUser } from "./core-imports.ts";
import { planMigration } from "./planner.ts";
import type { ResolvedUser } from "./planner.ts";
import { SourceAuthFailed, SourceUnreachable } from "./source-plugin.ts";
import type { SourceItem, SourceItemState } from "./source-plugin.ts";

const LUCIA = UserId.make("lucia");

const MATEO = UserId.make("mateo");

const TARGETS = [
  { userId: LUCIA, username: "lucia" },
  { userId: MATEO, username: "Mateo" },
];

const sourceUser = (
  sourceUserId: string,
  name: string,
  suggestion: ImportSourceUser["suggestion"],
): ImportSourceUser => ({
  sourceUserId,
  name,
  email: null,
  isAdmin: false,
  suggestion,
  history: "full",
});

const item = (itemId: string, path: string): SourceItem => ({
  itemId,
  kind: "movie",
  name: itemId,
  libraryId: "lib",
  paths: [path],
  ids: { tmdb: null, imdb: null, tvdb: null },
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  overrides: {},
});

const state = (itemId: string): SourceItemState => ({
  itemId,
  played: true,
  positionMs: 0,
  playCount: 1,
  lastPlayedAt: 1_000,
  favorite: false,
});

const file = (titleId: string, path: string): CatalogFile => ({
  fileId: MediaFileId.make(`${titleId}-file`),
  libraryId: LibraryId.make("films"),
  path,
  missing: false,
  titleId: TitleId.make(titleId),
  kind: "movie",
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  episodeId: null,
  seasonNumber: null,
  episodeNumber: null,
});

describe("the importer's flow on the core", () => {
  it("suggests the core user with the same name, and invites anyone else", () => {
    assert.deepStrictEqual(suggestUser({ name: " Lucia " }, TARGETS), {
      kind: "user",
      userId: LUCIA,
      matchedBy: "name",
    });
    assert.deepStrictEqual(suggestUser({ name: "mateo" }, TARGETS), {
      kind: "user",
      userId: MATEO,
      matchedBy: "name",
    });
    assert.deepStrictEqual(suggestUser({ name: "Aiko" }, TARGETS), { kind: "invite" });
  });

  it("maps each source user to the user chosen, the one suggested, or no one", () => {
    const resolved = resolveImportUsers(
      [
        sourceUser("1", "lucia", { kind: "user", userId: LUCIA, matchedBy: "name" }),
        sourceUser("2", "mateo", { kind: "user", userId: MATEO, matchedBy: "name" }),
        sourceUser("3", "aiko", { kind: "invite" }),
        sourceUser("4", "sam", { kind: "invite" }),
      ],
      [
        { sourceUserId: "2", userId: null },
        { sourceUserId: "4", userId: LUCIA },
      ],
    );

    assert.deepStrictEqual(
      resolved.map((user) => [user.sourceUserId, user.action, user.person]),
      [
        ["1", "import", LUCIA],
        ["2", "skip", null],
        ["3", "invite", null],
        ["4", "import", LUCIA],
      ],
    );
  });

  it("reports a folder no library covers as one the import adds, its items waiting for its scan", () => {
    const users: ReadonlyArray<ResolvedUser<UserId>> = [
      { sourceUserId: "u1", name: "lucia", person: LUCIA, action: "import", history: "full" },
    ];

    const plan = planMigration<UserId>({
      source: "jellyfin",
      server: { serverId: "den", name: "Den", version: "10.11.0" },
      libraries: [
        {
          libraryId: "films",
          name: "Films",
          kind: "movies",
          paths: ["/data/films"],
          access: { kind: "everyone" },
        },
        {
          libraryId: "home",
          name: "Home videos",
          kind: "movies",
          paths: ["/data/home"],
          access: { kind: "everyone" },
        },
      ],
      items: [item("heat", "/data/films/Heat.mkv"), item("party", "/data/home/Party.mkv")],
      collections: [],
      users,
      states: new Map([["u1", [state("heat"), state("party")]]]),
      mappings: [{ from: "/data", to: "/srv" }],
      roots: ["/srv"],
      existingLibraries: [{ id: LibraryId.make("films"), roots: ["/srv/films"] }],
      addable: () => true,
      catalog: [file("heat", "/srv/films/Heat.mkv")],
      localProgress: new Map(),
    });

    const report = coreReportOf(plan, {
      connectionId: "connection",
      source: "jellyfin",
      serverName: "Den",
      createdAt: 1,
      users,
    });

    assert.deepStrictEqual(
      {
        librariesToAdd: report.summary.librariesToAdd,
        librariesExisting: report.summary.librariesExisting,
        itemsByPath: report.summary.itemsByPath,
        itemsAwaitingScan: report.summary.itemsAwaitingScan,
        itemsUnmatched: report.summary.itemsUnmatched,
        watched: report.summary.watched,
      },
      {
        librariesToAdd: 1,
        librariesExisting: 1,
        itemsByPath: 1,
        itemsAwaitingScan: 1,
        itemsUnmatched: 0,
        watched: 2,
      },
    );
    assert.deepStrictEqual(
      report.libraries.map((library) => [library.name, library.existingLibraryId]),
      [
        ["Films", LibraryId.make("films")],
        ["Home videos", null],
      ],
    );
    assert.deepStrictEqual(report.unmatchedSamples, []);
    assert.deepStrictEqual(
      plan.watchState.flatMap((user) => user.items.map((write) => [write.person, write.titleId])),
      [[LUCIA, TitleId.make("heat")]],
    );
  });

  it("fails a run whose key the source refuses with the token field's line, for good", () => {
    const refused = sourceJobFailure(new SourceAuthFailed({ source: "plex" }), "plex");

    assert.strictEqual(
      refused.message,
      failureLine({ status: "failed", reason: "auth_failed", message: "" }, "plex").message,
    );
    assert.strictEqual(refused.retry, false);

    const away = sourceJobFailure(
      new SourceUnreachable({ source: "jellyfin", operation: "users", detail: "refused" }),
      "jellyfin",
    );

    assert.strictEqual(away.message, "Nothing answered at this address.");
    assert.strictEqual(away.retry, true);
  });

  it("says what a finished run wrote", () => {
    assert.strictEqual(
      doneMessage({
        librariesAdded: 0,
        watched: 2,
        inProgress: 1,
        favorites: 1,
        collections: 1,
        overrides: 1,
        keptLocal: 0,
        unmatched: 3,
      }),
      "2 watched, 1 in progress, 1 favorites, 1 collections, 1 overrides, 0 kept newer progress, 3 unmatched",
    );
  });
});
