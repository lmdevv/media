import type { LibraryId, ProfileId } from "@media/contracts/ids";
import type { LibraryKind } from "@media/contracts/models/catalog";
import type {
  MigrationReport,
  MigrationSummary,
  PathMapping,
  PlannedLibraryAccess,
  UnmatchedReason,
} from "@media/contracts/models/migration";
import type {
  CatalogFile,
  CollectionImport,
  LocalProgress,
  OverrideImport,
  WatchStateImport,
} from "@media/contracts/models/migration-service";
import type { MigrationSource } from "@media/contracts/models/jobs";
import { EpochMillis, Milliseconds } from "@media/contracts/units";

import { indexCatalog, ItemMatch, matchItems } from "./matching.ts";
import { isInside, toLocalPath } from "./paths.ts";
import type {
  SourceCollection,
  SourceItem,
  SourceItemState,
  SourceLibrary,
  SourceLibraryAccess,
  SourceServer,
} from "./source-plugin.ts";

const SAMPLE_LIMIT = 25;

/**
 * A source user and who receives their history, if anyone: a profile of old movies, or a user of
 * the core (`Person`).
 */
export interface ResolvedUser<Person extends string> {
  readonly sourceUserId: string;
  readonly name: string;
  readonly person: Person | null;
  readonly action: "import" | "skip" | "invite";
  readonly history: "full" | "plays";
}

/** A library already here and its folders. */
export interface ExistingLibrary {
  readonly id: LibraryId;
  readonly roots: ReadonlyArray<string>;
}

interface PlannedLibrary {
  readonly sourceLibraryId: string;
  readonly name: string;
  readonly kind: LibraryKind;
  readonly roots: ReadonlyArray<string>;
  readonly existingLibraryId: LibraryId | null;
  readonly newRoots: ReadonlyArray<string>;
  readonly unmappedFolders: ReadonlyArray<string>;
  readonly access: PlannedLibraryAccess;
}

/** Everything a plan is computed from. */
export interface PlanInput<Person extends string> {
  readonly source: MigrationSource;
  readonly server: SourceServer;
  readonly libraries: ReadonlyArray<SourceLibrary>;
  readonly items: ReadonlyArray<SourceItem>;
  readonly collections: ReadonlyArray<SourceCollection>;
  readonly users: ReadonlyArray<ResolvedUser<Person>>;
  /** Each imported user's states, by source user ID. */
  readonly states: ReadonlyMap<string, ReadonlyArray<SourceItemState>>;
  readonly mappings: ReadonlyArray<PathMapping>;
  /** Approved library roots of this host. */
  readonly roots: ReadonlyArray<string>;
  readonly existingLibraries: ReadonlyArray<ExistingLibrary>;
  /**
   * Whether the import may add a library on a local folder no library covers, whose items then
   * wait for its first scan; the items of a folder it may not stay unmatched.
   */
  readonly addable: (folder: string) => boolean;
  readonly catalog: ReadonlyArray<CatalogFile>;
  /** Each imported person's current progress. */
  readonly localProgress: ReadonlyMap<Person, ReadonlyArray<LocalProgress>>;
}

/** One matched item's watch state for the person receiving a source user's history. */
type WatchWrite<Person extends string> = Omit<WatchStateImport, "profileId"> & {
  readonly person: Person;
};

interface UserWatchState<Person extends string> {
  readonly sourceUserId: string;
  readonly items: ReadonlyArray<WatchWrite<Person>>;
}

/** A computed migration plan. */
export interface MigrationPlan<Person extends string> {
  readonly libraries: ReadonlyArray<PlannedLibrary>;
  readonly summary: MigrationSummary;
  readonly unmatchedSamples: ReadonlyArray<{
    readonly name: string;
    readonly path: string | null;
    readonly reason: UnmatchedReason;
  }>;
  readonly watchState: ReadonlyArray<UserWatchState<Person>>;
  readonly collections: ReadonlyArray<CollectionImport>;
  readonly overrides: ReadonlyArray<OverrideImport>;
}

