/**
 * The `music.scan` job on the core's worker protocol (ADR 0012, ADR 0024): the folders under the
 * lease, each checked against `LIBRARY_ROOTS` and claimed by identity so no two libraries list one
 * folder through two paths, then music's scan over the core's music scanner functions, every write
 * carrying the lease. After a scan, finished or not, the artwork its writes released is collected.
 */
import type { KnownTrack } from "@media/contracts/models/music";
import { SCAN_FAILURE_PREFIXES } from "@media/contracts/scan-failure";
import { SCANNER_BATCH_MAX, serverFunctions } from "@media/contracts/server-functions";
import type { Lease } from "@media/contracts/server-functions";
import type { CallError } from "@media/sdk/effect";
import {
  Duration,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  type PlatformError,
  Ref,
  Schedule,
} from "effect";

import * as CoreJobs from "../core/core-jobs.ts";
import { JobFailed } from "../core/core-jobs.ts";
import type { JobStopped } from "../core/core-jobs.ts";
import { claimScanFolders, sendAll } from "../core/core-scan.ts";
import * as CoreSession from "../core/core-session.ts";
import * as MediaConfig from "../media-config.ts";
import * as MusicArt from "./music-art.ts";
import { describeScan, scanLibrary } from "./music-scan.ts";
import type {
  LibraryEmpty,
  LibraryUnavailable,
  PathRange,
  ScanCatalog,
  ScanProgress,
} from "./music-scan.ts";

const PROGRESS_EVERY = Duration.seconds(2);

const backendFailure = (error: CallError) => new JobFailed({ message: error.message, retry: true });

type KnownArgs = typeof serverFunctions.musicKnown.args.Type;

/** A `known` page's arguments: its bounds only where the range has them, never `undefined`. */
const knownArgs = (lease: Lease, cursor: string | null, range: PathRange): KnownArgs => {
  if (range.from === undefined) {
    return range.to === undefined ? { lease, cursor } : { lease, cursor, to: range.to };
  }

  return range.to === undefined
    ? { lease, cursor, from: range.from }
    : { lease, cursor, from: range.from, to: range.to };
};

const isWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate === root ||
  candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

const unavailable = (folder: string, reason: string) =>
  new JobFailed({
    message: `${SCAN_FAILURE_PREFIXES.rootUnavailable}: ${folder} (${reason}); known files were left untouched`,
    retry: true,
  });

const platformReason = (error: PlatformError.PlatformError): string =>
  Match.value(error.reason).pipe(
    Match.tag("NotFound", () => "missing"),
    Match.tag("PermissionDenied", () => "permission-denied"),
    Match.orElse(() => "unreadable"),
  );

/**
 * Checks that a library folder resolves, is a folder, and lies inside `LIBRARY_ROOTS`, before the
 * scan claims it, as the movies scan does: a missing or unapproved folder fails the same way
 * either side of the claim.
 */
const approveFolder = Effect.fnUntraced(function* (folder: string) {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const real = yield* fs
    .realPath(folder)
    .pipe(Effect.mapError((error) => unavailable(folder, platformReason(error))));

  const roots = yield* Effect.forEach(config.libraryRoots, (root) =>
    fs.realPath(root).pipe(Effect.option),
  );

  if (!roots.some((root) => Option.isSome(root) && isWithin(root.value, real, path.sep))) {
    return yield* new JobFailed({
      message: `${SCAN_FAILURE_PREFIXES.rootNotApproved}: ${folder} is outside LIBRARY_ROOTS`,
      retry: false,
    });
  }

  const info = yield* fs.stat(real).pipe(Effect.mapError(() => unavailable(folder, "unreadable")));

  if (info.type !== "Directory") return yield* unavailable(folder, "not-a-directory");

  return real;
});

/** A lease-checked call's value while the lease holds, else why the job stops. */
const leased = <Value>(
  answer: Effect.Effect<
    | { readonly outcome: "held"; readonly value: Value }
    | { readonly outcome: "canceled" }
    | { readonly outcome: "lost" },
    CallError
  >,
): Effect.Effect<Value, JobFailed | JobStopped> =>
  answer.pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

