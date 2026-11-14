/**
 * Rescans after a file changes, on the core (ADR 0024). The server watches each folder of every
 * movies and music library at the path the library names, following the core's list of them live,
 * and asks the core to queue a scan of the libraries a change reaches (`core/scans:changed`). A
 * folder that reaches an approved root through a link is watched at its own path, so the paths a
 * change names are the ones the core knows. It never scans itself: on the core a scan writes only
 * under a scan job's lease, so the core's scan queue runs it, joining a scan already queued or
 * running.
 */
import type { LibraryId } from "@media/contracts/ids";
import { serverFunctions } from "@media/contracts/server-functions";
import { Duration, Effect, FileSystem, Layer, Option, type Path, Semaphore, Stream } from "effect";

import * as LibraryMonitor from "../library/library-monitor.ts";
import { folderChain, folderSource } from "../platform/folder-identity.ts";
import * as MediaConfig from "../media-config.ts";
import * as CoreSession from "./core-session.ts";

/** Most paths one burst names before the whole root is sent instead. */
const PATHS_MAX = 32;

const isInside = (path: string, folder: string): boolean =>
  path !== folder && path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * The paths a burst names, each one only once and none inside another it names, since the core
 * queues the libraries holding a path or lying inside it. The root alone when the burst named none,
 * or more than `PATHS_MAX`.
 */
export const pathsToSend = (
  root: string,
  changed: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const distinct = [...new Set(changed)];
  const outermost = distinct.filter((path) => !distinct.some((other) => isInside(path, other)));

  return outermost.length === 0 || outermost.length > PATHS_MAX ? [root] : outermost;
};

const WATCHED_PAGE = 64;

interface WatchedLibrary {
  readonly libraryId: LibraryId;
  readonly folders: ReadonlyArray<string>;
}

const watchedLibraries = (
  session: CoreSession.Interface,
  cursor: string | null = null,
): Stream.Stream<ReadonlyArray<WatchedLibrary>> =>
  session
    .watch(serverFunctions.scanWatched, {
      paginationOpts: { numItems: WATCHED_PAGE, cursor },
    })
    .pipe(
      Stream.switchMap((page) =>
        page.isDone
          ? Stream.succeed(page.page)
          : watchedLibraries(session, page.continueCursor).pipe(
              Stream.map((rest) => [...page.page, ...rest]),
            ),
      ),
    );

const RESOLVE_TIMEOUT = Duration.seconds(5);

/** Folders resolved at once, so a share that stops answering holds the list for one timeout. */
const RESOLVE_CONCURRENCY = 16;

/** What a folder is to the claims (ADR 0024): its real path's device and inode, and its source. */
const identitiesOf = (folder: string) =>
  Effect.tryPromise(async () => {
    const [chain, source] = await Promise.all([folderChain(folder), folderSource(folder)]);

    return [
      ...chain.slice(0, 1).map((head) => `inode ${head}`),
      ...(source === null ? [] : [`source ${source.device} ${source.path}`]),
    ];
  }).pipe(
    Effect.timeoutOption(RESOLVE_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

interface Resolved {
  readonly folder: string;
  readonly outside: boolean;
  readonly identities: ReadonlyArray<string>;
}

/**
 * Each library of `libraries` with the folders of it to watch. A folder that leads outside every
 * approved root is left out, as the scanner refuses it; one that cannot be resolved now, such as a
 * share not mounted yet, stays, and its watch retries. A folder another listed before it already
 * is, by the claims' identity, such as a link to it, is left out, so one change asks once. A
 * library left with no folder is left out.
 */
export const foldersToWatch = Effect.fn("CoreRescans.foldersToWatch")(function* (
  libraries: ReadonlyArray<WatchedLibrary>,
) {
  const config = yield* MediaConfig.Service;
  const fs = yield* FileSystem.FileSystem;

  const roots = (yield* Effect.forEach(config.libraryRoots, (root) =>
    fs.realPath(root).pipe(Effect.option),
  )).flatMap((root) => (Option.isSome(root) ? [root.value] : []));

  const resolve = (folder: string) =>
    Effect.all({
      real: fs.realPath(folder).pipe(
        Effect.timeoutOption(RESOLVE_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
      identities: identitiesOf(folder),
    }).pipe(
      Effect.map(({ real, identities }): Resolved => ({
        folder,
        outside:
          Option.isSome(real) &&
          !roots.some((root) => real.value === root || isInside(real.value, root)),
        identities,
      })),
    );

  const resolved = yield* Effect.forEach(
    libraries,
    (library) =>
      Effect.forEach(library.folders, resolve, { concurrency: RESOLVE_CONCURRENCY }).pipe(
        Effect.map((folders) => ({ libraryId: library.libraryId, folders })),
      ),
    { concurrency: RESOLVE_CONCURRENCY },
  );

  const seen = new Set<string>();

  return resolved.flatMap(({ libraryId, folders }) => {
    const kept = folders.filter(({ outside, identities }) => {
      if (outside || identities.some((identity) => seen.has(identity))) return false;

      for (const identity of identities) seen.add(identity);

      return true;
    });

    return kept.length === 0 ? [] : [{ libraryId, roots: kept.map(({ folder }) => folder) }];
  });
});

/** Watches every movies and music library's folders and asks the core to rescan what changed. */
export const layer: Layer.Layer<
  never,
  never,
  MediaConfig.Service | CoreSession.Service | FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const session = yield* CoreSession.Service;
    // One call at a time: every library's monitor asks at startup and on each reconcile, and
    // concurrent enqueues of the scan kind conflict on its jobKinds row (ADR 0024).
    const calls = yield* Semaphore.make(1);

    const rescan: LibraryMonitor.Rescan = Effect.fn("CoreRescans.rescan")(
      function* (library, reason, changed) {
        const root = library.roots[0];

        if (root === undefined) return;

        const answers = yield* Effect.forEach(pathsToSend(root, changed), (path) =>
          calls.withPermits(1)(session.call(serverFunctions.scanChanged, { path })),
        );

        const queued = answers.reduce((total, answer) => total + answer.queued, 0);

        if (queued > 0) {
          yield* Effect.logInfo("CoreRescans.queued").pipe(
            Effect.annotateLogs({ reason, libraries: queued }),
          );
        }
      },
      (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
    );

    const tracking = Layer.effectDiscard(
      Effect.gen(function* () {
        const monitor = yield* LibraryMonitor.Service;

        // The list is checked again on the reconcile interval too, so a folder mounted later
        // outside the approved roots stops being watched without waiting for a library to change.
        yield* watchedLibraries(session).pipe(
          Stream.switchMap((libraries) =>
            Stream.tick(config.reconcileInterval).pipe(Stream.as(libraries)),
          ),
          Stream.runForEach((libraries) =>
            foldersToWatch(libraries).pipe(Effect.flatMap(monitor.track)),
          ),
          Effect.forkScoped,
        );
      }),
    );

    return tracking.pipe(Layer.provide(LibraryMonitor.layerWith(rescan)));
  }),
);
