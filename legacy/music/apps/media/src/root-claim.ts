/**
 * Claims a library's real folder before a scan reads it. A link or a bind mount can give one
 * folder two names (`/proc/self/root/srv/music` is `/srv/music`), so Convex's check of the path a
 * library was added with is not enough to keep two libraries off the same files. The service
 * resolves the folder through every link, refuses one outside the allowed roots (`MUSIC_ROOTS`)
 * or in /proc, /sys, or /dev, and reports it to Convex (`media:claimRoot`) with the identity of
 * the folder and each one above it, which a bind mount can't change. Convex refuses a folder that
 * overlaps another library's by path or by identity. Nothing is indexed unless the claim
 * succeeds, and a refusal stops the library streaming; it runs again at every scan, since a
 * link's target can change.
 */
import type { LibraryId } from "@music/commands/ids";
import { isSystemFolder, SYSTEM_FOLDER_MESSAGE } from "@music/commands/system-folders";
import { Effect, FiberMap, Layer, Ref, Schema, Semaphore, Stream } from "effect";

import { cappedBackoff } from "./backoff.ts";

import * as Files from "./files.ts";
import { type LibraryFolder, MediaBackend, resubscribeSchedule } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";
import { fsPathOf, type Mount } from "./mounts.ts";
import * as NodeFiles from "./platform/node-files.ts";

