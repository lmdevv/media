import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope } from "effect";

import { PlaybackSessionId } from "@media/contracts/ids";
import { StreamId } from "@media/contracts/media-playback";

import * as EncoderSlots from "./encoder-slots.ts";

const claimant = (
  name: string,
  ticket: number,
  options: { readonly session?: string; readonly registered?: boolean } = {},
): EncoderSlots.Claimant => ({
  streamId: StreamId.make(name.padEnd(22, "0")),
  sessionId: PlaybackSessionId.make(options.session ?? name),
  ticket,
  registered: options.registered ?? true,
});

const SCHEDULER_TURNS = 5;

const stillRunning = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < SCHEDULER_TURNS; turn += 1) yield* Effect.yieldNow;

    return fiber.pollUnsafe() === undefined;
  });

const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

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
      const newer = yield* pool.guest(newerScope, claimant("newer", 2));

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

      const starting = yield* pool.guest(
        yield* Scope.make(),
        claimant("starting", 2, { registered: false }),
      );

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
        yield* pool.guest(guestScope, claimant("guest", 1));
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

  it.effect("a household stream takes every guest slot it needs, a session's older one too", () =>
    Effect.gen(function* () {
      const pool = yield* EncoderSlots.make(1);
      const oldScope = yield* Scope.make();
      const newScope = yield* Scope.make();
      const old = yield* pool.guest(oldScope, claimant("old", 1, { session: "guest" }));

      const renegotiated = yield* pool.guest(
        newScope,
        claimant("new", 2, { session: "guest", registered: false }),
      );

      const held = yield* pool.household(yield* Scope.make(), claimant("household", 3));
      const ready = yield* Effect.forkChild(held.ready);

      assert.isTrue(yield* old.isDisplaced, "the session's older stream yields");
      assert.isTrue(yield* renegotiated.isDisplaced, "the stream credited its slot yields too");

      yield* close(oldScope);
      assert.isTrue(yield* stillRunning(ready), "the renegotiated stream's slot is still held");

      yield* close(newScope);
      yield* Fiber.join(ready);
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
      yield* pool.guest(guestScope, claimant("guest", 1));
      const household = yield* Scope.make();
      yield* pool.household(household, claimant("household", 2));
      yield* close(household);

      assert.isTrue(
        yield* Effect.isFailure(pool.household(yield* Scope.make(), claimant("second", 3))),
        "the displaced guest's encoder may still run",
      );

      const waiting = yield* Effect.forkChild(pool.guest(yield* Scope.make(), claimant("next", 4)));

      assert.isTrue(yield* stillRunning(waiting), "a waiting guest is not seated over it");

      yield* close(guestScope);
      yield* Fiber.join(waiting);
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
      yield* pool.household(olderScope, claimant("older", 1, { session: "session" }));

      const newer = yield* pool.household(
        yield* Scope.make(),
        claimant("newer", 2, { session: "session", registered: false }),
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
});
