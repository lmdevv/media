import { HEARTBEAT_INTERVAL_MS } from "@media/contracts/clock";
import type { DeviceId, RoomId } from "@media/contracts/ids";
import { Cause, Duration, Effect, Predicate, Schedule } from "effect";

import { MoviesClient } from "../movies-client";
import type { CallError } from "../sdk-errors";

/** Which membership to keep. */
export interface RoomPresenceOptions {
  readonly roomId: RoomId;
  readonly deviceId: DeviceId;
  /** Time between heartbeats; `HEARTBEAT_INTERVAL_MS` by default, as the room engine uses. */
  readonly intervalMs?: number;
}

/**
 * Sends an `away` heartbeat for the device's membership now and then every interval, until
 * interrupted. A failed heartbeat is logged and the next one tries again, so one bad answer never
 * costs the device its place: the network, a session being refreshed, a server error, or a
 * moment without the membership (`Forbidden`), as while another tab's player leaves and rejoins.
 * Stop it when the device is no longer in the room, as `rooms.current` reports.
 */
export const keepAway = Effect.fn("RoomPresence.keepAway")(function* (
  options: RoomPresenceOptions,
) {
  const client = yield* MoviesClient;
  const { roomId, deviceId } = options;

  const beat = client.mutate("rooms.heartbeat", { roomId, deviceId, presence: "away" }).pipe(
    Effect.asVoid,
    Effect.catch((error: CallError) =>
      (Predicate.isTagged(error, "Forbidden") || Predicate.isTagged(error, "NotFound")
        ? Effect.logDebug("RoomPresence.heartbeatRefused", error)
        : Effect.logWarning("RoomPresence.heartbeatFailed", error)
      ).pipe(Effect.annotateLogs({ roomId })),
    ),
  );

  const kept = beat.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("RoomPresence.heartbeatDefect", cause).pipe(
          Effect.annotateLogs({ roomId }),
        ),
    ),
  );

  return yield* kept.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(options.intervalMs ?? HEARTBEAT_INTERVAL_MS))),
    Effect.asVoid,
  );
});
