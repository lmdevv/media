import type { PathMapping, UnmatchedReason } from "@media/contracts/models/migration";
import type { CatalogFile } from "@media/contracts/models/migration-service";
import type { EpisodeId, MediaFileId, TitleId } from "@media/contracts/ids";
import { Data } from "effect";

import { isInside, normalizePath, toLocalPath } from "./paths.ts";
import type { SourceItem } from "./source-plugin.ts";

/** How one source item matched. */
export type ItemMatch = Data.TaggedEnum<{
  Matched: {
    readonly by: "path" | "providerId";
    readonly titleId: TitleId;
    /** The episode, for episodes; null for movies and shows. */
    readonly episodeId: EpisodeId | null;
    /** The matched file, for movies and episodes. */
    readonly fileId: MediaFileId | null;
  };
  /** In a folder the import adds; it matches by path after the new library's first scan. */
  AwaitingScan: {};
  Unmatched: { readonly reason: UnmatchedReason };
}>;

/** Constructors and matchers for `ItemMatch`. */
export const ItemMatch = Data.taggedEnum<ItemMatch>();

/** Lookups over the [movies] catalog. */
export interface CatalogIndex {
  readonly byPath: ReadonlyMap<string, CatalogFile>;
  readonly movies: ReadonlyMap<string, CatalogFile>;
  readonly shows: ReadonlyMap<string, TitleId>;
  readonly episodes: ReadonlyMap<string, CatalogFile>;
  /** Every folder above a show's files, to the show. */
  readonly showFolders: ReadonlyMap<string, TitleId>;
}

/** Where source paths land on this host. */
export interface PathContext {
  readonly mappings: ReadonlyArray<PathMapping>;
  /** Approved library roots: source paths already inside one need no mapping. */
  readonly roots: ReadonlyArray<string>;
  /** Local folders of libraries the import adds, not scanned yet. */
  readonly pendingRoots: ReadonlyArray<string>;
}

const pathKey = (path: string): string => {
  const normalized = normalizePath(path);

  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
};

const idKey = (provider: "tmdb" | "imdb" | "tvdb", id: string): string =>
  `${provider}:${id.trim().toLowerCase()}`;

const episodeKey = (titleId: TitleId, season: number, episode: number): string =>
  `${titleId}|${String(season)}|${String(episode)}`;

const ancestorsOf = (path: string): ReadonlyArray<string> => {
  const segments = normalizePath(path).split("/");

  return segments.slice(1, -1).map((_, index) => segments.slice(0, index + 2).join("/") || "/");
};

/** Indexes the catalog. A present file wins over a missing one with the same path. */
export const indexCatalog = (files: ReadonlyArray<CatalogFile>): CatalogIndex => {
  const byPath = new Map<string, CatalogFile>();
  const movies = new Map<string, CatalogFile>();
  const shows = new Map<string, TitleId>();
  const episodes = new Map<string, CatalogFile>();
  const showFolders = new Map<string, TitleId>();
  const ordered = files.toSorted((left, right) => Number(left.missing) - Number(right.missing));

  for (const file of ordered) {
    const key = pathKey(file.path);

    if (!byPath.has(key)) byPath.set(key, file);

    const providers = (["tmdb", "imdb", "tvdb"] as const).flatMap((provider) => {
      const id = file.externalIds[provider];

      return id === null ? [] : [idKey(provider, id)];
    });

    if (file.kind === "movie") {
      for (const id of providers) if (!movies.has(id)) movies.set(id, file);
      continue;
    }

    for (const id of providers) if (!shows.has(id)) shows.set(id, file.titleId);

    for (const folder of ancestorsOf(file.path)) {
      const folderKey = pathKey(folder);

      if (!showFolders.has(folderKey)) showFolders.set(folderKey, file.titleId);
    }

    if (file.seasonNumber !== null && file.episodeNumber !== null) {
      const keyed = episodeKey(file.titleId, file.seasonNumber, file.episodeNumber);

      if (!episodes.has(keyed)) episodes.set(keyed, file);
    }
  }

  return { byPath, movies, shows, episodes, showFolders };
};

const providerOrder = ["tmdb", "imdb", "tvdb"] as const;

