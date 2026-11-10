import { NotFound } from "@media/contracts/errors";
import { BACKUP_SYNC_MAX, serverFunctions } from "@media/contracts/server-functions";
import { EpochMillis } from "@media/contracts/units";
import { Effect, Layer, Match } from "effect";

import * as Backups from "../backups/backups.ts";
import { JobFailed } from "../jobs/job-worker.ts";
import * as CoreJobs from "./core-jobs.ts";
import * as CoreSession from "./core-session.ts";

/**
 * The core's backups table. A sync sends the folder's archives, at most 500 a call, and pages
 * through the table's rows until every row matches the folder.
 */
export const catalogLayer: Layer.Layer<Backups.Catalog, never, CoreSession.Service> = Layer.effect(
  Backups.Catalog,
  Effect.gen(function* () {
    const session = yield* CoreSession.Service;

    const syncListed = (
      archives: Parameters<Backups.CatalogInterface["sync"]>[0],
      listedAt: number,
    ) =>
      Effect.gen(function* () {
        let cursor: string | null = null;

        for (;;) {
          const page: { readonly continueCursor: string; readonly isDone: boolean } =
            yield* session.call(serverFunctions.syncBackups, {
              archives,
              cursor,
              listedAt: EpochMillis.make(listedAt),
            });

          if (page.isDone) return;
          cursor = page.continueCursor;
        }
      });

    return Backups.Catalog.of({
      // The table lists at most the newest 500 archives; retention keeps far fewer.
      sync: (archives, listedAt) => {
        const newest = archives.toSorted((left, right) => right.takenAt - left.takenAt);
        const listed = newest.slice(0, BACKUP_SYNC_MAX);

        return (
          newest.length > listed.length
            ? Effect.logWarning("CoreBackups.too_many_archives").pipe(
                Effect.annotateLogs({ archives: newest.length, listed: listed.length }),
              )
            : Effect.void
        ).pipe(Effect.andThen(syncListed(listed, listedAt)));
      },
      fileOf: (backupId) =>
        session.call(serverFunctions.backupFile, { backupId }).pipe(
          Effect.filterOrFail(
            (found) => found !== null,
            () => new NotFound({ message: "No such backup" }),
          ),
        ),
    });
  }),
);

const STEPS = 3;

const failure = Match.type<Backups.CreateError>().pipe(
  Match.tagsExhaustive({
    BackupBusy: (error) => new JobFailed({ message: error.message, retry: true }),
    BackupFolderFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    ConvexCliFailed: (error) => new JobFailed({ message: error.message, retry: true }),
    ConvexCliUnavailable: (error) => new JobFailed({ message: error.message, retry: false }),
  }),
);

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The backup job on the core: export, record the archive under the lease, prune. */
export const handler = Effect.gen(function* () {
  const backups = yield* Backups.Service;
  const session = yield* CoreSession.Service;

  return CoreJobs.handler({
    kind: "server.backup",
    run: Effect.fn("CoreBackup.run")(function* (job, report) {
      yield* report({ done: 0, total: STEPS, message: "Exporting" });
      const archive = yield* backups.create(job.payload.trigger).pipe(Effect.mapError(failure));
      yield* report({ done: 1, total: STEPS, message: "Recording" });

      yield* session
        .call(serverFunctions.recordBackup, {
          lease: job.lease,
          fileName: archive.fileName,
          sizeBytes: archive.sizeBytes,
          takenAt: archive.takenAt,
        })
        .pipe(
          Effect.mapError((error) => new JobFailed({ message: error.message, retry: true })),
          Effect.flatMap(CoreJobs.held),
        );

      yield* report({ done: 2, total: STEPS, message: "Pruning" });

      const pruned = yield* backups.prune(archive.fileName).pipe(
        Effect.map((removed) => `removed ${String(removed.length)} past retention`),
        Effect.catch((error) =>
          Effect.logWarning("CoreBackup.prune_failed", error).pipe(
            Effect.as(`pruning failed: ${error.message}`),
          ),
        ),
      );

      yield* report({ done: STEPS, total: STEPS });

      return `${archive.fileName}, ${megabytes(archive.sizeBytes)}; ${pruned}`;
    }),
  });
});
