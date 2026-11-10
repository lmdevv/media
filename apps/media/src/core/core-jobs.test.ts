import { NodeServices } from "@effect/platform-node";
import { JobId, PersonId } from "@media/contracts/ids";
import { ContentDomain, serverFunctions } from "@media/contracts/server-functions";
import type { CoreJobPayload, Lease } from "@media/contracts/server-functions";
import { EpochMillis } from "@media/contracts/units";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import { JobFailed } from "./core-jobs.ts";
import { makeFakeCore, reply, stream } from "../testing/fake-core.ts";
import * as CoreJobs from "./core-jobs.ts";

const lease = (n: number): Lease => ({ jobId: JobId.make(`job${String(n)}`), attempt: 1 });

const work = { mode: "reported", done: 0, total: null } as const;

type Finish = typeof serverFunctions.jobsFinish.args.Type;

type Claim = typeof serverFunctions.jobsClaim.result.Type;

interface Queued {
  readonly payload: CoreJobPayload;
  readonly n: number;
}

/**
 * A core with a queue of jobs to claim, the domains that have libraries, and the finishes it
 * recorded. Each claim takes the oldest queued job of the asked kinds.
 */
const setUp = (
  queued: ReadonlyArray<CoreJobPayload>,
  withLibraries: ReadonlyArray<ContentDomain>,
) =>
  Effect.gen(function* () {
    const queue = yield* Ref.make<ReadonlyArray<Queued>>(
      queued.map((payload, index) => ({ payload, n: index })),
    );

    const finished = yield* Ref.make<ReadonlyArray<Finish>>([]);
    const domains = yield* SubscriptionRef.make(withLibraries);

    const fake = yield* makeFakeCore([
      reply(serverFunctions.jobsClaim, ({ kinds }) =>
        Ref.modify(queue, (jobs): readonly [Claim, ReadonlyArray<Queued>] => {
          const next = jobs.find((job) => kinds.includes(job.payload.kind));

          return next === undefined
            ? [{ outcome: "idle" as const }, jobs]
            : [
                {
                  outcome: "claimed" as const,
                  lease: lease(next.n),
                  leaseExpiresAt: EpochMillis.make(60_000),
                  payload: next.payload,
                  work,
                },
                jobs.filter((job) => job !== next),
              ];
        }),
      ),
      reply(serverFunctions.jobsReport, () =>
        Effect.succeed({
          outcome: "held" as const,
          leaseExpiresAt: EpochMillis.make(60_000),
          work,
        }),
      ),
      reply(serverFunctions.jobsFinish, (args) =>
        Ref.update(finished, (seen) => [...seen, args]).pipe(
          Effect.as({ outcome: "settled" as const, status: "succeeded" as const }),
        ),
      ),
      stream(serverFunctions.scanDomains, () =>
        SubscriptionRef.changes(domains).pipe(
          Stream.map((held) =>
            ContentDomain.literals.map((kind) => ({ kind, hasLibraries: held.includes(kind) })),
          ),
        ),
      ),
      stream(serverFunctions.jobsWaiting, ({ kinds }) =>
        Stream.make(kinds.map((kind) => ({ kind, free: 2, ready: true }))).pipe(
          Stream.concat(Stream.never),
        ),
      ),
    ]);

    return { fake, finished, domains };
  });

const person = (personId: string): CoreJobPayload => ({
  kind: "movies.person",
  personId: PersonId.make(personId),
  revision: 1,
});

/** Lets forked work run: a few clock steps, each of which runs whatever became ready. */
const settle = Effect.forEach([1, 2, 3, 4, 5], () => TestClock.adjust("200 millis"), {
  discard: true,
});

const caps: CoreJobs.PoolCaps = {
  movies: 1,
  "movies.background": 1,
  "movies.import": 1,
  server: 1,
};

describe("CoreJobs", () => {
  it.effect("runs the movies pool only while the movies domain has a library", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<ReadonlyArray<string>>([]);

      const { fake, finished, domains } = yield* setUp(
        [person("p1"), { kind: "server.backup", trigger: "manual" }],
        [],
      );

      const record = (kind: "movies.person" | "server.backup") =>
        CoreJobs.handler({
          kind,
          run: () => Ref.update(ran, (seen) => [...seen, kind]).pipe(Effect.as(`ran ${kind}`)),
        });

      yield* Layer.build(
        CoreJobs.layer(
          Effect.succeed({ handlers: [record("movies.person"), record("server.backup")], caps }),
        ).pipe(Layer.provide([fake.layer, NodeServices.layer])),
      );

      yield* settle;
      assert.deepStrictEqual(yield* Ref.get(ran), ["server.backup"]);

      yield* SubscriptionRef.set(domains, ["movies"]);
      yield* settle;
      assert.deepStrictEqual(yield* Ref.get(ran), ["server.backup", "movies.person"]);

      const ends = (yield* Ref.get(finished)).map((args) => args.end.outcome);

      assert.deepStrictEqual(ends, ["succeeded", "succeeded"]);
    }).pipe(Effect.scoped),
  );

  it.effect("runs no more of a pool's jobs at once than its cap", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const running = yield* Ref.make(0);
      const most = yield* Ref.make(0);
      const { fake } = yield* setUp([person("p1"), person("p2"), person("p3")], ["movies"]);

      const slow = CoreJobs.handler({
        kind: "movies.person",
        run: () =>
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(running, (count) => count + 1);

            yield* Ref.update(most, (seen) => Math.max(seen, now));
            yield* Deferred.await(release);
            yield* Ref.update(running, (count) => count - 1);

            return "done";
          }),
      });

      yield* Layer.build(
        CoreJobs.layer(Effect.succeed({ handlers: [slow], caps: { ...caps, movies: 2 } })).pipe(
          Layer.provide([fake.layer, NodeServices.layer]),
        ),
      );

      yield* settle;
      assert.strictEqual(yield* Ref.get(running), 2);

      yield* Deferred.succeed(release, undefined);
      yield* settle;
      assert.strictEqual(yield* Ref.get(most), 2);
      assert.strictEqual(yield* Ref.get(running), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("records a failure with its retry, and settles nothing for a stopped job", () =>
    Effect.gen(function* () {
      const { fake, finished } = yield* setUp([person("p1"), person("p2")], ["movies"]);

      const outcomes = CoreJobs.handler({
        kind: "movies.person",
        run: (job) =>
          job.payload.personId === "p1"
            ? Effect.fail(new JobFailed({ message: "provider down", retry: true }))
            : Effect.fail(new CoreJobs.JobStopped({ outcome: "canceled" })),
      });

      yield* Layer.build(
        CoreJobs.layer(Effect.succeed({ handlers: [outcomes], caps })).pipe(
          Layer.provide([fake.layer, NodeServices.layer]),
        ),
      );

      yield* settle;

      assert.deepStrictEqual(yield* Ref.get(finished), [
        { lease: lease(0), end: { outcome: "failed", error: "provider down", retry: true } },
      ]);
    }).pipe(Effect.scoped),
  );
});
