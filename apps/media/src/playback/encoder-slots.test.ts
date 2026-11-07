import { assert, describe, it } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Fiber, Predicate, Random, Result, Scope } from "effect";
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
  it.effect("a stream's next encoder takes its place and starts once the current one stopped", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const current = yield* Scope.make();
      const held = yield* pool.household(current, claimant("household", 1));
      yield* held.ready;

      const renewed = yield* held.renew(yield* Scope.make());
      const starting = yield* Effect.forkChild(renewed.ready);

      assert.isTrue(yield* stillRunning(starting), "the next encoder waits for the current one");

      const refused = yield* pool
        .household(yield* Scope.make(), claimant("other", 2))
        .pipe(Effect.result);

      assert.isTrue(Result.isFailure(refused), "the stream keeps its place");

      yield* close(current);
      yield* Fiber.join(starting);

      assert.isFalse(yield* renewed.isLost);
    }),
  );

  it.effect("a guest's next encoder gives up at once when a household stream took its place", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const guest = yield* Scope.make();
      const held = yield* pool.guest(guest, claimant("guest", 1));
      yield* held.ready;

      const household = yield* pool.household(yield* Scope.make(), claimant("household", 2));
      const renewed = yield* held.renew(yield* Scope.make());

      yield* renewed.ready;
      assert.isTrue(yield* renewed.isLost, "the next encoder gives up");

      const starting = yield* Effect.forkChild(household.ready);

      assert.isTrue(yield* stillRunning(starting), "the household waits for the guest's encoder");

      yield* close(guest);
      yield* Fiber.join(starting);
    }),
  );

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

        assert.isTrue(yield* renegotiated.isLost, "the stream that took over the slot yields");
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

      assert.isTrue(yield* newer.isLost);
      assert.isFalse(yield* older.isLost);

      yield* pool.household(yield* Scope.make(), claimant("second", 4));

      assert.isTrue(yield* older.isLost, "the second household stream is not refused");
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

  it.effect("a guest whose scope closes while it waits starts no encoder", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      yield* pool.household(yield* Scope.make(), claimant("household", 1));
      const scope = yield* Scope.make();
      const waiting = yield* Effect.forkChild(pool.guest(scope, claimant("guest", 2)));

      yield* stillRunning(waiting);
      yield* close(scope);

      const held = yield* Fiber.join(waiting);

      yield* held.ready;
      assert.isTrue(yield* held.isLost, "the holder gives up");
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

      assert.isTrue(yield* kept.isLost, "the other household stream takes the guest left");
    }),
  );

  it.effect(
    "a guest's older slot passes to the household stream that displaced its renegotiation",
    () =>
      Effect.gen(function* () {
        const pool = yield* EncoderSlots.make(1);
        const oldScope = yield* Scope.make();
        const old = yield* pool.guest(oldScope, claimant("old", 1, { session: "guest" }));
        yield* old.ready;
        const renegotiatedScope = yield* Scope.make();
        yield* pool.guest(renegotiatedScope, claimant("new", 2, { session: "guest" }));
        const held = yield* pool.household(yield* Scope.make(), claimant("household", 3));
        const ready = yield* Effect.forkChild(held.ready);
        yield* close(renegotiatedScope);

        assert.isTrue(yield* old.isLost, "the renegotiation never replaced the older stream");
        assert.isTrue(yield* stillRunning(ready), "the older stream's encoder still runs");

        yield* close(oldScope);
        yield* Fiber.join(ready);
      }),
  );

  it.effect("a stream whose scope already closed takes no slot and starts no encoder", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const guest = yield* pool.guest(yield* Scope.make(), claimant("guest", 1));
      yield* guest.ready;
      const closed = yield* Scope.make();
      yield* close(closed);
      const household = yield* pool.household(closed, claimant("household", 2));

      assert.isFalse(yield* guest.isLost);
      assert.isTrue(yield* household.isLost, "the late household's holder gives up");

      const lateGuest = yield* pool.guest(closed, claimant("late guest", 3));

      assert.isTrue(yield* lateGuest.isLost, "the late guest's holder gives up");
    }),
  );

  it.effect(
    "never runs more encoders than the limit, whatever streams start, seek, yield or stop, even mid-step or on a stalled disk",
    () =>
      Effect.gen(function* () {
        let cut = 0;

        for (const limit of [1, 2, 3]) {
          for (let seed = 0; seed < SEEDS; seed += 1) {
            const run = yield* simulate(limit).pipe(Random.withSeed(seed));
            const label = `limit ${String(limit)}, seed ${String(seed)}`;

            cut += run.cut;

            assert.isAtMost(run.peak, limit, `${label}: running encoders`);
            assert.isAtMost(
              run.householdWait,
              HOUSEHOLD_WAIT_BOUND_MS,
              `${label}: a household stream's wait for the encoders whose places it took`,
            );
            assert.strictEqual(
              run.stuck,
              0,
              `${label}: streams still waiting after everything stopped`,
            );
            assert.isTrue(run.freed, `${label}: every slot is free again`);
          }
        }

        assert.isAbove(cut, 0, "stops that cut a start, seek or resume short");
      }),
    120_000,
  );
});

