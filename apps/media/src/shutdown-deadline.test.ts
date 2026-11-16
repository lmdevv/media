import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, type Scope } from "effect";
import { TestClock } from "effect/testing";

import { withShutdownDeadline } from "./shutdown-deadline.ts";

const DEADLINE = Duration.seconds(5);

/** A service that runs until stopped, with one finalizer that takes `closing` to return. */
const service = (closing: Effect.Effect<void>) =>
  Effect.addFinalizer(() => closing).pipe(Effect.andThen(Effect.never));

/**
 * Starts `program` under the deadline and stops it, as SIGTERM does. Both run detached: a stop
 * whose finalizer hangs never returns, and nothing here may wait on it.
 */
const startAndStop = Effect.fnUntraced(function* (
  program: Effect.Effect<void, string, Scope.Scope>,
) {
  const overran = yield* Deferred.make<void>();

  const running = yield* program.pipe(
    withShutdownDeadline(DEADLINE, Deferred.succeed(overran, undefined).pipe(Effect.asVoid)),
    Effect.forkDetach,
  );

  yield* Effect.yieldNow;
  const stopped = yield* Fiber.interrupt(running).pipe(Effect.forkDetach);

  return { overran: Deferred.isDone(overran), stopped };
});

describe("the shutdown deadline", () => {
  it.effect("runs overran once a finalizer still hangs at the deadline", () =>
    Effect.gen(function* () {
      const { overran } = yield* startAndStop(service(Effect.never));

      yield* TestClock.adjust(Duration.subtract(DEADLINE, Duration.millis(1)));
      assert.isFalse(yield* overran);
      yield* TestClock.adjust(Duration.millis(1));
      assert.isTrue(yield* overran);
    }),
  );

  it.effect("never runs overran when every finalizer returns in time", () =>
    Effect.gen(function* () {
      const { overran, stopped } = yield* startAndStop(service(Effect.sleep(Duration.seconds(4))));

      yield* TestClock.adjust(Duration.seconds(4));
      yield* Fiber.join(stopped);
      yield* TestClock.adjust(Duration.minutes(1));
      assert.isFalse(yield* overran);
    }),
  );

  it.effect("bounds the closing after a failure too, as at a failed start", () =>
    Effect.gen(function* () {
      const { overran } = yield* startAndStop(
        Effect.addFinalizer(() => Effect.never).pipe(Effect.andThen(Effect.fail("unstartable"))),
      );

      yield* TestClock.adjust(DEADLINE);
      assert.isTrue(yield* overran);
    }),
  );
});