const libraryKindOf = (kind: SourceLibrary["kind"]): LibraryKind | null => {
  if (kind === "other") return null;

  return kind;
};

const plannedAccess = (
  access: SourceLibraryAccess,
  imported: ReadonlySet<string>,
): PlannedLibraryAccess => {
  if (access.kind === "everyone") return { kind: "everyone" };

  if (access.kind === "unknown") return { kind: "users", sourceUserIds: [] };

  return { kind: "users", sourceUserIds: access.userIds.filter((userId) => imported.has(userId)) };
};

const coveringLibrary = (existing: ReadonlyArray<ExistingLibrary>, folder: string) =>
  existing.find((candidate) =>
    candidate.roots.some((root) => isInside(folder, root) || isInside(root, folder)),
  );

const planLibraries = (
  libraries: ReadonlyArray<SourceLibrary>,
  mappings: ReadonlyArray<PathMapping>,
  roots: ReadonlyArray<string>,
  existing: ReadonlyArray<ExistingLibrary>,
  imported: ReadonlySet<string>,
  addable: (folder: string) => boolean,
): ReadonlyArray<PlannedLibrary> =>
  libraries.flatMap((library) => {
    const kind = libraryKindOf(library.kind);

    if (kind === null) return [];

    const folders = library.paths.map((path) => ({
      path,
      local: toLocalPath(path, mappings, roots),
    }));

    const local = [
      ...new Set(folders.flatMap(({ local: found }) => (found === null ? [] : [found]))),
    ];

    const usable = local.filter(
      (folder) => coveringLibrary(existing, folder) !== undefined || addable(folder),
    );

    const coveringIds = local.flatMap((folder) => {
      const found = coveringLibrary(existing, folder);

      return found === undefined ? [] : [found.id];
    });

    return [
      {
        sourceLibraryId: library.libraryId,
        name: library.name,
        kind,
        roots: usable,
        existingLibraryId: coveringIds[0] ?? null,
        newRoots: local.filter(
          (folder) => coveringLibrary(existing, folder) === undefined && addable(folder),
        ),
        unmappedFolders: folders.flatMap(({ path, local: found }) =>
          found === null ? [path] : [],
        ),
        access: plannedAccess(library.access, imported),
      },
    ];
  });

const progressKey = (titleId: string, episodeId: string | null): string =>
  `${titleId}|${episodeId ?? ""}`;

const isPlayed = (write: ImportValues): boolean =>
  write.watched || write.positionMs > 0 || write.playCount > 0;

const keepsLocal = (write: ImportValues, local: LocalProgress | undefined): boolean => {
  if (local === undefined || !isPlayed(write)) return false;
  const sourceNewer = write.lastPlayedAt !== null && local.lastPlayedAt < write.lastPlayedAt;

  return !sourceNewer && (local.positionMs !== write.positionMs || local.watched !== write.watched);
};

const valuesOf = (state: SourceItemState, item: SourceItem) => {
  const series = item.kind === "series";
  const favorite = state.favorite && item.kind !== "episode";

  if (series && !favorite) return null;

  return {
    watched: !series && state.played,
    positionMs: Milliseconds.make(series || state.played ? 0 : state.positionMs),
    playCount: series ? 0 : state.playCount,
    lastPlayedAt: state.lastPlayedAt === null ? null : EpochMillis.make(state.lastPlayedAt),
    favorite,
  };
};

interface ImportValues {
  readonly watched: boolean;
  readonly positionMs: number;
  readonly playCount: number;
  readonly lastPlayedAt: number | null;
  readonly favorite: boolean;
}

/**
 * How many items import a watched mark, a position, a play count or last-played date, and a
 * favorite. The dry run's summary and the job's counts both use it, so the Done screen reports
 * what the Review screen promised.
 */
export const countImports = (items: ReadonlyArray<ImportValues>) => ({
  watched: items.filter((values) => values.watched).length,
  inProgress: items.filter((values) => values.positionMs > 0).length,
  playCounts: items.filter(
    (values) =>
      (values.watched || values.positionMs > 0 || values.playCount > 0) &&
      (values.playCount > 0 || values.lastPlayedAt !== null),
  ).length,
  favorites: items.filter((values) => values.favorite).length,
});

