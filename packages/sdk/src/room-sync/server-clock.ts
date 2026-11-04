import type { ClockSample } from "@media/contracts/clock";
import { Clock, Effect, Option } from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";

const sampleServerClock: Effect.Effect<ClockSample, CallError, MoviesClient> = Effect.gen(
  function* () {
    const client = yield* MoviesClient;
    const sentAt = yield* Clock.currentTimeMillis;
    const { serverTime } = yield* client.mutate("rooms.time", {});
    const receivedAt = yield* Clock.currentTimeMillis;

    return { sentAt, serverTime, receivedAt };
  },
);

/** Takes up to `count` readings `spacingMs` apart, skipping readings that failed. */
export const readServerClock = Effect.fn("ServerClock.read")(function* (
  count: number,
  spacingMs: number,
) {
  const readings = yield* Effect.forEach(
    Array.from({ length: Math.max(1, count) }, (_, index) => index),
    (index) => Effect.option(sampleServerClock).pipe(Effect.delay(index === 0 ? 0 : spacingMs)),
  );

  return readings.flatMap(Option.toArray);
});
