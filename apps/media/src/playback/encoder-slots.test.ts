import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Predicate, Random, Result, Scope } from "effect";
import { TestClock } from "effect/testing";

import { PlaybackSessionId } from "@media/contracts/ids";
import { TranscodeCapacityReached } from "@media/contracts/media-playback";

import * as EncoderSlots from "./encoder-slots.ts";

const claimant = (
  name: string,
  ticket: number,
  options: { readonly session?: string } = {},
): EncoderSlots.Claimant => ({
  sessionId: PlaybackSessionId.make(options.session ?? name),
  ticket,
});

const SCHEDULER_TURNS = 5;

const stillRunning = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < SCHEDULER_TURNS; turn += 1) yield* Effect.yieldNow;

    return fiber.pollUnsafe() === undefined;
  });

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

const isClosed = (scope: Scope.Scope) => Predicate.isTagged(scope.state, "Closed");

describe("encoder slots", () => {
  it.effect("a guest waits while the limit is reached, and starts when a slot frees", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const household = yield* Scope.make();
      yield* pool.household(household, claimant("household", 1));

      const guest = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("guest", 2)));

      assert.isTrue(yield* stillRunning(guest), "the guest waits");

      yield* close(household);
      const held = yield* Fiber.join(guest);

      assert.isFalse(
        yield* stillRunning(yield* Effect.forkChild(held.ready)),
        "nothing to wait for",
      );
    }),
  );

  it.effect("a household stream takes the newest guest's slot when guests fill the limit", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(2);
      const olderScope = yield* Scope.make();
      const newerScope = yield* Scope.make();
      const older = yield* pool.guest(olderScope, claimant("older", 1));
      yield* older.ready;
      const newer = yield* pool.guest(newerScope, claimant("newer", 2));
      yield* newer.ready;

      const held = yield* pool.household(yield* Scope.make(), claimant("household", 3));
      const newerDisplaced = yield* Effect.forkChild(newer.displaced);
      const olderDisplaced = yield* Effect.forkChild(older.displaced);
      const ready = yield* Effect.forkChild(held.ready);

      assert.isFalse(yield* stillRunning(newerDisplaced), "the newest guest yields");
      assert.isTrue(yield* stillRunning(olderDisplaced), "the older guest keeps its slot");
      assert.isTrue(yield* stillRunning(ready), "no encoder starts while the guest's runs");

      yield* close(newerScope);
      yield* Fiber.join(ready);
    }),
  );

  it.effect("a household stream takes a running guest's slot before a starting one's", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(2);
      const running = yield* pool.guest(yield* Scope.make(), claimant("running", 1));
      yield* running.ready;
      const starting = yield* pool.guest(yield* Scope.make(), claimant("starting", 2));

      yield* pool.household(yield* Scope.make(), claimant("household", 3));

      assert.isFalse(yield* stillRunning(yield* Effect.forkChild(running.displaced)));
      assert.isTrue(yield* stillRunning(yield* Effect.forkChild(starting.displaced)));
    }),
  );

  it.effect(
    "a taken slot is taken once, and a waiting guest starts only once the household's frees",
    () =>
      Effect.gen(function* () {
        const pool = yield* EncoderSlots.make(1);
        const guestScope = yield* Scope.make();
        yield* (yield* pool.guest(guestScope, claimant("guest", 1))).ready;
        const household = yield* Scope.make();
        yield* pool.household(household, claimant("household", 2));

        assert.isTrue(
          yield* Effect.isFailure(pool.household(yield* Scope.make(), claimant("second", 3))),
          "a displaced guest's slot is not taken twice",
        );

        const waiting = yield* Effect.forkChild(
          pool.guest(yield* Scope.make(), claimant("next", 4)),
        );

        yield* stillRunning(waiting);
        yield* close(guestScope);

        assert.isTrue(yield* stillRunning(waiting), "the household stream holds the only slot");

        yield* close(household);
        yield* Fiber.join(waiting);
      }),
  );

  it.effect(
    "a household stream takes a renegotiated guest's slot, and starts once the older one stops",
    () =>
      Effect.gen(function* () {
        const pool = yield* EncoderSlots.make(1);
        const oldScope = yield* Scope.make();
        const old = yield* pool.guest(oldScope, claimant("old", 1, { session: "guest" }));
        yield* old.ready;

        const renegotiated = yield* pool.guest(
          yield* Scope.make(),
          claimant("new", 2, { session: "guest" }),
        );

        const held = yield* pool.household(yield* Scope.make(), claimant("household", 3));
        const ready = yield* Effect.forkChild(held.ready);

        assert.isTrue(yield* renegotiated.isDisplaced, "the stream that took over the slot yields");
        assert.isTrue(yield* stillRunning(ready), "the session's older encoder still runs");

        yield* close(oldScope);
        yield* Fiber.join(ready);

        assert.isFalse(
          yield* stillRunning(yield* Effect.forkChild(renegotiated.ready)),
          "a displaced stream that never ran starts nothing and does not wait",
        );
      }),
  );

  it.effect("a second household stream takes another guest's slot while the first yields", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(2);
      const older = yield* pool.guest(yield* Scope.make(), claimant("older", 1));
      const newer = yield* pool.guest(yield* Scope.make(), claimant("newer", 2));
      yield* pool.household(yield* Scope.make(), claimant("first", 3));

      assert.isTrue(yield* newer.isDisplaced);
      assert.isFalse(yield* older.isDisplaced);

      yield* pool.household(yield* Scope.make(), claimant("second", 4));

      assert.isTrue(yield* older.isDisplaced, "the second household stream is not refused");
    }),
  );

  it.effect("a taken slot counts against everyone else until its guest's encoder stops", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const guestScope = yield* Scope.make();
      yield* (yield* pool.guest(guestScope, claimant("guest", 1))).ready;
      const household = yield* Scope.make();
      yield* pool.household(household, claimant("household", 2));
      yield* close(household);

      const second = yield* pool.household(yield* Scope.make(), claimant("second", 3));
      const ready = yield* Effect.forkChild(second.ready);

      assert.isTrue(yield* stillRunning(ready), "the displaced guest's encoder may still run");

      const waiting = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("next", 4)));

      assert.isTrue(yield* stillRunning(waiting), "a waiting guest is not seated over it");

      yield* close(guestScope);
      yield* Fiber.join(ready);

      assert.isTrue(yield* stillRunning(waiting), "the second household stream holds the slot");
    }),
  );

  it.effect(
    "a guest credited its session's slot is seated ahead of an older guest that waits",
    () =>
      Effect.gen(function* () {
        const pool = yield* EncoderSlots.make(1);
        yield* pool.guest(yield* Scope.make(), claimant("first", 5, { session: "a" }));

        const older = yield* Effect.forkChild(
          pool.guest(yield* Scope.make(), claimant("older", 3, { session: "b" })),
        );

        assert.isTrue(yield* stillRunning(older));

        yield* pool.guest(yield* Scope.make(), claimant("renegotiated", 6, { session: "a" }));

        assert.isTrue(yield* stillRunning(older), "the older guest still waits for a slot");
      }),
  );

  it.effect("household streams that fill the limit refuse another and leave guests waiting", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const first = yield* Scope.make();
      yield* pool.household(first, claimant("first", 1));

      assert.isTrue(
        yield* Effect.isFailure(pool.household(yield* Scope.make(), claimant("second", 2))),
      );

      const guest = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("guest", 3)));

      assert.isTrue(yield* stillRunning(guest));

      yield* close(first);
      yield* Fiber.join(guest);
    }),
  );

  it.effect("serves waiting guests lowest ticket first, whatever order they arrived in", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const household = yield* Scope.make();
      yield* pool.household(household, claimant("household", 1));

      const newer = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("newer", 5)));
      yield* stillRunning(newer);
      const olderScope = yield* Scope.make();
      const older = yield* Effect.forkChild(pool.guest(olderScope, claimant("older", 3)));
      yield* stillRunning(older);

      yield* close(household);
      yield* Fiber.join(older);

      assert.isTrue(yield* stillRunning(newer), "the newer guest waits behind the older one");

      yield* close(olderScope);
      yield* Fiber.join(newer);
    }),
  );

  it.effect("an interrupted wait leaves the line", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const household = yield* Scope.make();
      yield* pool.household(household, claimant("household", 1));

      const first = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("first", 2)));
      yield* stillRunning(first);

      const second = yield* Effect.forkChild(
        pool.guest(yield* Scope.make(), claimant("second", 3)),
      );

      yield* stillRunning(second);

      yield* Fiber.interrupt(first);
      yield* close(household);
      yield* Fiber.join(second);
    }),
  );

  it.effect("credits a newer stream of a session with its older streams' slots", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const olderScope = yield* Scope.make();
      yield* (yield* pool.household(olderScope, claimant("older", 1, { session: "session" })))
        .ready;

      const newer = yield* pool.household(
        yield* Scope.make(),
        claimant("newer", 2, { session: "session" }),
      );

      assert.isTrue(
        yield* Effect.isFailure(pool.household(yield* Scope.make(), claimant("other", 3))),
        "the newer stream's slot counts against another session",
      );

      const ready = yield* Effect.forkChild(newer.ready);

      assert.isTrue(yield* stillRunning(ready), "its encoder waits for the older one's");

      yield* close(olderScope);
      yield* Fiber.join(ready);
    }),
  );

  it.effect(
    "a stream that replaces a household stream before its taken guest stops waits for the guest",
    () =>
      Effect.gen(function* () {
        const pool = yield* EncoderSlots.make(1);
        const guestScope = yield* Scope.make();
        const guest = yield* pool.guest(guestScope, claimant("guest", 1));
        yield* guest.ready;

        const firstScope = yield* Scope.make();
        yield* pool.household(firstScope, claimant("first", 2, { session: "household" }));

        const replacement = yield* pool.household(
          yield* Scope.make(),
          claimant("replacement", 3, { session: "household" }),
        );

        const ready = yield* Effect.forkChild(replacement.ready);
        yield* close(firstScope);

        assert.isTrue(yield* stillRunning(ready), "the taken guest's encoder may still run");

        yield* close(guestScope);
        yield* Fiber.join(ready);
      }),
  );

  it.effect("a household stream is not refused while a replaced stream's taken guest stops", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(2);
      const kept = yield* pool.guest(yield* Scope.make(), claimant("kept", 1));
      yield* kept.ready;
      const taken = yield* pool.guest(yield* Scope.make(), claimant("taken", 2));
      yield* taken.ready;
      const firstScope = yield* Scope.make();
      yield* pool.household(firstScope, claimant("first", 3, { session: "household" }));

      yield* pool.household(
        yield* Scope.make(),
        claimant("replacement", 4, { session: "household" }),
      );

      yield* close(firstScope);
      yield* pool.household(yield* Scope.make(), claimant("other", 5));

      assert.isTrue(yield* kept.isDisplaced, "the other household stream takes the guest left");
    }),
  );

  it.effect(
    "never runs more encoders than the limit, whatever streams start, yield or stop",
    () =>
      Effect.gen(function* () {
        for (const limit of [1, 2, 3]) {
          for (let seed = 0; seed < SEEDS; seed += 1) {
            const run = yield* simulate(limit).pipe(Random.withSeed(seed));
            const label = `limit ${String(limit)}, seed ${String(seed)}`;

            assert.isAtMost(run.peak, limit, `${label}: running encoders`);
            assert.strictEqual(
              run.stuck,
              0,
              `${label}: streams still waiting after everything stopped`,
            );
            assert.isTrue(run.freed, `${label}: every slot is free again`);
          }
        }
      }),
    60_000,
  );
});

