import type { BackupId } from "@media/contracts/ids";
import type { BackupArchive } from "@media/contracts/models/jobs";
import type { CallError } from "@media/sdk/effect";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Schedule,
  Schema,
  Semaphore,
} from "effect";

import * as MediaConfig from "../media-config.ts";
import { modifiedAtMs } from "../platform/file-info.ts";
import * as Archives from "./backup-archives.ts";
import * as ConvexCli from "./convex-cli.ts";

class BackupBusy extends Schema.TaggedError<BackupBusy>()("BackupBusy", {}) {
  override get message(): string {
    return "Backup busy: another backup or restore is running; try again when it finished";
  }
}

class BackupFolderFailed extends Schema.TaggedError<BackupFolderFailed>()("BackupFolderFailed", {
  operation: Schema.Literals(["prepare", "list", "finish", "remove", "resolve"]),
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Backup folder failed: could not ${this.operation} (${this.reason}); check BACKUP_DIR and its permissions`;
  }
}

class BackupArchiveMissing extends Schema.TaggedError<BackupArchiveMissing>()(
  "BackupArchiveMissing",
  { fileName: Schema.String },
) {
  override get message(): string {
    return `Backup archive missing: ${this.fileName} is not in the backup folder`;
  }
}

/** Failures of taking a backup. */
export type CreateError = BackupBusy | BackupFolderFailed | ConvexCli.ConvexCliError;

type RestoreError =
  | BackupBusy
  | BackupArchiveMissing
  | BackupFolderFailed
  | ConvexCli.ConvexCliError
  | CallError;

/** Backups of the core's Convex deployment. */
export interface Interface {
  /** Exports the deployment into a new archive and returns it. */
  readonly create: (trigger: Archives.BackupTrigger) => Effect.Effect<BackupArchive, CreateError>;
  /**
   * Removes archives older than the retention, except `keep`, then syncs the table; returns the
   * removed file names.
   */
  readonly prune: (
    keep: string,
  ) => Effect.Effect<ReadonlyArray<string>, BackupFolderFailed | CallError>;
  /** Makes the Convex `backups` table list exactly the archives in the folder. */
  readonly sync: Effect.Effect<void, BackupFolderFailed | CallError>;
  /** Replaces the whole database with a backup, then ends every session. */
  readonly restore: (backupId: BackupId) => Effect.Effect<void, RestoreError>;
}

/** Where the server records the archives it holds: the core's backups table. */
export interface CatalogInterface {
  /**
   * Makes the table list exactly `archives`, listed from the folder starting at `listedAt`. A row
   * a backup recorded after that stays, since the listing could not have seen its archive.
   */
  readonly sync: (
    archives: ReadonlyArray<BackupArchive>,
    listedAt: number,
  ) => Effect.Effect<void, CallError>;
  /** The archive a backup row names, for a restore. */
  readonly fileOf: (backupId: BackupId) => Effect.Effect<{ readonly fileName: string }, CallError>;
}

/** The backups table the server keeps in step with its folder. */
export class Catalog extends Context.Service<Catalog, CatalogInterface>()(
  "@media/server/Backups/Catalog",
) {}

/** Database backups. */
export class Service extends Context.Service<Service, Interface>()("@media/server/Backups") {}

const folderFailed =
  (operation: BackupFolderFailed["operation"]) => (cause: PlatformError.PlatformError) =>
    new BackupFolderFailed({
      operation,
      reason: Match.value(cause.reason).pipe(
        Match.tag("NotFound", () => "missing"),
        Match.tag("PermissionDenied", () => "permission denied"),
        Match.tag("AlreadyExists", () => "already exists"),
        Match.orElse(() => "unreadable"),
      ),
      cause,
    });

const compact = (printed: string): string => printed.replaceAll(/\s+/gu, "");

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli = yield* ConvexCli.Service;
  const catalog = yield* Catalog;
  const permit = yield* Semaphore.make(1);
  const folder = config.backupDir;

  const exclusively = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | BackupBusy> =>
    Semaphore.withPermitsIfAvailable(
      permit,
      1,
    )(effect).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new BackupBusy()),
          onSome: Effect.succeed,
        }),
      ),
    );

  const prepareFolder = Effect.gen(function* () {
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.chmod(folder, 0o700);
  }).pipe(Effect.mapError(folderFailed("prepare")));

  const listArchives = Effect.gen(function* () {
    const names = yield* fs.readDirectory(folder);

    const archives = yield* Effect.forEach(
      names.filter(Archives.isArchiveName),
      (name) =>
        fs
          .stat(path.join(folder, name))
          .pipe(
            Effect.map((info) =>
              info.type === "File"
                ? Option.some(Archives.describeArchive(name, Number(info.size), modifiedAtMs(info)))
                : Option.none(),
            ),
          ),
      { concurrency: 8 },
    );

    return archives.flatMap(Option.toArray);
  }).pipe(Effect.mapError(folderFailed("list")));

  const removePartials = Effect.gen(function* () {
    const names = yield* fs.readDirectory(folder);

    yield* Effect.forEach(
      names.filter(Archives.isPartial),
      (name) => fs.remove(path.join(folder, name), { force: true }),
      { discard: true },
    );
  }).pipe(Effect.mapError(folderFailed("remove")));

  const sync = Effect.gen(function* () {
    const listedAt = yield* Clock.currentTimeMillis;

    yield* catalog.sync(yield* listArchives, listedAt);
  }).pipe(Effect.withSpan("Backups.sync"));

  const create = Effect.fn("Backups.create")(
    function* (trigger: Archives.BackupTrigger) {
      yield* prepareFolder;
      yield* removePartials;
      const takenAt = yield* Clock.currentTimeMillis;
      const fileName = Archives.archiveName(trigger, takenAt);
      const partial = path.join(folder, Archives.partialName(fileName));
      const final = path.join(folder, fileName);

      yield* Effect.gen(function* () {
        yield* cli.exportSnapshot(partial);

        yield* Effect.gen(function* () {
          yield* fs.chmod(partial, 0o600);
          yield* fs.rename(partial, final);
        }).pipe(Effect.mapError(folderFailed("finish")));
      }).pipe(Effect.onError(() => fs.remove(partial, { force: true }).pipe(Effect.ignore)));

      const info = yield* fs.stat(final).pipe(Effect.mapError(folderFailed("finish")));
      const archive = Archives.describeArchive(fileName, Number(info.size), takenAt);

      yield* Effect.logInfo("Backups.created").pipe(
        Effect.annotateLogs({ fileName, sizeBytes: archive.sizeBytes, trigger }),
      );

      return archive;
    },
    (effect, trigger) =>
      exclusively(effect).pipe(Effect.withSpan("Backups.backup", { attributes: { trigger } })),
  );

  const prune = Effect.fn("Backups.prune")(function* (keep: string) {
    const now = yield* Clock.currentTimeMillis;
    const archives = yield* listArchives;

    const expired = Archives.expiredArchives(archives, now, config.backupRetention, keep);

    yield* Effect.forEach(
      expired,
      (archive) =>
        fs
          .remove(path.join(folder, archive.fileName), { force: true })
          .pipe(Effect.mapError(folderFailed("remove"))),
      { discard: true },
    );

    yield* sync;

    return expired.map((archive) => archive.fileName);
  });

  const archivePath = Effect.fnUntraced(function* (fileName: string) {
    if (!Archives.isArchiveName(fileName)) return yield* new BackupArchiveMissing({ fileName });
    const missing = () => new BackupArchiveMissing({ fileName });
    const realFolder = yield* fs.realPath(folder).pipe(Effect.mapError(folderFailed("resolve")));
    const real = yield* fs.realPath(path.join(folder, fileName)).pipe(Effect.mapError(missing));
    const info = yield* fs.stat(real).pipe(Effect.mapError(missing));

    if (path.dirname(real) !== realFolder || info.type !== "File") return yield* missing();

    return real;
  });

  const restore = Effect.fn("Backups.restore")(function* (backupId: BackupId) {
    yield* exclusively(
      Effect.gen(function* () {
        const { fileName } = yield* catalog.fileOf(backupId);
        const archive = yield* archivePath(fileName);

        yield* Effect.logWarning("Backups.restore_started").pipe(Effect.annotateLogs({ fileName }));

        const importedFrom = yield* Clock.currentTimeMillis;

        yield* cli.importSnapshot(archive);

        // The snapshot caught its own backup job, and maybe others, mid-run, and carries the
        // sessions it was taken with. Every session from before the import ends, the server's own
        // included; `CoreSession` signs in again with its key, which works only if the snapshot
        // holds it (ADR 0010).
        const settled = yield* cli.run("core/maintenance:settleRestoredJobs", {
          before: importedFrom,
        });

        const ended = yield* cli.run("core/maintenance:endAllSessions", { before: importedFrom });

        yield* Effect.logWarning("Backups.restored").pipe(
          Effect.annotateLogs({ fileName, jobs: compact(settled), sessions: compact(ended) }),
        );
      }),
    );

    yield* sync.pipe(
      Effect.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 }))),
      Effect.catch((error) => Effect.logWarning("Backups.sync_after_restore_failed", error)),
    );
  });

  return Service.of({ create, prune, sync, restore });
});

/** The backups service. */
export const layer: Layer.Layer<
  Service,
  never,
  MediaConfig.Service | FileSystem.FileSystem | Path.Path | ConvexCli.Service | Catalog
> = Layer.effect(Service, make);

/**
 * Syncs the backups table with the folder once Convex is reachable after startup, so archives a
 * restore or an admin left behind show up. Retries with backoff for a few minutes.
 */
export const layerSyncOnStart: Layer.Layer<never, never, Service> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backups = yield* Service;

    yield* backups.sync.pipe(
      Effect.retry(Schedule.exponential("2 seconds").pipe(Schedule.upTo({ times: 8 }))),
      Effect.catch((error) => Effect.logWarning("Backups.startup_sync_failed", error)),
      Effect.forkScoped,
    );
  }),
);
