import { EpisodeId, LibraryId, MediaFileId, TitleId } from "@media/contracts/ids";
import type { CatalogFile } from "@media/contracts/models/migration-service";
import { assert, describe, it } from "@effect/vitest";

import { indexCatalog, ItemMatch, matchItems } from "./matching.ts";
import type { SourceItem } from "./source-plugin.ts";

const LIBRARY = LibraryId.make("library");

const noIds = { tmdb: null, imdb: null, tvdb: null };

const movieFile = (
  title: string,
  path: string,
  ids: CatalogFile["externalIds"] = noIds,
  missing = false,
): CatalogFile => ({
  fileId: MediaFileId.make(`file-${title}`),
  libraryId: LIBRARY,
  path,
  missing,
  titleId: TitleId.make(title),
  kind: "movie",
  externalIds: ids,
  episodeId: null,
  seasonNumber: null,
  episodeNumber: null,
});

const episodeFile = (
  show: string,
  season: number,
  episode: number,
  path: string,
  ids: CatalogFile["externalIds"] = noIds,
): CatalogFile => ({
  fileId: MediaFileId.make(`file-${show}-${String(season)}-${String(episode)}`),
  libraryId: LIBRARY,
  path,
  missing: false,
  titleId: TitleId.make(show),
  kind: "show",
  externalIds: ids,
  episodeId: EpisodeId.make(`${show}-${String(season)}-${String(episode)}`),
  seasonNumber: season,
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
  libraryId: "source-library",
  paths,
  ids: noIds,
  seriesId: null,
  seasonNumber: null,
  episodeNumber: null,
  overrides: {},
  ...extra,
});

const context = {
  mappings: [{ from: "/data", to: "/mnt/nas" }],
  roots: ["/mnt/nas"],
  pendingRoots: ["/mnt/nas/new"],
};

const catalog = indexCatalog([
  movieFile("heat", "/mnt/nas/movies/Heat (1995)/Heat.mkv", { ...noIds, tmdb: "949" }),
  movieFile("alien", "/mnt/nas/movies/Alien (1979)/Alien.mkv", { ...noIds, imdb: "tt0078748" }),
  episodeFile("lost", 1, 1, "/mnt/nas/shows/Lost/Season 1/Lost S01E01.mkv", {
    ...noIds,
    tvdb: "73739",
  }),
  episodeFile("lost", 1, 2, "/mnt/nas/shows/Lost/Season 1/Lost S01E02.mkv", {
    ...noIds,
    tvdb: "73739",
  }),
]);

const describeMatch = (match: ItemMatch | undefined): string =>
  match === undefined
    ? "none"
    : ItemMatch.$match(match, {
        Matched: ({ by, titleId, episodeId }) => `${by}:${titleId}:${episodeId ?? "-"}`,
        AwaitingScan: () => "awaiting",
        Unmatched: ({ reason }) => `unmatched:${reason}`,
      });

describe("matchItems", () => {
  it("prefers the file path, then provider IDs", () => {
    const matches = matchItems(
      [
        item("by-path", "movie", ["/data/movies/Heat (1995)/Heat.mkv"], {
          ids: { ...noIds, imdb: "tt0078748" },
        }),
        item("by-tmdb", "movie", ["/data/moved/Heat.mkv"], { ids: { ...noIds, tmdb: "949" } }),
        item("by-imdb", "movie", [], { ids: { ...noIds, imdb: "TT0078748" } }),
      ],
      catalog,
      context,
    );

    assert.strictEqual(describeMatch(matches.get("by-path")), "path:heat:-");
    assert.strictEqual(describeMatch(matches.get("by-tmdb")), "providerId:heat:-");
    assert.strictEqual(describeMatch(matches.get("by-imdb")), "providerId:alien:-");
  });

  it("matches episodes through their show and season and episode numbers", () => {
    const matches = matchItems(
      [
        item("show", "series", ["/elsewhere/Lost"], { ids: { ...noIds, tvdb: "73739" } }),
        item("e2", "episode", ["/elsewhere/Lost/S01E02.mkv"], {
          seriesId: "show",
          seasonNumber: 1,
          episodeNumber: 2,
        }),
        item("e9", "episode", ["/elsewhere/Lost/S01E09.mkv"], {
          seriesId: "show",
          seasonNumber: 1,
          episodeNumber: 9,
        }),
      ],
      catalog,
      context,
    );

    assert.strictEqual(describeMatch(matches.get("show")), "providerId:lost:-");
    assert.strictEqual(describeMatch(matches.get("e2")), "providerId:lost:lost-1-2");
    assert.strictEqual(describeMatch(matches.get("e9")), "unmatched:path_unmapped");
  });

  it("finds a show through its folder or an episode matched by path", () => {
    const matches = matchItems(
      [
        item("by-folder", "series", ["/data/shows/Lost"]),
        item("by-episode", "series", []),
        item("e1", "episode", ["/data/shows/Lost/Season 1/Lost S01E01.mkv"], {
          seriesId: "by-episode",
          seasonNumber: 1,
          episodeNumber: 1,
        }),
      ],
      catalog,
      context,
    );

    assert.strictEqual(describeMatch(matches.get("by-folder")), "path:lost:-");
    assert.strictEqual(describeMatch(matches.get("by-episode")), "providerId:lost:-");
    assert.strictEqual(describeMatch(matches.get("e1")), "path:lost:lost-1-1");
  });

  it("says why an item did not match, and waits for folders being added", () => {
    const matches = matchItems(
      [
        item("no-path", "movie", []),
        item("unmapped", "movie", ["/other/Film.mkv"]),
        item("missing", "movie", ["/data/movies/Unknown/Unknown.mkv"]),
        item("pending", "movie", ["/data/new/Fresh/Fresh.mkv"]),
      ],
      catalog,
      context,
    );

    assert.strictEqual(describeMatch(matches.get("no-path")), "unmatched:no_path");
    assert.strictEqual(describeMatch(matches.get("unmapped")), "unmatched:path_unmapped");
    assert.strictEqual(describeMatch(matches.get("missing")), "unmatched:not_in_catalog");
    assert.strictEqual(describeMatch(matches.get("pending")), "awaiting");
  });

  it("prefers a present file over a missing one at the same path", () => {
    const index = indexCatalog([
      movieFile("old", "/mnt/nas/movies/X.mkv", noIds, true),
      movieFile("new", "/mnt/nas/movies/X.mkv"),
    ]);

    const matches = matchItems([item("x", "movie", ["/data/movies/X.mkv"])], index, context);

    assert.strictEqual(describeMatch(matches.get("x")), "path:new:-");
  });
});
