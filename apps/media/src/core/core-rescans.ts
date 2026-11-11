/**
 * Rescans after a file changes, on the core (ADR 0024). The server watches each approved library
 * root, as standalone mode does, and asks the core to queue a scan of the movies libraries a change
 * reaches (`core/scans:changed`), and of every movies library at startup and on its reconcile
 * interval (`core/scans:reconcile`). It never scans itself: on the core a scan writes only under a scan
 * job's lease, so the core's scan queue runs it, joining a scan already queued or running.
 */
import { serverFunctions } from "@media/contracts/server-functions";
import { Effect, type FileSystem, Layer, type Path } from "effect";

import * as LibraryMonitor from "../library/library-monitor.ts";
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

/** Watches every approved root and asks the core to rescan what changed. */
export const layer: Layer.Layer<
  never,
  never,
  MediaConfig.Service | CoreSession.Service | FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const session = yield* CoreSession.Service;

    const rescan: LibraryMonitor.Rescan = Effect.fn("CoreRescans.rescan")(
      function* (library, reason, changed) {
        const root = library.roots[0];

        if (root === undefined) return;

        // At startup and on the reconcile interval every movies library is brought up to date,
        // as old movies' reconcile did, which reaches a library whose folder lies under this root
        // only through a symlink and so never matches a changed path.
        const answers =
          reason === "change"
            ? yield* Effect.forEach(pathsToSend(root, changed), (path) =>
                session.call(serverFunctions.scanChanged, { path }),
              )
            : [yield* session.call(serverFunctions.scanReconcile, {})];

        const queued = answers.reduce((total, answer) => total + answer.queued, 0);

        if (queued > 0) {
          yield* Effect.logInfo("CoreRescans.queued").pipe(
            Effect.annotateLogs({ reason, libraries: queued }),
          );
        }
      },
      (effect, library) => effect.pipe(Effect.annotateLogs({ libraryId: library.libraryId })),
    );

    return LibraryMonitor.layerTracking(LibraryMonitor.rootLibraries(config.libraryRoots)).pipe(
      Layer.provide(LibraryMonitor.layerWith(rescan)),
    );
  }),
);
