/**
 * Looks up lyrics on LRCLIB for the lookups Convex queues (`media:lyricQueue`), one at a time and
 * apart from scans. The worker keeps the latest queue Convex sent. It waits for its turn with
 * LRCLIB first and only then takes the most urgent lookup, so a lease is never spent waiting out
 * a pause and a song that started playing meanwhile goes first. It then asks LRCLIB and saves
 * what it learned under the lease. Convex drops a save whose lease ran out, and the lookup is
 * asked again, so a crash or a stall costs one more request at most.
 */
import { hostname } from "node:os";

import { Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect";

import { LrclibClient } from "./lrclib-client.ts";
import { LrclibLyrics } from "./lyrics/lrclib.ts";
import {
  type BackendError,
  type LookupAnswer,
  MediaBackend,
  type QueuedLookup,
  resubscribeSchedule,
} from "./media-backend.ts";

/** The wait before trying again after Convex failed `failures` times in a row: 1 s up to 30 s. */
const backendRetryMs = (failures: number): number => Math.min(1000 * 2 ** (failures - 1), 30_000);

const answerOf = (lyrics: Option.Option<LrclibLyrics>): LookupAnswer =>
  Option.match(lyrics, {
    onNone: (): LookupAnswer => ({ kind: "miss" }),
    onSome: LrclibLyrics.$match({
      Found: ({ recordId, sets }): LookupAnswer => ({ kind: "found", recordId, sets }),
      Instrumental: ({ recordId }): LookupAnswer => ({ kind: "instrumental", recordId }),
      Empty: (): LookupAnswer => ({ kind: "miss" }),
    }),
  });

const lookUp = Effect.fn("LyricsWorker.lookUp")(
  function* (lookup: QueuedLookup, workerId: string) {
    const backend = yield* MediaBackend;
    const lrclib = yield* LrclibClient;
    const claimed = yield* backend.claimLookup(lookup.lookupId, workerId);

    if (Option.isNone(claimed)) return;

    const answer = yield* lrclib.lookup(claimed.value.query).pipe(
      Effect.map(answerOf),
      Effect.catchTags({
        LrclibUnavailable: (error) =>
          Effect.logWarning("LyricsWorker.lrclib_unavailable", error).pipe(
            Effect.as<LookupAnswer>({ kind: "unavailable", pauseMs: error.pauseMs }),
          ),
        LrclibMalformed: (error) =>
          Effect.logWarning("LyricsWorker.lrclib_malformed", error).pipe(
            Effect.as<LookupAnswer>({ kind: "failed" }),
          ),
      }),
    );

    const saved = yield* backend.saveLookup(lookup.lookupId, workerId, answer);

    yield* saved
      ? Effect.logInfo("LyricsWorker.answered").pipe(Effect.annotateLogs({ answer: answer.kind }))
      : Effect.logWarning("LyricsWorker.lease_lost");
  },
  (effect, lookup) => effect.pipe(Effect.annotateLogs({ lookupId: lookup.lookupId })),
);

/**
 * Answers queued lookups for the lifetime of the layer. After each lookup it waits for Convex to
 * send a queue other than the one it took that lookup from. When Convex fails, it tries the same
 * queue again after a backoff, or sooner when a new queue arrives, so a failed claim or save never
 * leaves a lookup waiting on a change that will not come.
 */
export const layer: Layer.Layer<never, never, MediaBackend | LrclibClient> = Layer.effectDiscard(
  Effect.gen(function* () {
    const backend = yield* MediaBackend;
    const lrclib = yield* LrclibClient;
    const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    const latest = yield* SubscriptionRef.make<ReadonlyArray<QueuedLookup>>([]);
    // The queue the last lookup came from, or null to take one from the latest queue again.
    const taken = yield* Ref.make<ReadonlyArray<QueuedLookup> | null>(null);
    const failures = yield* Ref.make(0);

    const subscribe = backend.lyricQueue.pipe(
      Stream.runForEach((queue) => SubscriptionRef.set(latest, queue)),
      Effect.tapError((error) => Effect.logWarning("LyricsWorker.subscription_lost", error)),
      Effect.retry(resubscribeSchedule),
    );

    const nextQueue = SubscriptionRef.changes(latest).pipe(Stream.drop(1), Stream.runHead);

    const backOff = (error: BackendError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("LyricsWorker.backend_failed", error);
        const inARow = yield* Ref.updateAndGet(failures, (count) => count + 1);

        yield* Ref.set(taken, null);
        yield* Effect.raceFirst(Effect.sleep(backendRetryMs(inARow)), nextQueue);
      });

    const step = Effect.gen(function* () {
      const last = yield* Ref.get(taken);

      yield* SubscriptionRef.changes(latest).pipe(
        Stream.filter((queue) => queue !== last && queue.length > 0),
        Stream.runHead,
      );
      yield* lrclib.ready;

      const queue = yield* SubscriptionRef.get(latest);
      const [first] = queue;

      yield* Ref.set(taken, queue);

      if (first === undefined) return;

      yield* lookUp(first, workerId).pipe(
        Effect.andThen(Ref.set(failures, 0)),
        Effect.catchTag("BackendError", backOff),
      );
    });

    yield* subscribe.pipe(Effect.annotateLogs({ workerId }), Effect.forkScoped);
    yield* step.pipe(Effect.forever, Effect.annotateLogs({ workerId }), Effect.forkScoped);
    yield* Effect.logInfo("LyricsWorker.ready").pipe(Effect.annotateLogs({ workerId }));
  }),
);