const SEEDS = 100;

const STEPS = 60;

const GUEST_START_WAIT = Duration.seconds(20);

const GUEST_RESUME_WAIT = Duration.seconds(30);

type Status = "starting" | "running" | "released" | "ended";

interface Stream {
  readonly claimant: EncoderSlots.Claimant;
  readonly audience: EncoderSlots.Audience;
  status: Status;
  lease: Scope.Closeable | undefined;
}

const simulate = (limit: number) =>
  Effect.gen(function* () {
    const pool = yield* EncoderSlots.make(limit);
    const encoders = { live: 0, peak: 0 };
    const streams: Array<Stream> = [];
    const latest = new Map<string, number>();
    const actors: Array<Fiber.Fiber<void>> = [];
    let tickets = 0;

    const end = (stream: Stream) =>
      Effect.suspend(() => {
        stream.status = "ended";

        return stream.lease === undefined ? Effect.void : close(stream.lease);
      });

    const claim = (
      stream: Stream,
      lease: Scope.Scope,
      resume: boolean,
    ): Effect.Effect<EncoderSlots.Held, TranscodeCapacityReached> =>
      stream.audience === "household"
        ? pool.household(lease, stream.claimant)
        : pool.guest(lease, stream.claimant).pipe(
            Effect.timeoutOrElse({
              duration: resume ? GUEST_RESUME_WAIT : GUEST_START_WAIT,
              orElse: () => Effect.fail(new TranscodeCapacityReached({ limit })),
            }),
          );

    const occupy = (stream: Stream, resume: boolean) =>
      Effect.gen(function* () {
        const lease = yield* Scope.make();
        stream.lease = lease;
        const { sessionId, ticket } = stream.claimant;
        const claimed = yield* claim(stream, lease, resume).pipe(Effect.result);

        if (Result.isFailure(claimed)) {
          yield* close(lease);

          if (!resume) stream.status = "ended";

          return;
        }

        const held = claimed.success;
        const started = { value: false };
        const stopsAfter = Duration.millis(yield* Random.nextIntBetween(0, 1000));

        yield* Scope.addFinalizer(
          lease,
          Effect.suspend(() =>
            started.value
              ? Effect.sleep(stopsAfter).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      encoders.live -= 1;
                    }),
                  ),
                )
              : Effect.void,
          ),
        );

        if (!resume) {
          if (stream.status === "ended" || latest.get(sessionId) !== ticket) {
            yield* end(stream);

            return;
          }

          yield* Effect.forEach(
            streams.filter(
              (other) =>
                other !== stream &&
                other.claimant.sessionId === sessionId &&
                other.status !== "ended",
            ),
            end,
            { discard: true },
          );
        }

        yield* held.ready;
        const displaced = yield* held.isDisplaced;

        const running = yield* Effect.sync(() => {
          if (displaced || isClosed(lease)) return false;
          started.value = true;
          encoders.live += 1;
          encoders.peak = Math.max(encoders.peak, encoders.live);
          stream.status = "running";

          return true;
        });

        if (!running) {
          if (resume) {
            yield* close(lease);
          } else {
            yield* end(stream);
          }

          return;
        }

        const yieldsAfter = Duration.millis(yield* Random.nextIntBetween(0, 3000));

        yield* held.displaced.pipe(
          Effect.andThen(Effect.sleep(yieldsAfter)),
          Effect.andThen(
            Effect.sync(() => {
              if (stream.status === "running") stream.status = "released";
            }),
          ),
          Effect.andThen(close(lease)),
          Effect.forkIn(lease),
        );
      });

    const begin = (sessionId: string, audience: EncoderSlots.Audience) =>
      Effect.gen(function* () {
        tickets += 1;
        latest.set(sessionId, tickets);

        const stream: Stream = {
          claimant: claimant(`s${String(tickets)}`, tickets, { session: sessionId }),
          audience,
          status: "starting",
          lease: undefined,
        };

        streams.push(stream);
        actors.push(yield* Effect.forkChild(occupy(stream, false)));
      });

    const some = (status: Status) =>
      Effect.gen(function* () {
        const found = streams.filter((stream) => stream.status === status);

        return found.length === 0
          ? undefined
          : found[yield* Random.nextIntBetween(0, found.length, { halfOpen: true })];
      });

    for (let step = 0; step < STEPS; step += 1) {
      const move = yield* Random.nextIntBetween(0, 6, { halfOpen: true });

      if (move <= 1) {
        yield* begin(`p${String(step)}`, move === 0 ? "household" : "guest");
      } else if (move === 2) {
        const current = (yield* some("running")) ?? (yield* some("starting"));

        if (current !== undefined) yield* begin(current.claimant.sessionId, current.audience);
      } else if (move === 3) {
        const current = yield* some("running");

        if (current !== undefined && current.lease !== undefined) {
          current.status = "released";
          yield* Effect.forkChild(close(current.lease));
        }
      } else if (move === 4) {
        const current = yield* some("released");

        if (current !== undefined) {
          current.status = "starting";
          actors.push(yield* Effect.forkChild(occupy(current, true)));
        }
      } else {
        const current = (yield* some("running")) ?? (yield* some("released"));

        if (current !== undefined) yield* Effect.forkChild(end(current));
      }

      yield* TestClock.adjust(Duration.millis(yield* Random.nextIntBetween(0, 400)));
    }

    yield* Effect.forEach(streams, (stream) => Effect.forkChild(end(stream)), { discard: true });

    for (let settle = 0; settle < 10; settle += 1) {
      yield* TestClock.adjust(Duration.seconds(10));
    }

    const stuck = actors.filter((actor) => actor.pollUnsafe() === undefined).length;
    const afterwards = yield* Scope.make();

    const waiting = yield* Effect.forEach(
      Array.from({ length: limit }, (_, index) => index),
      (index) =>
        pool.household(afterwards, claimant(`after${String(index)}`, tickets + 1 + index)).pipe(
          Effect.flatMap((held) => Effect.forkChild(held.ready)),
          Effect.flatMap(stillRunning),
          Effect.orElseSucceed(() => true),
        ),
    );

    yield* close(afterwards);

    return { peak: encoders.peak, stuck, freed: waiting.every((still) => !still) };
  });
