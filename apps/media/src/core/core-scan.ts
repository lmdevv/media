import type { LibraryId } from "@media/contracts/ids";
import type { IndexedFile, ScannedItem, UpsertedFile } from "@media/contracts/models/scan";
import { SCANNER_BATCH_MAX, serverFunctions } from "@media/contracts/server-functions";
import type { Lease } from "@media/contracts/server-functions";
import type { CallError } from "@media/sdk/effect";
import { Duration, Effect, Match, Option, Ref, Schedule } from "effect";
import type { FileSystem, Path } from "effect";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import {
  absolutePath,
  digestOf,
  relativeTo,
  toScannedCollection,
  toScannedCredits,
  toScannedItem,
} from "../convex/catalog-records.ts";
import { JobFailed } from "../jobs/job-worker.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import type { ScanError, ScanSummary } from "../library/library-scanner.ts";
import * as LibrarySink from "../library/library-sink.ts";
import type * as MediaTools from "../media/media-tools.ts";
import type * as MediaConfig from "../media-config.ts";
import type * as MetadataResolver from "../metadata/title-metadata.ts";
import { bootId, folderChain, folderSource } from "../platform/folder-identity.ts";
import * as CoreJobs from "./core-jobs.ts";
import { JobStopped } from "./core-jobs.ts";
import * as CoreSession from "./core-session.ts";

const PROGRESS_EVERY = Duration.seconds(2);

const DETAIL_CONCURRENCY = 8;

const backendFailure = (error: CallError) => new JobFailed({ message: error.message, retry: true });

/**
 * Sends `items` in calls of at most `max`, each answering how many leading items it committed
 * (`done`), and sends the rest again until every item is committed (ADR 0024). A call that commits
 * none of a non-empty batch fails rather than loop: the core takes at least one item a call.
 */
export const sendAll = Effect.fnUntraced(function* <
  Item,
  Answer extends { readonly done: number },
  E,
>(
  items: ReadonlyArray<Item>,
  max: number,
  send: (batch: ReadonlyArray<Item>) => Effect.Effect<Answer, E>,
) {
  const answers: Array<{ readonly sent: ReadonlyArray<Item>; readonly answer: Answer }> = [];
  let rest = items;

  while (rest.length > 0) {
    const batch = rest.slice(0, max);
    const answer = yield* send(batch);

    if (!Number.isSafeInteger(answer.done) || answer.done < 1 || answer.done > batch.length) {
      return yield* new JobFailed({
        message: `The core committed ${String(answer.done)} of ${String(batch.length)} items`,
        retry: true,
      });
    }

    answers.push({ sent: batch.slice(0, answer.done), answer });
    rest = rest.slice(answer.done);
  }

  return answers;
});

const describe = (summaries: ReadonlyArray<ScanSummary>): string => {
  const total = (pick: (summary: ScanSummary) => number) =>
    summaries.reduce((sum, summary) => sum + pick(summary), 0);

  return [
    `${String(total((s) => s.discovered))} files`,
    `${String(total((s) => s.processed))} new or changed`,
    `${String(total((s) => s.unchanged))} unchanged`,
    `${String(total((s) => s.missing))} missing`,
    `${String(total((s) => s.failed))} unreadable`,
  ].join(", ");
};

const scanFailure = Match.type<ScanError>().pipe(
  Match.tagsExhaustive({
    LibraryRootNotApproved: (error) => new JobFailed({ message: error.message, retry: false }),
    LibraryRootUnavailable: (error) => new JobFailed({ message: error.message, retry: true }),
    LibraryFolderUnreadable: (error) => new JobFailed({ message: error.message, retry: true }),
    LibrarySinkFailed: (error) =>
      error.cause instanceof JobFailed
        ? error.cause
        : new JobFailed({ message: error.message, retry: true }),
  }),
);

/** A sink write that failed, carrying why: the job stopped, or the call failed. */
const fail =
  (operation: LibrarySink.LibrarySinkFailed["operation"]) =>
  (cause: JobFailed | JobStopped): LibrarySink.LibrarySinkFailed =>
    new LibrarySink.LibrarySinkFailed({ operation, cause });

/**
 * One scan job's sink: every write carries the job's lease, so a canceled or replaced attempt
 * writes nothing once the core moved its job (ADR 0012).
 */