const locate = (item: SourceItem, context: PathContext) => {
  const local = item.paths.flatMap((path) => {
    const mapped = toLocalPath(path, context.mappings, context.roots);

    return mapped === null ? [] : [mapped];
  });

  return {
    local,
    pending: local.some((path) => context.pendingRoots.some((root) => isInside(path, root))),
  };
};

const unmatchedReason = (item: SourceItem, local: ReadonlyArray<string>): UnmatchedReason => {
  if (item.paths.length === 0) return "no_path";

  return local.length === 0 ? "path_unmapped" : "not_in_catalog";
};

const fallback = (item: SourceItem, located: ReturnType<typeof locate>): ItemMatch =>
  located.pending
    ? ItemMatch.AwaitingScan()
    : ItemMatch.Unmatched({ reason: unmatchedReason(item, located.local) });

const matchFile = (file: CatalogFile, by: "path" | "providerId"): ItemMatch =>
  ItemMatch.Matched({
    by,
    titleId: file.titleId,
    episodeId: file.episodeId,
    fileId: file.fileId,
  });

const showByIds = (index: CatalogIndex, item: SourceItem): TitleId | undefined =>
  providerOrder
    .flatMap((provider) => {
      const id = item.ids[provider];
      const titleId = id === null ? undefined : index.shows.get(idKey(provider, id));

      return titleId === undefined ? [] : [titleId];
    })
    .at(0);

/**
 * Matches every item. Episodes matched by path also identify their show, so a show whose folder
 * and IDs are unknown still matches through its episodes.
 */
export const matchItems = (
  items: ReadonlyArray<SourceItem>,
  index: CatalogIndex,
  context: PathContext,
): ReadonlyMap<string, ItemMatch> => {
  const matches = new Map<string, ItemMatch>();

  const byPath = (paths: ReadonlyArray<string>) =>
    paths.map((path) => index.byPath.get(pathKey(path))).find((file) => file !== undefined);

  for (const item of items) {
    if (item.kind === "series") continue;
    const located = locate(item, context);
    const file = byPath(located.local);

    if (file !== undefined) {
      matches.set(item.itemId, matchFile(file, "path"));
      continue;
    }

    if (item.kind === "movie") {
      const byId = providerOrder
        .flatMap((provider) => {
          const id = item.ids[provider];
          const found = id === null ? undefined : index.movies.get(idKey(provider, id));

          return found === undefined ? [] : [found];
        })
        .at(0);

      matches.set(
        item.itemId,
        byId === undefined ? fallback(item, located) : matchFile(byId, "providerId"),
      );
    }
  }

  const seriesTitles = new Map<string, TitleId>();

  for (const item of items) {
    const match = matches.get(item.itemId);

    if (
      item.kind === "episode" &&
      item.seriesId !== null &&
      match !== undefined &&
      ItemMatch.$is("Matched")(match)
    ) {
      seriesTitles.set(item.seriesId, match.titleId);
    }
  }

  for (const item of items) {
    if (item.kind !== "series") continue;
    const located = locate(item, context);

    const titleId =
      located.local
        .map((path) => index.showFolders.get(pathKey(path)))
        .find((found) => found !== undefined) ??
      showByIds(index, item) ??
      seriesTitles.get(item.itemId);

    if (titleId !== undefined) {
      const by = located.local.some((path) => index.showFolders.has(pathKey(path)))
        ? "path"
        : "providerId";

      matches.set(item.itemId, ItemMatch.Matched({ by, titleId, episodeId: null, fileId: null }));
      seriesTitles.set(item.itemId, titleId);
    } else {
      matches.set(item.itemId, fallback(item, located));
    }
  }

  for (const item of items) {
    if (item.kind !== "episode" || matches.has(item.itemId)) continue;
    const located = locate(item, context);
    const showId = item.seriesId === null ? undefined : seriesTitles.get(item.seriesId);

    const file =
      showId === undefined || item.seasonNumber === null || item.episodeNumber === null
        ? undefined
        : index.episodes.get(episodeKey(showId, item.seasonNumber, item.episodeNumber));

    matches.set(
      item.itemId,
      file === undefined ? fallback(item, located) : matchFile(file, "providerId"),
    );
  }

  return matches;
};