const SEEDS = 100;

const STEPS = 60;

const GUEST_START_WAIT = Duration.seconds(20);

const GUEST_RESUME_WAIT = Duration.seconds(30);

const YIELD_MAX_MS = 3000;

const STOP_MAX_MS = 1000;

const STALLED_STOP_MS = 20_000;

const STALLED_DISK_MS = 40_000;

const HOUSEHOLD_WAIT_BOUND_MS = YIELD_MAX_MS + STALLED_STOP_MS + 1000;

type Status = "starting" | "running" | "released" | "ended";

interface Stream {
  readonly claimant: EncoderSlots.Claimant;
  readonly audience: EncoderSlots.Audience;
  status: Status;
  run: Scope.Closeable | undefined;
  held: EncoderSlots.Held | undefined;
  readonly runs: Set<Scope.Closeable>;
  readonly transitions: Set<Fiber.Fiber<void>>;
  readonly stopping: Set<Scope.Closeable>;
}

const simulate = (limit: number) =>
  Effect.gen(function* () {
    const pool = yield* EncoderSlots.make(limit);
    const encoders = { live: 0, peak: 0 };
    const waits = { household: 0 };
    const streams: Array<Stream> = [];
    const latest = new Map<string, number>();
    const actors: Array<Fiber.Fiber<void>> = [];
    const cut = { transitions: 0 };
    let tickets = 0;

    const open = (stream: Stream) =>
      Scope.make().pipe(Effect.tap((run) => Effect.sync(() => stream.runs.add(run))));

    const transition = (stream: Stream, effect: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(effect);

        stream.transitions.add(fiber);
        actors.push(fiber);
        fiber.addObserver(() => stream.transitions.delete(fiber));
      });

    const beginStop = (stream: Stream, run: Scope.Closeable) =>
      Effect.suspend(() => {
        if (stream.stopping.has(run)) return Effect.void;
        stream.stopping.add(run);

        return Effect.forkDetach(close(run));
      }).pipe(Effect.uninterruptible);

    const end = (stream: Stream) =>
      Effect.gen(function* () {
        stream.status = "ended";
        const self = yield* Effect.fiber;

        for (const fiber of stream.transitions) {
          if (fiber === self) continue;
          cut.transitions += 1;
          yield* Fiber.interrupt(fiber);
        }

        yield* Effect.forEach(stream.runs, (run) => beginStop(stream, run), { discard: true });
      });

    const claim = (
      stream: Stream,
      run: Scope.Scope,
      resume: boolean,
    ): Effect.Effect<EncoderSlots.Held, TranscodeCapacityReached> =>
      stream.audience === "household"
        ? pool.household(run, stream.claimant)
        : pool.guest(run, stream.claimant).pipe(
            Effect.timeoutOrElse({
              duration: resume ? GUEST_RESUME_WAIT : GUEST_START_WAIT,
              orElse: () => Effect.fail(new TranscodeCapacityReached({ limit })),
            }),
          );

    const stopsLater = (run: Scope.Scope) =>
      Effect.gen(function* () {
        const started = { value: false };
        const stalled = (yield* Random.nextIntBetween(0, 8, { halfOpen: true })) === 0;

        const stopsAfter = Duration.millis(
          stalled ? STALLED_STOP_MS : yield* Random.nextIntBetween(0, STOP_MAX_MS),
        );

        yield* Scope.addFinalizer(
          run,
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

        return started;
      });

    const begin = (stream: Stream, run: Scope.Closeable, held: EncoderSlots.Held) =>
      Effect.gen(function* () {
        const started = yield* stopsLater(run);
        const since = yield* Clock.currentTimeMillis;

        yield* held.ready;

        if (stream.audience === "household") {
          waits.household = Math.max(waits.household, (yield* Clock.currentTimeMillis) - since);
        }

        const displaced = yield* held.isLost;

        const running = yield* Effect.sync(() => {
          if (displaced || isClosed(run)) return false;
          started.value = true;
          encoders.live += 1;
          encoders.peak = Math.max(encoders.peak, encoders.live);
          stream.status = "running";

          return true;
        });

        if (!running) return false;

        const yieldsAfter = Duration.millis(yield* Random.nextIntBetween(0, YIELD_MAX_MS));

        yield* held.displaced.pipe(
          Effect.andThen(Effect.sleep(yieldsAfter)),
          Effect.andThen(
            Effect.sync(() => {
              if (stream.run === run && stream.status === "running") stream.status = "released";
            }),
          ),
          Effect.andThen(close(run)),
          Effect.forkIn(run),
        );

        return true;
      });

    const occupy = (stream: Stream, resume: boolean) =>
      Effect.gen(function* () {
        const run = yield* open(stream);
        stream.run = run;
        const { sessionId, ticket } = stream.claimant;
        const claimed = yield* claim(stream, run, resume).pipe(Effect.result);

        if (Result.isFailure(claimed)) {
          yield* close(run);

          if (!resume) stream.status = "ended";

          return;
        }

        stream.held = claimed.success;

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

        if (yield* begin(stream, run, claimed.success)) return;

        if (resume) {
          yield* close(run);
        } else {
          yield* end(stream);
        }
      });

    const seek = (stream: Stream) =>
      Effect.gen(function* () {
        const previous = stream.run;
        const held = stream.held;

        if (previous === undefined || held === undefined) return;
        const run = yield* open(stream);
        const renewed = yield* held.renew(run);

        stream.status = "starting";

        if ((yield* Random.nextIntBetween(0, 8, { halfOpen: true })) === 0) {
          yield* Effect.sleep(Duration.millis(STALLED_DISK_MS));
        }

        yield* beginStop(stream, previous);

        if (yield* begin(stream, run, renewed)) {
          stream.run = run;
          stream.held = renewed;

          return;
        }

        yield* Effect.sync(() => {
          if (stream.run === previous && stream.status === "starting") stream.status = "released";
        });
        yield* close(run);
      });

    const negotiate = (sessionId: string, audience: EncoderSlots.Audience) =>
      Effect.gen(function* () {
        tickets += 1;
        latest.set(sessionId, tickets);

        const stream: Stream = {
          claimant: claimant(`s${String(tickets)}`, tickets, { session: sessionId }),
          audience,
          status: "starting",
          run: undefined,
          held: undefined,
          runs: new Set(),
          transitions: new Set(),
          stopping: new Set(),
        };

        streams.push(stream);
        yield* transition(stream, occupy(stream, false));
      });

    const some = (status: Status) =>
      Effect.gen(function* () {
        const found = streams.filter((stream) => stream.status === status);

        return found.length === 0
          ? undefined
          : found[yield* Random.nextIntBetween(0, found.length, { halfOpen: true })];
      });

    for (let step = 0; step < STEPS; step += 1) {
      const move = yield* Random.nextIntBetween(0, 7, { halfOpen: true });

      if (move <= 1) {
        yield* negotiate(`p${String(step)}`, move === 0 ? "household" : "guest");
      } else if (move === 2) {
        const current = (yield* some("running")) ?? (yield* some("starting"));

        if (current !== undefined) yield* negotiate(current.claimant.sessionId, current.audience);
      } else if (move === 3) {
        const current = yield* some("running");

        if (current !== undefined && current.run !== undefined) {
          current.status = "released";
          yield* Effect.forkChild(close(current.run));
        }
      } else if (move === 4) {
        const current = yield* some("released");

        if (current !== undefined) {
          current.status = "starting";
          yield* transition(current, occupy(current, true));
        }
      } else if (move === 5) {
        const current = yield* some("running");

        if (current !== undefined) {
          yield* transition(current, seek(current));

          if ((yield* Random.nextIntBetween(0, 3, { halfOpen: true })) === 0) {
            const turns = yield* Random.nextIntBetween(0, 12, { halfOpen: true });

            for (let turn = 0; turn < turns; turn += 1) yield* Effect.yieldNow;
            yield* Effect.forkChild(end(current));
          }
        }
      } else {
        const status = (["starting", "running", "released"] as const)[
          yield* Random.nextIntBetween(0, 3, { halfOpen: true })
        ];

        const current =
          (yield* some(status ?? "running")) ??
          (yield* some("running")) ??
          (yield* some("released"));

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

    return {
      peak: encoders.peak,
      householdWait: waits.household,
      stuck,
      freed: waiting.every((still) => !still),
      cut: cut.transitions,
    };
  });