const makeSink = Effect.fnUntraced(function* (
  lease: Lease,
  libraryId: LibraryId,
  known: ReadonlyArray<IndexedFile>,
) {
  const session = yield* CoreSession.Service;
  const keys = yield* ArtworkKeys.Service;
  const stopped = yield* Ref.make(Option.none<JobStopped>());
  const latest = yield* Ref.make(Option.none<LibrarySink.ScanProgress>());
  const sent = new Map<string, string>();

  const leased = <Value>(
    answer: Effect.Effect<
      | { readonly outcome: "held"; readonly value: Value }
      | { readonly outcome: "canceled" }
      | { readonly outcome: "lost" },
      CallError
    >,
  ): Effect.Effect<Value, JobStopped | JobFailed> =>
    answer.pipe(
      Effect.mapError(backendFailure),
      Effect.flatMap(CoreJobs.held),
      Effect.tapError((error) =>
        error instanceof JobStopped ? Ref.set(stopped, Option.some(error)) : Effect.void,
      ),
    );

  const previousIndex = (folder: LibrarySink.LibraryFolder) =>
    Effect.succeed(
      known.flatMap((file) =>
        file.missing
          ? []
          : Option.match(relativeTo(folder.root, file.path), {
              onNone: () => [],
              onSome: (relativePath) => [
                {
                  relativePath,
                  sizeBytes: file.sizeBytes,
                  modifiedAtMs: file.mtimeMs,
                  sidecarDigest: file.sidecarDigest ?? undefined,
                },
              ],
            }),
      ),
    );

  const once = <E>(
    key: string,
    digest: string,
    stored: string | null,
    write: Effect.Effect<unknown, E>,
  ) =>
    Effect.suspend(() => {
      if (stored === digest || sent.get(key) === digest) return Effect.void;

      sent.set(key, digest);

      return write.pipe(
        Effect.tapError(() => Effect.sync(() => sent.delete(key))),
        Effect.asVoid,
      );
    });

  const writeDetails = Effect.fnUntraced(function* (
    folder: LibrarySink.LibraryFolder,
    written: ReadonlyArray<{
      readonly file: LibrarySink.ScannedFile;
      readonly upserted: UpsertedFile;
    }>,
  ) {
    const writes = yield* Effect.forEach(written, ({ file, upserted }) =>
      Effect.gen(function* () {
        if (file.title === undefined) return [];
        const titleCredits = yield* toScannedCredits(folder, file.title.credits, keys.seal);
        const collection = yield* toScannedCollection(folder, file.title.collection, keys.seal);
        const titleHash = digestOf(titleCredits);
        const collectionHash = digestOf(collection);

        const titleWrites = [
          once(
            `credits:${upserted.titleId}`,
            titleHash,
            upserted.titleCreditsHash,
            leased(
              session.call(serverFunctions.applyCredits, {
                lease,
                titleId: upserted.titleId,
                episodeId: null,
                credits: titleCredits,
                hash: titleHash,
              }),
            ),
          ),
          once(
            `collection:${upserted.titleId}`,
            collectionHash,
            upserted.collectionHash,
            leased(
              session.call(serverFunctions.applyCollection, {
                lease,
                titleId: upserted.titleId,
                collection,
                hash: collectionHash,
              }),
            ),
          ),
        ];

        if (file.episode === undefined || upserted.episodeId === null) return titleWrites;
        const episodeCredits = yield* toScannedCredits(folder, file.episode.credits, keys.seal);
        const episodeHash = digestOf(episodeCredits);

        const stored =
          upserted.episodeCreditsHash ?? (episodeCredits.length === 0 ? episodeHash : null);

        return [
          ...titleWrites,
          once(
            `credits:${upserted.episodeId}`,
            episodeHash,
            stored,
            leased(
              session.call(serverFunctions.applyCredits, {
                lease,
                titleId: upserted.titleId,
                episodeId: upserted.episodeId,
                credits: episodeCredits,
                hash: episodeHash,
              }),
            ),
          ),
        ];
      }),
    );

    yield* Effect.forEach(writes.flat(), (write) => write, {
      concurrency: DETAIL_CONCURRENCY,
      discard: true,
    });
  });

  const upsertBatch = Effect.fnUntraced(function* (
    folder: LibrarySink.LibraryFolder,
    scanned: ReadonlyArray<LibrarySink.ScannedFile>,
  ) {
    const prepared = yield* Effect.forEach(scanned, (file) =>
      toScannedItem(folder, file, keys.seal).pipe(
        Effect.map(Option.map((item) => ({ file, item }))),
      ),
    );

    const items = prepared.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));

    const answers = yield* sendAll(
      items.map((entry): ScannedItem => entry.item),
      SCANNER_BATCH_MAX,
      (batch) => leased(session.call(serverFunctions.moviesUpsert, { lease, items: batch })),
    ).pipe(Effect.mapError(fail("upsertBatch")));

    const byPath = new Map(
      answers.flatMap(({ answer }) => answer.files.map((file) => [file.path, file] as const)),
    );

    yield* writeDetails(
      folder,
      items.flatMap((entry) => {
        const upserted = byPath.get(entry.item.file.path);

        return upserted === undefined ? [] : [{ file: entry.file, upserted }];
      }),
    ).pipe(
      Effect.catch((error) =>
        error instanceof JobStopped
          ? Effect.fail(fail("upsertBatch")(error))
          : Effect.logWarning("CoreScan.details_failed", error.message).pipe(
              Effect.annotateLogs({ libraryId }),
            ),
      ),
    );
  });

  const markMissing = (folder: LibrarySink.LibraryFolder, relativePaths: ReadonlyArray<string>) =>
    sendAll(
      relativePaths.map((relativePath) => absolutePath(folder, relativePath)),
      SCANNER_BATCH_MAX,
      (paths) => leased(session.call(serverFunctions.moviesMissing, { lease, paths })),
    ).pipe(Effect.asVoid, Effect.mapError(fail("markMissing")));

  const reportProgress = (_folder: LibrarySink.LibraryFolder, progress: LibrarySink.ScanProgress) =>
    Ref.set(latest, Option.some(progress));

  return {
    sink: LibrarySink.Service.of({ previousIndex, upsertBatch, markMissing, reportProgress }),
    stopped: Ref.get(stopped),
    latest: Ref.get(latest),
  };
});

