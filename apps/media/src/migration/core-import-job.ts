import type { UserId } from "@media/contracts/ids";
import { failureLine } from "@media/contracts/migration-plan";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type { ImportPhase } from "@media/contracts/models/migration";
import type {
  CollectionImport,
  ImportCheckpoint,
  ImportedCounts,
  ImportWatchItem,
  OverrideImport,
} from "@media/contracts/models/migration-service";
import {
  IMPORT_COLLECTIONS_MAX,
  IMPORT_ITEMS_MAX,
  IMPORT_MEMBERS_MAX,
  serverFunctions,
} from "@media/contracts/server-functions";
import type { Lease } from "@media/contracts/server-functions";
import type { CallError } from "@media/sdk/effect";
import { Duration, Effect, Match, type Redacted } from "effect";
import type { HttpClient } from "effect/http";

import * as CoreJobs from "../core/core-jobs.ts";
import type { JobStopped } from "../core/core-jobs.ts";
import * as CoreSession from "../core/core-session.ts";
import type * as LibraryScanner from "../library/library-scanner.ts";
import { JobFailed } from "../jobs/job-worker.ts";
import * as MediaConfig from "../media-config.ts";
import { coreReads, scannableFolders } from "./core-imports.ts";
import { openCredentials } from "./credentials.ts";
import { computePlan, credentialsBinding, sourceFailure } from "./migrations.ts";
import type { MigrationPlan, ResolvedUser } from "./planner.ts";
import type { SourceError } from "./source-plugin.ts";
import { openSource } from "./sources.ts";

/** How often an import asks whether the scans of its libraries finished, and how long it waits. */
const SCAN_POLL = Duration.seconds(5);

const SCAN_WAIT = Duration.hours(6);

const PHASE_MESSAGES: Readonly<Record<ImportPhase, string>> = {
  libraries: "Adding libraries",
  scanning: "Waiting for new libraries to finish scanning",
  watchState: "Importing watch history and favorites",
  collections: "Importing collections",
  overrides: "Importing metadata overrides",
  done: "Imported",
};

/** What a finished import says it wrote. */
export const doneMessage = (imported: ImportedCounts): string =>
  [
    `${String(imported.watched)} watched`,
    `${String(imported.inProgress)} in progress`,
    `${String(imported.favorites)} favorites`,
    `${String(imported.collections)} collections`,
    `${String(imported.overrides)} overrides`,
    `${String(imported.keptLocal)} kept newer progress`,
    `${String(imported.unmatched)} unmatched`,
  ].join(", ");

const backendFailure = (error: CallError) => new JobFailed({ message: error.message, retry: true });

/**
 * A source failure as the run's error: the line the connect form shows for it (`failureLine`),
 * so a refused API key fails the run with the token field's line. Only an unreachable source is
 * worth another try.
 */
export const sourceJobFailure = (error: SourceError, source: MigrationSource): JobFailed =>
  new JobFailed({
    message: failureLine(sourceFailure(error), source).message,
    retry: Match.value(error).pipe(
      Match.tag("SourceUnreachable", () => true),
      Match.orElse(() => false),
    ),
  });

const planFailure = (source: MigrationSource) =>
  Match.type<SourceError | CallError>().pipe(
    Match.tags({
      SourceUnreachable: (error) => sourceJobFailure(error, source),
      SourceAuthFailed: (error) => sourceJobFailure(error, source),
      SourceNotAdmin: (error) => sourceJobFailure(error, source),
      SourceVersionUnsupported: (error) => sourceJobFailure(error, source),
      SourceUnexpectedResponse: (error) => sourceJobFailure(error, source),
      SourceRequestDenied: (error) => sourceJobFailure(error, source),
    }),
    Match.orElse(backendFailure),
  );

const call = <A>(
  answer: Effect.Effect<
    | { readonly outcome: "held"; readonly value: A }
    | { readonly outcome: "canceled" }
    | { readonly outcome: "lost" },
    CallError
  >,
): Effect.Effect<A, JobFailed | JobStopped> =>
  answer.pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

const watchItemsOf = (plan: MigrationPlan<UserId>) =>
  plan.watchState.map((user) =>
    user.items.map(({ person, ...item }): ImportWatchItem => ({ ...item, userId: person })),
  );

const SCANNING: ImportCheckpoint = { phase: "scanning", unit: 0, cursor: 0 };

const WATCH_START: ImportCheckpoint = { phase: "watchState", unit: 0, cursor: 0 };