/** The core's music scanner functions under one scan's lease. */
const catalogOf = (
  session: CoreSession.Interface,
  lease: Lease,
): ScanCatalog<JobFailed | JobStopped> => {
  return {
    known: (range) => {
      const pages = (
        cursor: string | null,
        found: ReadonlyArray<KnownTrack>,
      ): Effect.Effect<ReadonlyArray<KnownTrack>, JobFailed | JobStopped> => {
        return leased(
          session.call(serverFunctions.musicKnown, knownArgs(lease, cursor, range)),
        ).pipe(
          Effect.flatMap((page) =>
            page.isDone
              ? Effect.succeed([...found, ...page.files])
              : pages(page.continueCursor, [...found, ...page.files]),
          ),
        );
      };

      return pages(null, []);
    },
    upsert: (tracks) =>
      sendAll(tracks, SCANNER_BATCH_MAX, (batch) =>
        leased(session.call(serverFunctions.musicUpsert, { lease, tracks: batch })),
      ).pipe(Effect.map((answers) => answers.flatMap(({ answer }) => answer.released))),
    move: (moves) =>
      sendAll(moves, SCANNER_BATCH_MAX, (batch) =>
        leased(session.call(serverFunctions.musicMove, { lease, moves: batch })),
      ).pipe(
        Effect.map((answers) => ({
          moved: answers.reduce((sum, { answer }) => sum + answer.moved, 0),
          released: answers.flatMap(({ answer }) => answer.released),
        })),
      ),
    missing: (paths) =>
      sendAll(paths, SCANNER_BATCH_MAX, (batch) =>
        leased(session.call(serverFunctions.musicMissing, { lease, paths: batch })),
      ).pipe(Effect.map((answers) => answers.flatMap(({ answer }) => answer.released))),
    lyrics: (tracks) =>
      sendAll(tracks, SCANNER_BATCH_MAX, (batch) =>
        leased(session.call(serverFunctions.musicLyrics, { lease, tracks: batch })),
      ).pipe(Effect.asVoid),
  };
};

const scanFailure = (error: LibraryUnavailable | LibraryEmpty) =>
  Match.value(error).pipe(
    Match.tag(
      "LibraryEmpty",
      (empty) =>
        new JobFailed({
          message: `${SCAN_FAILURE_PREFIXES.rootUnavailable}: ${empty.message}`,
          retry: false,
        }),
    ),
    Match.tag(
      "LibraryUnavailable",
      (failed) =>
        new JobFailed({
          message: `${SCAN_FAILURE_PREFIXES.folderUnreadable}: ${failed.message}`,
          retry: true,
        }),
    ),
    Match.exhaustive,
  );

/** The music scan's handler, for the server's `music` pool. */
export const handler = Effect.gen(function* () {
  const session = yield* CoreSession.Service;
  const art = yield* MusicArt.Service;

  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // The services a run needs, provided one by one: the layer's whole context holds its own scope,
  // which would stand in for the run's.
  const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return CoreJobs.handler({
    kind: "music.scan",
    run: Effect.fn("MusicScanJob.run")(function* (job, report) {
      const { lease } = job;

      const target = yield* session
        .call(serverFunctions.scanTarget, { lease, kind: "music" })
        .pipe(Effect.mapError(backendFailure), Effect.flatMap(CoreJobs.held));

      yield* Effect.forEach(target.folders, approveFolder, { discard: true });

      yield* claimScanFolders(session, lease, "music", target.folders);

      const progress = yield* Ref.make<ScanProgress>({ done: 0, total: null, message: "Starting" });

      const publish = Ref.get(progress).pipe(
        Effect.flatMap((current) =>
          report({ done: current.done, total: current.total, message: current.message }),
        ),
      );

      const summary = yield* scanLibrary(
        { libraryId: target.libraryId, folders: target.folders, dataDir: config.dataDir },
        catalogOf(session, lease),
        progress,
        art.released,
      ).pipe(
        Effect.catchTags({
          LibraryEmpty: (error) => Effect.fail(scanFailure(error)),
          LibraryUnavailable: (error) => Effect.fail(scanFailure(error)),
        }),
        Effect.raceFirst(
          publish.pipe(
            Effect.repeat(Schedule.spaced(PROGRESS_EVERY)),
            Effect.andThen(Effect.never),
          ),
        ),
        Effect.ensuring(art.collectReleased),
      );

      yield* publish;

      return describeScan(summary);
    }, services),
  });
});
