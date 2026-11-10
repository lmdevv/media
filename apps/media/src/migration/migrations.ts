import type { PathMapping } from "@media/contracts/models/migration";
import type { MigrationSource } from "@media/contracts/models/jobs";
import { MigrationSourceFailure } from "@media/contracts/models/migration";
import type { CatalogFile, LocalProgress } from "@media/contracts/models/migration-service";
import type { CallError } from "@media/sdk/effect";
import { Effect, FileSystem, Schema } from "effect";

import { mappingCandidates, normalizePath, toLocalPath } from "./paths.ts";
import { type ExistingLibrary, planMigration, type ResolvedUser } from "./planner.ts";
import type { SourceError, SourceSession } from "./source-plugin.ts";
import { failureReasonOf } from "./source-plugin.ts";

/** A source failure as the "Couldn't connect" screen shows it. */
export const sourceFailure = (error: SourceError): MigrationSourceFailure => ({
  status: "failed",
  reason: failureReasonOf(error),
  message: error.message,
});

/** Whether a connect, dry run, or import answered a source failure. */
export const isSourceFailure = Schema.is(MigrationSourceFailure);

/** What a plan reads of the catalog it imports into. */
export interface PlanReads<Person extends string> {
  readonly libraries: Effect.Effect<ReadonlyArray<ExistingLibrary>, CallError>;
  /** Every catalog file, read page by page. */
  readonly catalog: Effect.Effect<ReadonlyArray<CatalogFile>, CallError>;
  readonly localProgress: (
    person: Person,
  ) => Effect.Effect<ReadonlyArray<LocalProgress>, CallError>;
}

/** What `computePlan` plans for. */
export interface PlanTarget<Person extends string> {
  readonly source: MigrationSource;
  readonly users: ReadonlyArray<ResolvedUser<Person>>;
  readonly mappings: ReadonlyArray<PathMapping>;
  readonly roots: ReadonlyArray<string>;
  /** Read each imported person's progress, for a dry run's conflicts. */
  readonly withLocalProgress: boolean;
  /** Whether the import may add a library on a folder no library covers. */
  readonly addable: (folder: string) => boolean;
}

/** The plan a dry run computes, from the source and the catalog as they are now. */
export const computePlan = Effect.fnUntraced(function* <Person extends string>(
  session: SourceSession,
  reads: PlanReads<Person>,
  target: PlanTarget<Person>,
) {
  const { users } = target;
  const imported = users.filter((user) => user.action === "import");

  const people = [
    ...new Set(imported.flatMap((user) => (user.person === null ? [] : [user.person]))),
  ];

  const stateOf = (user: ResolvedUser<Person>) => {
    const sourceUser = session.users.find((candidate) => candidate.userId === user.sourceUserId);

    return sourceUser === undefined
      ? Effect.succeed([user.sourceUserId, []] as const)
      : session
          .userStates(sourceUser)
          .pipe(Effect.map((found) => [user.sourceUserId, found] as const));
  };

  // The source and the catalog answer independently, so their reads overlap; each still asks
  // one thing at a time, as a small server can take.
  const [source, catalogReads] = yield* Effect.all(
    [
      Effect.all({
        items: session.items,
        collections: session.collections,
        states: Effect.forEach(imported, stateOf),
      }),
      Effect.all({
        existingLibraries: reads.libraries,
        catalog: reads.catalog,
        localProgress: target.withLocalProgress
          ? Effect.forEach(people, (person) =>
              reads.localProgress(person).pipe(Effect.map((rows) => [person, rows] as const)),
            )
          : Effect.succeed([]),
      }),
    ],
    { concurrency: 2 },
  );

  const { items, collections } = source;
  const { existingLibraries, catalog } = catalogReads;
  const states = new Map(source.states);
  const localProgress = new Map(catalogReads.localProgress);

  return planMigration({
    source: target.source,
    server: session.server,
    libraries: session.libraries,
    items,
    collections,
    users,
    states,
    mappings: target.mappings,
    roots: target.roots,
    existingLibraries,
    addable: target.addable,
    catalog,
    localProgress,
  });
});

/**
 * Local folders under `roots` for each source folder no mapping in `given` or root covers: the
 * first candidate (`mappingCandidates`) that is a directory on this host.
 */
export const inferMappings = Effect.fnUntraced(function* (
  folders: ReadonlyArray<string>,
  given: ReadonlyArray<PathMapping>,
  roots: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const inferred: Array<PathMapping> = [];

  for (const folder of folders) {
    if (toLocalPath(folder, [...given, ...inferred], roots) !== null) continue;

    for (const candidate of mappingCandidates(folder, roots)) {
      const isDirectory = yield* fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

      if (isDirectory) {
        inferred.push({ from: normalizePath(folder), to: candidate });
        break;
      }
    }
  }

  return inferred;
});

/** The binding sealed credentials carry, so they open only for the plan they were sealed for. */
export const credentialsBinding = (serverId: string, sourceUrl: string): string =>
  `${serverId}\n${sourceUrl}`;
