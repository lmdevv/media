import { Clock, Effect } from "effect";

/** A day in milliseconds. */
export const DAY = 24 * 60 * 60 * 1000;

/** `clock` set `skew` milliseconds ahead, or behind for a negative skew, as one tab's may be. */
const skewedClock = (clock: Clock.Clock, skew: number): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + skew,
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + skew),
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(skew) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(skew) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) => clock.sleep(duration),
});

/** Runs `effect` on a tab whose clock is `skew` milliseconds off. */
export const onClockSkewedBy =
  (skew: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Clock.clockWith((clock) =>
      Effect.provideService(effect, Clock.Clock, skewedClock(clock, skew)),
    );
