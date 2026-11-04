import type { PlaybackSessionId } from "@media/contracts/ids";
import type { StreamId } from "@media/contracts/media-playback";
import { Clock, Context, Effect, Layer } from "effect";

/** Stream owners. */
export interface Interface {
  /** Records that `streamId` plays for `sessionId`. */
  readonly opened: (streamId: StreamId, sessionId: PlaybackSessionId) => Effect.Effect<void>;
  /** Records that `streamId` ended; it still belongs to its session for a while. */
  readonly closed: (streamId: StreamId) => Effect.Effect<void>;
  /** Whether `streamId` is open, or ended a short while ago, for `sessionId`. */
  readonly belongsTo: (streamId: string, sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
}

/** The stream owner registry. */
export class Service extends Context.Service<Service, Interface>()("@media/server/StreamOwners") {}

const ENDED_GRACE_MS = 10 * 60 * 1000;

const MAX_ENDED = 10_000;

interface Owner {
  readonly sessionId: PlaybackSessionId;
  readonly endedAt: number | undefined;
}

const make = Effect.sync((): Interface => {
  const owners = new Map<string, Owner>();
  let ended = 0;

  const forgetEnded = (now: number): void => {
    for (const [streamId, owner] of owners) {
      if (owner.endedAt === undefined) continue;

      if (now - owner.endedAt < ENDED_GRACE_MS && ended <= MAX_ENDED) return;
      owners.delete(streamId);
      ended -= 1;
    }
  };

  return {
    opened: (streamId, sessionId) =>
      Effect.sync(() => {
        owners.set(streamId, { sessionId, endedAt: undefined });
      }),
    closed: (streamId) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const owner = owners.get(streamId);

        if (owner === undefined || owner.endedAt !== undefined) return;
        owners.delete(streamId);
        owners.set(streamId, { sessionId: owner.sessionId, endedAt: now });
        ended += 1;
        forgetEnded(now);
      }),
    belongsTo: (streamId, sessionId) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        forgetEnded(now);

        return owners.get(streamId)?.sessionId === sessionId;
      }),
  };
});

/** An empty registry. */
export const layer: Layer.Layer<Service> = Layer.effect(Service, make);