/** Every file the library lists inside its folders, page by page under the lease. */
const knownFiles = (
  session: CoreSession.Interface,
  lease: Lease,
): Effect.Effect<ReadonlyArray<IndexedFile>, JobFailed | JobStopped> => {
  const from = (
    cursor: string | null,
    found: ReadonlyArray<IndexedFile>,
  ): Effect.Effect<ReadonlyArray<IndexedFile>, JobFailed | JobStopped> =>
    session.call(serverFunctions.moviesKnown, { lease, cursor }).pipe(
      Effect.mapError(backendFailure),
      Effect.flatMap(CoreJobs.held),
      Effect.flatMap((page) =>
        page.isDone
          ? Effect.succeed([...found, ...page.files])
          : from(page.continueCursor, [...found, ...page.files]),
      ),
    );

  return from(null, []);
};

const claimFailure = (folder: string) =>
  new JobFailed({
    message:
      folder === ""
        ? "This server's boot could not be identified"
        : `The library folder ${folder} could not be identified`,
    retry: true,
  });

/**
 * The movies scan on the core: the folders under the lease, a claim of each folder by identity so
 * no two libraries list one folder through two paths, then the scanner over this job's own sink.
 */
export const handler = Effect.gen(function* () {
  const session = yield* CoreSession.Service;

  const context = yield* Effect.context<
    | ArtworkKeys.Service
    | CoreSession.Service
    | MediaConfig.Service
    | FileSystem.FileSystem
    | Path.Path
    | MetadataResolver.Service
    | MediaTools.Service
  >();

  return CoreJobs.handler({
    kind: "movies.scan",
    run: Effect.fn("CoreScan.run")(function* (job, report) {
      const { lease } = job;

      const target = yield* session
        .call(serverFunctions.scanTarget, { lease, kind: "movies" })
        .pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

      const known = yield* knownFiles(session, lease);
      const own = yield* makeSink(lease, target.libraryId, known);

      const scanner = yield* LibraryScanner.make.pipe(
        Effect.provideService(LibrarySink.Service, own.sink),
      );

      // A folder must be readable and approved before it is claimed, so a missing or unapproved
      // folder fails as the scan itself would, rather than as an identity it could not read.
      yield* Effect.forEach(target.folders, scanner.openRoot, { discard: true }).pipe(
        Effect.mapError(scanFailure),
      );

      const boot = yield* Effect.tryPromise({ try: bootId, catch: () => claimFailure("") });

      const folders = yield* Effect.forEach(target.folders, (folder) =>
        Effect.tryPromise({
          try: async () => ({
            folder,
            chain: [...(await folderChain(folder))],
            source: await folderSource(folder),
          }),
          catch: () => claimFailure(folder),
        }),
      );

      const claim = yield* session
        .call(serverFunctions.claimFolders, { lease, kind: "movies", bootId: boot, folders })
        .pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

      if (!claim.claimed) {
        return yield* new JobFailed({
          message: `Another library already uses ${claim.folder} under another path; this library scans again on its own once that one lets the folder go`,
          retry: false,
        });
      }

      const publish = own.latest.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (latest) =>
              report({
                done: latest.processed + latest.unchanged + latest.failed,
                total: latest.discovered,
                message: latest.phase,
              }),
          }),
        ),
      );

      const summaries = yield* Effect.forEach(target.folders, (root) =>
        scanner.scan({ libraryId: target.libraryId, root, mode: "incremental" }),
      ).pipe(
        Effect.catch((error) =>
          Effect.flatMap(own.stopped, (stopped): Effect.Effect<never, JobFailed | JobStopped> =>
            Option.isSome(stopped) ? Effect.fail(stopped.value) : Effect.fail(scanFailure(error)),
          ),
        ),
        Effect.raceFirst(
          publish.pipe(
            Effect.repeat(Schedule.spaced(PROGRESS_EVERY)),
            Effect.andThen(Effect.never),
          ),
        ),
      );

      yield* publish;

      return describe(summaries);
    }, Effect.provide(context)),
  });
});