/** The library's folder may not be scanned. The message is safe to show on the job. */
class RootRefused extends Schema.TaggedError<RootRefused>()("RootRefused", {
  libraryId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** What a claim reads of the machine: its mount table and its boot (see `files.ts`). */
interface Host {
  readonly mounts: ReadonlyArray<Mount> | null;
  readonly bootId: string | null;
}

const readHost: Effect.Effect<Host> = Effect.all({
  mounts: Files.readMounts,
  bootId: Files.readBootId,
});

/**
 * Resolves the library's folder, checks it, and claims it with Convex. Returns the real folder,
 * which the scan then reads instead of the path the library was added with. Fails with
 * `FileError` when the folder does not resolve, and with `RootRefused` when it may not be read.
 */
export const claimRoot = Effect.fn("RootClaim.claim")(function* (
  library: { readonly id: LibraryId; readonly path: string },
  /** The mount table and boot, when the caller read them once for many claims. */
  given?: Host,
) {
  const backend = yield* MediaBackend;
  const { musicRoots } = yield* MediaConfig;

  // Refused here, before Convex sees it: drop any earlier claim too, so it stops streaming.
  const refuse = (reason: string) =>
    backend
      .refuseRoot(library.id)
      .pipe(Effect.andThen(Effect.fail(new RootRefused({ libraryId: library.id, reason }))));

  if (isSystemFolder(library.path)) return yield* refuse(SYSTEM_FOLDER_MESSAGE);

  const real = yield* Files.realPath(library.path);

  if (isSystemFolder(real)) return yield* refuse(SYSTEM_FOLDER_MESSAGE);

  if (musicRoots !== null) {
    // The allowed roots resolve too, so a root that is itself a link still allows its target.
    const roots = yield* Effect.forEach(musicRoots, (root) =>
      Files.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );

    if (!roots.some((root) => real === root || NodeFiles.isWithin(root, real))) {
      return yield* refuse(
        `Library folders must be inside ${musicRoots.join(" or ")} (MUSIC_ROOTS)`,
      );
    }
  }

  const host = given ?? (yield* readHost);
  const rootIds = yield* Files.folderIds(real);
  const fsPath = host.mounts === null ? null : fsPathOf(host.mounts, real);
  const claim = yield* backend.claimRoot(library.id, real, rootIds, fsPath, host.bootId);

  if (!claim.ok) return yield* new RootRefused({ libraryId: library.id, reason: claim.error });

  return real;
});

/** Libraries claimed at once, side by side, when many need it (after an upgrade, say). */
const CLAIM_CONCURRENCY = 4;

/** Backoff for a claim that failed but wasn't refused: from half a second, capped at a minute. */
const RETRY_SCHEDULE = cappedBackoff("500 millis", "1 minute");

/** A claim still failing is a warning on its first failure and every this many after. */
const WARN_EVERY = 10;

const claimKey = (library: LibraryFolder): string => `${library.id}:${library.path}`;

/**
 * Claims every library without a claim as soon as it appears, ahead of the scan queue: libraries
 * from before claims (after an upgrade), new ones, and ones whose claim was dropped. A claim takes
 * a `stat` per folder level, so every library streams again within seconds rather than waiting
 * for its full scan, which still claims again first. A claim that fails for another reason (the
 * folder not there yet, Convex unreachable) is retried with backoff; once a folder's claim
 * succeeds or is refused, this process leaves it to the library's scans, which claim again.
 */
export const layer: Layer.Layer<never, never, MediaBackend | MediaConfig> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend;
    const config = yield* MediaConfig;
    // Folders whose claim succeeded or was refused; only those are not tried again.
    const settled = yield* Ref.make<ReadonlySet<string>>(new Set());
    const claims = yield* FiberMap.make<string>();
    const listed = yield* Ref.make<ReadonlySet<string>>(new Set());
    const permits = yield* Semaphore.make(CLAIM_CONCURRENCY);

    // Folder identities from another boot mean nothing now; a library claimed in one is
    // claimed again, which refreshes them.
    const bootId = yield* Files.readBootId;

    // A claim that failed for another reason (the folder not mounted yet, Convex unreachable)
    // is tried again with backoff until it succeeds or is refused.
    const claimOnce = (library: LibraryFolder, host: Host) =>
      Effect.gen(function* () {
        const failures = yield* Ref.make(0);

        const warn = (error: Error) =>
          Ref.updateAndGet(failures, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 1 || count % WARN_EVERY === 0
                ? Effect.logWarning("RootClaim.retrying", { libraryId: library.id, count, error })
                : Effect.logDebug("RootClaim.retrying", { libraryId: library.id, count, error }),
            ),
          );

        yield* permits
          .withPermits(1)(claimRoot(library, host))
          .pipe(
            Effect.tapError((error) => (error instanceof RootRefused ? Effect.void : warn(error))),
            Effect.retry({
              schedule: RETRY_SCHEDULE,
              while: (error) => !(error instanceof RootRefused),
            }),
            Effect.tap(() => Effect.logInfo("RootClaim.claimed", { libraryId: library.id })),
            Effect.catch((error) =>
              Effect.logWarning("RootClaim.not_claimed", { libraryId: library.id, error }),
            ),
          );

        yield* Ref.update(settled, (keys) => new Set([...keys, claimKey(library)]));
      }).pipe(
        Effect.provideService(MediaBackend, backend),
        Effect.provideService(MediaConfig, config),
      );

    /** Whether a library needs a claim: none yet, or one whose identities are from another boot. */
    const unclaimed = (library: LibraryFolder): boolean =>
      !library.claimed || library.bootId !== bootId;

    const claimNew = Effect.fn("RootClaim.claimNew")(function* (
      libraries: ReadonlyArray<LibraryFolder>,
    ) {
      const done = yield* Ref.get(settled);
      const wanted = new Map(libraries.map((library) => [claimKey(library), library]));

      // A library removed, or moved to another folder, stops its claim in flight.
      const previous = yield* Ref.getAndSet(listed, new Set(wanted.keys()));

      yield* Effect.forEach(
        [...previous].filter((key) => !wanted.has(key)),
        (key) => FiberMap.remove(claims, key),
        { discard: true },
      );

      const fresh = libraries.filter(
        (library) => unclaimed(library) && !done.has(claimKey(library)),
      );

      if (fresh.length === 0) return;

      // One read of the mount table for the whole batch.
      const host: Host = { mounts: yield* Files.readMounts, bootId };

      yield* Effect.forEach(
        fresh,
        (library) =>
          FiberMap.run(claims, claimKey(library), claimOnce(library, host), {
            onlyIfMissing: true,
          }),
        { discard: true },
      );
    });

    yield* backend.libraries.pipe(
      Stream.runForEach(claimNew),
      Effect.tapError((error) => Effect.logWarning("RootClaim.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
      Effect.forkScoped,
    );
  }),
);
