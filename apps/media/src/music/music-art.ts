/**
 * Music's artwork collection, as old music's job worker ran it (`art-collector.ts`): after each
 * scan, the artwork that scan's writes released and nothing uses any more; and a full collection
 * when the server starts and every hour after, for artwork a library's removal left behind. Scans
 * and both collections take turns in one lane, as old music's worker ran them (`turns`): a scan
 * reuses a stored artwork without writing it again, so a collection that found it unused must not
 * delete it while a scan stores a song that names it. Music runs one scan at a time (ADR 0014), so
 * a scan waits only for a collection under way, never for another scan, and never holds up a
 * transcode. Both collections also keep artwork written in the last ten minutes.
 */
import { serverFunctions } from "@media/contracts/server-functions";
import { Context, Duration, Effect, HashSet, Layer, Ref, Schedule, Semaphore } from "effect";

import * as CoreSession from "../core/core-session.ts";
import * as MediaConfig from "../media-config.ts";
import { type ArtCatalog, collectReleasedArt, collectUnusedArt } from "./art-collector.ts";

/** Music's artwork collection. */
export interface Interface {
  /** The artwork scans released and the collection has not deleted yet. */
  readonly released: Ref.Ref<HashSet.HashSet<string>>;
  /**
   * Runs `scan` in the art lane, once no collection runs, and keeps every collection out until it
   * ends: no artwork the scan reuses goes before the scan's writes name it.
   */
  readonly scanning: <A, E, R>(scan: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Starts deleting the released artwork nothing uses, keeping what is too new for a later try,
   * and returns at once: the collection waits for the art lane on a fiber of its own, so a scan's
   * end, a cancel, or a shutdown never waits for it. A failure is logged, and the hashes wait for
   * the next scan or full collection.
   */
  readonly collectReleased: Effect.Effect<void>;
}

/** Music's artwork collection. */
export class Service extends Context.Service<Service, Interface>()("@media/server/MusicArt") {}

/** How often the full collection runs after the first, at the server's start. */
const COLLECT_EVERY = Duration.hours(1);

/** A collection that takes longer gives up; what it missed waits for the next. */
const COLLECTION_TIMEOUT = Duration.minutes(5);

/**
 * Music's artwork collection for the art store under `dataDir`, asking `catalog` what is in use.
 * It runs the full collections on a fiber in the scope.
 */
export const make = Effect.fn("MusicArt.make")(function* <CatalogError>(
  dataDir: string,
  catalog: ArtCatalog<CatalogError>,
) {
  const released = yield* Ref.make(HashSet.empty<string>());
  const lane = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const inLane = <A, E>(collection: Effect.Effect<A, E>) =>
    lane.withPermits(1)(
      collection.pipe(
        Effect.timeoutOrElse({
          duration: COLLECTION_TIMEOUT,
          orElse: () => Effect.logWarning("MusicArt.collection_timed_out"),
        }),
        Effect.catch((error) => Effect.logWarning("MusicArt.collection_failed", error)),
        Effect.asVoid,
      ),
    );

  const collectReleased = inLane(
    Effect.gen(function* () {
      const hashes = yield* Ref.get(released);
      const waiting = yield* collectReleasedArt(dataDir, catalog, hashes);

      yield* Ref.update(released, (current) =>
        HashSet.union(HashSet.difference(current, hashes), HashSet.fromIterable(waiting)),
      );
    }),
  ).pipe(Effect.forkIn(scope), Effect.asVoid);

  // The first run waits out the server's sign-in to the core, retrying as it goes.
  const collectUnused = collectUnusedArt(dataDir, catalog).pipe(
    Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 6 }),
  );

  yield* inLane(collectUnused).pipe(
    Effect.repeat(Schedule.spaced(COLLECT_EVERY)),
    Effect.forkScoped,
  );

  return Service.of({ released, scanning: lane.withPermits(1), collectReleased });
});

/** Music's artwork collection over the core's `music/art` functions. */
export const layer: Layer.Layer<Service, never, CoreSession.Service | MediaConfig.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const session = yield* CoreSession.Service;
      const { dataDir } = yield* MediaConfig.Service;

      return yield* make(dataDir, {
        inUse: (hashes) =>
          session
            .call(serverFunctions.musicArtInUse, { hashes: [...hashes] })
            .pipe(Effect.map((answer) => answer.inUse)),
        hashes: (table, cursor) => session.call(serverFunctions.musicArtHashes, { table, cursor }),
      });
    }),
  );