/** Computes the plan. */
export const planMigration = <Person extends string>(
  input: PlanInput<Person>,
): MigrationPlan<Person> => {
  const libraries = planLibraries(
    input.libraries,
    input.mappings,
    input.roots,
    input.existingLibraries,
    new Set(
      input.users.flatMap((user) =>
        user.action === "import" && user.person !== null ? [user.sourceUserId] : [],
      ),
    ),
    input.addable,
  );

  const pendingRoots = libraries.flatMap((library) => library.newRoots);
  const index = indexCatalog(input.catalog);

  const matches = matchItems(input.items, index, {
    mappings: input.mappings,
    roots: input.roots,
    pendingRoots,
  });

  const itemsById = new Map(input.items.map((item) => [item.itemId, item]));
  const media = input.items.filter((item) => item.kind !== "series");
  const counts = { byPath: 0, byProviderId: 0, awaitingScan: 0, unmatched: 0 };
  const samples: Array<MigrationPlan<Person>["unmatchedSamples"][number]> = [];

  for (const item of media) {
    const match = matches.get(item.itemId) ?? ItemMatch.Unmatched({ reason: "not_in_catalog" });

    ItemMatch.$match(match, {
      Matched: ({ by }) => {
        if (by === "path") counts.byPath += 1;
        else counts.byProviderId += 1;
      },
      AwaitingScan: () => {
        counts.awaitingScan += 1;
      },
      Unmatched: ({ reason }) => {
        counts.unmatched += 1;

        if (samples.length < SAMPLE_LIMIT) {
          samples.push({ name: item.name, path: item.paths[0] ?? null, reason });
        }
      },
    });
  }

  const matchedOf = (itemId: string) => {
    const match = matches.get(itemId);

    return match !== undefined && ItemMatch.$is("Matched")(match) ? match : null;
  };

  const importable = (itemId: string): boolean => {
    const match = matches.get(itemId);

    return match !== undefined && !ItemMatch.$is("Unmatched")(match);
  };

  const imported = input.users.flatMap((user) =>
    user.action === "import" && user.person !== null ? [{ ...user, person: user.person }] : [],
  );

  const watchState = imported
    .toSorted((left, right) => left.sourceUserId.localeCompare(right.sourceUserId))
    .map((user): UserWatchState<Person> => {
      const states = (input.states.get(user.sourceUserId) ?? []).toSorted((left, right) =>
        left.itemId.localeCompare(right.itemId),
      );

      const items = states.flatMap((state): Array<WatchWrite<Person>> => {
        const match = matchedOf(state.itemId);
        const item = itemsById.get(state.itemId);
        const values = item === undefined ? null : valuesOf(state, item);

        if (match === null || values === null) return [];

        return [
          {
            person: user.person,
            titleId: match.titleId,
            episodeId: match.episodeId,
            fileId: match.fileId,
            ...values,
          },
        ];
      });

      return { sourceUserId: user.sourceUserId, items };
    });

  const writes = watchState.flatMap((user) => user.items);

  const localByPerson = new Map(
    [...input.localProgress].map(([person, rows]) => [
      person,
      new Map(rows.map((row) => [progressKey(row.titleId, row.episodeId), row])),
    ]),
  );

  const conflicts = writes.filter((write) =>
    keepsLocal(
      write,
      localByPerson.get(write.person)?.get(progressKey(write.titleId, write.episodeId)),
    ),
  ).length;

  const collections = input.collections
    .map((collection): CollectionImport => ({
      sourceKey: `${input.source}:${input.server.serverId}:${collection.collectionId}`,
      name: collection.name,
      sortName: collection.sortName,
      titleIds: [
        ...new Set(
          collection.itemIds.flatMap((itemId) => {
            const match = matchedOf(itemId);

            return match === null ? [] : [match.titleId];
          }),
        ),
      ],
    }))
    .filter((collection) => collection.titleIds.length > 0);

  const overridesByTitle = new Map<string, OverrideImport>();

  for (const item of input.items) {
    const match = matchedOf(item.itemId);
    const hasOverrides = Object.keys(item.overrides).length > 0;
    const hasIds = Object.values(item.ids).some((id) => id !== null);

    if (item.kind === "episode" || match === null || (!hasOverrides && !hasIds)) continue;
    const previous = overridesByTitle.get(match.titleId);
    const known = previous?.externalIds;

    const merged: OverrideImport = {
      titleId: match.titleId,
      overrides: hasOverrides ? item.overrides : (previous?.overrides ?? {}),
    };

    overridesByTitle.set(
      match.titleId,
      known === undefined && !hasIds
        ? merged
        : {
            titleId: merged.titleId,
            overrides: merged.overrides,
            externalIds: {
              tmdb: known?.tmdb ?? item.ids.tmdb,
              imdb: known?.imdb ?? item.ids.imdb,
              tvdb: known?.tvdb ?? item.ids.tvdb,
            },
          },
    );
  }

  const overrides = [...overridesByTitle.values()];

  const projected = imported.flatMap((user) =>
    (input.states.get(user.sourceUserId) ?? []).flatMap((state) => {
      const item = itemsById.get(state.itemId);
      const values = item === undefined || !importable(state.itemId) ? null : valuesOf(state, item);

      return values === null ? [] : [values];
    }),
  );

  const projectedCollections = input.collections.filter((collection) =>
    collection.itemIds.some(importable),
  ).length;

  const projectedOverrides = new Set(
    input.items.flatMap((item) =>
      item.kind === "episode" ||
      Object.keys(item.overrides).length === 0 ||
      !importable(item.itemId)
        ? []
        : [matchedOf(item.itemId)?.titleId ?? item.itemId],
    ),
  ).size;

  const summary: MigrationSummary = {
    usersMapped: imported.length,
    usersUnmapped: input.users.length - imported.length,
    librariesToAdd: libraries.filter((library) => library.newRoots.length > 0).length,
    librariesExisting: libraries.filter(
      (library) => library.newRoots.length === 0 && library.existingLibraryId !== null,
    ).length,
    itemsByPath: counts.byPath,
    itemsByProviderId: counts.byProviderId,
    itemsAwaitingScan: counts.awaitingScan,
    itemsUnmatched: counts.unmatched,
    ...countImports(projected),
    collections: projectedCollections,
    overrides: projectedOverrides,
    conflicts,
  };

  return {
    libraries,
    summary,
    unmatchedSamples: samples,
    watchState,
    collections,
    overrides,
  };
};

