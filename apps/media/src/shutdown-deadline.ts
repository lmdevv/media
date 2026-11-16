/**
 * The bound on the media service's stop: one finalizer that never returns would otherwise leave
 * the process running for ever, ignoring SIGTERM, and hold every restart and upgrade of an install.
 */
import { Duration, Effect, Fiber, Option, Ref, type Scope } from "effect";

/**
 * How long the media service may take to stop, from SIGTERM or SIGINT until it exits: the HTTP
 * server's 3 s for open responses, then 2 s for the rest to close. Well inside Docker's 10 s before
 * it kills a container, and s6's and systemd's longer waits.
 */
export const STOP_DEADLINE = Duration.seconds(5);

/**
 * Runs `program` in a scope that must finish closing within `deadline` of `program` ending, for a
 * stop or a failure: past that, `overran` runs while the finalizers still hang. Once every
 * finalizer has returned in time, `overran` never runs.
 *
 * @param overran - What a stop that overran does, such as logging and exiting the process; it runs
 *   on a fiber of its own, outside the hung scope.
 */
export const withShutdownDeadline =
  (deadline: Duration.Duration, overran: Effect.Effect<void>) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.gen(function* () {
      const watchdog = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

      // Added first, so it runs last, once every other finalizer has returned.
      yield* Effect.addFinalizer(() =>
        Ref.get(watchdog).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.interrupt })),
        ),
      );

      return yield* program.pipe(
        Effect.ensuring(
          Effect.sleep(deadline).pipe(
            Effect.andThen(overran),
            Effect.forkDetach,
            Effect.flatMap((fiber) => Ref.set(watchdog, Option.some(fiber))),
          ),
        ),
      );
    }).pipe(Effect.scoped);