const DONE: ImportCheckpoint = { phase: "done", unit: 0, cursor: 0 };

const sameCheckpoint = (left: ImportCheckpoint, right: ImportCheckpoint): boolean =>
  left.phase === right.phase && left.unit === right.unit && left.cursor === right.cursor;

const progressAt = (
  at: ImportCheckpoint,
  watch: ReadonlyArray<ReadonlyArray<ImportWatchItem>>,
  collections: number,
): number => {
  const watched = watch.reduce((sum, items) => sum + items.length, 0);

  return Match.value(at.phase).pipe(
    Match.whenOr("libraries", "scanning", () => 0),
    Match.when("watchState", () =>
      watch.slice(0, at.unit).reduce((sum, items) => sum + items.length, at.cursor),
    ),
    Match.when("collections", () => watched + at.cursor),
    Match.when("overrides", () => watched + collections + at.cursor),
    Match.when("done", () => Number.POSITIVE_INFINITY),
    Match.exhaustive,
  );
};

/** Runs the held import `lease` from its checkpoint to its end and returns its done message. */
const runImport = Effect.fn("CoreImports.run")(function* (
  lease: Lease,
  sealKey: Redacted.Redacted,
  report: (progress: {
    readonly done: number;
    readonly total: number | null;
    readonly message: string;
  }) => Effect.Effect<void>,
) {
  const core = yield* CoreSession.Service;
  const config = yield* MediaConfig.Service;

  const state = yield* call(core.call(serverFunctions.importState, { lease }));

  const credentials = yield* openCredentials(
    sealKey,
    state.plan.credentials,
    credentialsBinding(state.serverId, state.plan.sourceUrl),
  ).pipe(Effect.mapError((error) => new JobFailed({ message: error.message, retry: false })));

  const session = yield* openSource(state.source, { url: state.plan.sourceUrl, credentials }).pipe(
    Effect.mapError((error) => sourceJobFailure(error, state.source)),
  );

  const libraries = state.plan.libraries.length;
  let at = state.checkpoint;
  let imported = state.imported;

  // The libraries come first, then their scans, so the plan matches against what they hold.
  while (at.phase === "libraries") {
    yield* report({
      done: Math.min(at.cursor, libraries),
      total: libraries,
      message: PHASE_MESSAGES.libraries,
    });

    const moved =
      at.cursor < libraries
        ? yield* call(core.call(serverFunctions.importEnsureLibrary, { lease, at }))
        : yield* call(
            core.call(serverFunctions.importAdvance, {
              lease,
              at,
              to: SCANNING,
              unmatched: imported.unmatched,
            }),
          );

    at = moved.at;
    imported = moved.imported;
  }

  if (at.phase === "scanning") {
    yield* report({ done: 0, total: null, message: PHASE_MESSAGES.scanning });

    const pending = call(core.call(serverFunctions.importScansPending, { lease }));

    yield* Effect.gen(function* () {
      while ((yield* pending).pending > 0) yield* Effect.sleep(SCAN_POLL);
    }).pipe(Effect.timeoutOption(SCAN_WAIT));

    const moved = yield* call(
      core.call(serverFunctions.importAdvance, {
        lease,
        at,
        to: WATCH_START,
        unmatched: imported.unmatched,
      }),
    );

    at = moved.at;
    imported = moved.imported;
  }

  const users: ReadonlyArray<ResolvedUser<UserId>> = state.plan.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    name: user.sourceUserId,
    person: user.userId,
    action: "import",
    history: user.history,
  }));

  const scannable = yield* scannableFolders(session, state.plan.pathMappings, config.libraryRoots);

  const plan = yield* computePlan(session, coreReads(core), {
    source: state.source,
    users,
    mappings: state.plan.pathMappings,
    roots: config.libraryRoots,
    withLocalProgress: false,
    addable: (folder) => scannable.has(folder),
  }).pipe(Effect.mapError(planFailure(state.source)));

  const unmatched = plan.summary.itemsUnmatched + plan.summary.itemsAwaitingScan;
  const watch = watchItemsOf(plan);

  // A collection keeps its first members up to the bound, as old movies kept them.
  const collections = plan.collections.map((collection): CollectionImport => ({
    sourceKey: collection.sourceKey,
    name: collection.name,
    sortName: collection.sortName,
    titleIds: collection.titleIds.slice(0, IMPORT_MEMBERS_MAX),
  }));

  const overrides: ReadonlyArray<OverrideImport> = plan.overrides;

  const total =
    watch.reduce((sum, items) => sum + items.length, 0) + collections.length + overrides.length;

  const advance = (from: ImportCheckpoint, to: ImportCheckpoint) =>
    call(core.call(serverFunctions.importAdvance, { lease, at: from, to, unmatched }));

  /** The first checkpoint at or after `from` with items left to send, or the end. */
  const startOf = (from: ImportCheckpoint): ImportCheckpoint =>
    Match.value(from.phase).pipe(
      Match.whenOr("libraries", "scanning", () => startOf(WATCH_START)),
      Match.when("watchState", () => {
        const unit = watch.findIndex(
          (items, index) =>
            index >= from.unit && items.length > (index === from.unit ? from.cursor : 0),
        );

        if (unit === -1) return startOf({ phase: "collections", unit: 0, cursor: 0 });

        return unit === from.unit ? from : { phase: "watchState" as const, unit, cursor: 0 };
      }),
      Match.when("collections", () =>
        from.cursor < collections.length
          ? from
          : startOf({ phase: "overrides", unit: 0, cursor: 0 }),
      ),
      Match.when("overrides", () => (from.cursor < overrides.length ? from : DONE)),
      Match.when("done", () => DONE),
      Match.exhaustive,
    );

  /**
   * The next batch's write from `from`, which has items left. A batch that reaches the end of its
   * user or phase names where the next items start, so the core moves there in the same call.
   */
  const write = (from: ImportCheckpoint) =>
    Match.value(from.phase).pipe(
      Match.when("watchState", () => {
        const items = watch[from.unit] ?? [];
        const batch = items.slice(from.cursor, from.cursor + IMPORT_ITEMS_MAX);
        const last = from.cursor + batch.length >= items.length;
        const args = { lease, at: from, unmatched, items: batch };

        return call(
          core.call(
            serverFunctions.importWatchState,
            last
              ? {
                  ...args,
                  continueAt: startOf({ phase: "watchState", unit: from.unit + 1, cursor: 0 }),
                }
              : args,
          ),
        );
      }),
      Match.when("collections", () => {
        const batch = collections.slice(from.cursor, from.cursor + IMPORT_COLLECTIONS_MAX);
        const last = from.cursor + batch.length >= collections.length;
        const args = { lease, at: from, items: batch };

        return call(
          core.call(
            serverFunctions.importCollections,
            last
              ? { ...args, continueAt: startOf({ phase: "overrides", unit: 0, cursor: 0 }) }
              : args,
          ),
        );
      }),
      Match.orElse(() => {
        const batch = overrides.slice(from.cursor, from.cursor + IMPORT_ITEMS_MAX);
        const last = from.cursor + batch.length >= overrides.length;
        const args = { lease, at: from, items: batch };

        return call(
          core.call(serverFunctions.importEdits, last ? { ...args, continueAt: DONE } : args),
        );
      }),
    );

  for (;;) {
    const start = startOf(at);

    if (!sameCheckpoint(start, at)) {
      const moved = yield* advance(at, start);

      at = moved.at;
      imported = moved.imported;
      continue;
    }

    if (at.phase === "done") break;

    yield* report({
      done: Math.min(total, progressAt(at, watch, collections.length)),
      total,
      message: PHASE_MESSAGES[at.phase],
    });

    const wrote = yield* write(at);

    if (sameCheckpoint(wrote.at, at)) {
      return yield* new JobFailed({
        message: "The core took none of the import's items",
        retry: true,
      });
    }

    at = wrote.at;
    imported = wrote.imported;
  }

  yield* report({ done: total, total, message: PHASE_MESSAGES.done });

  return doneMessage(imported);
});

/** The Jellyfin and Plex import kinds' handlers, opening sealed credentials with `sealKey`. */
export const handlers = (
  sealKey: Redacted.Redacted,
): Effect.Effect<
  ReadonlyArray<CoreJobs.AnyHandler>,
  never,
  CoreSession.Service | MediaConfig.Service | LibraryScanner.Service | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      CoreSession.Service | MediaConfig.Service | LibraryScanner.Service | HttpClient.HttpClient
    >();

    const run = (lease: Lease, report: Parameters<CoreJobs.Handler["run"]>[1]) =>
      runImport(lease, sealKey, report).pipe(Effect.provideContext(context));

    return [
      CoreJobs.handler({
        kind: "movies.import.jellyfin",
        run: (job, report) => run(job.lease, report),
      }),
      CoreJobs.handler({
        kind: "movies.import.plex",
        run: (job, report) => run(job.lease, report),
      }),
    ];
  });