interface ReportContext<Person extends string> {
  readonly connectionId: string;
  readonly source: MigrationSource;
  readonly serverName: string;
  readonly createdAt: number;
  readonly users: ReadonlyArray<ResolvedUser<Person>>;
}

/** What the Review screen shows for `plan` but who receives each source user's history. */
export const reportBody = <Person extends string>(
  plan: MigrationPlan<Person>,
  context: ReportContext<Person>,
): Omit<MigrationReport, "users"> => ({
  status: "ready",
  connectionId: context.connectionId,
  source: context.source,
  serverName: context.serverName,
  createdAt: EpochMillis.make(context.createdAt),
  summary: plan.summary,
  libraries: plan.libraries.map((library) => ({
    sourceLibraryId: library.sourceLibraryId,
    name: library.name,
    kind: library.kind,
    roots: library.roots,
    existingLibraryId: library.newRoots.length === 0 ? library.existingLibraryId : null,
    unmappedFolders: library.unmappedFolders,
    access: library.access,
  })),
  unmatchedSamples: plan.unmatchedSamples,
});

/** The report the Review screen shows for `plan`. */
export const reportOf = (
  plan: MigrationPlan<ProfileId>,
  context: ReportContext<ProfileId>,
): MigrationReport => ({
  ...reportBody(plan, context),
  users: context.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    name: user.name,
    profileId: user.person,
    action: user.action,
  })),
});
