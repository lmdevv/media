import type { ResolvedTrack } from "@media/contracts/models/music";
import { serverFunctions } from "@media/contracts/server-functions";
import { Cache, Context, Duration, Effect, Exit, Layer, Option, Predicate, Schema } from "effect";

import * as CoreSession from "../core/core-session.ts";

/** The core did not answer where a track is. */
class TrackSourcesUnavailable extends Schema.TaggedError<TrackSourcesUnavailable>()(
  "TrackSourcesUnavailable",
  {},
) {
  override get message(): string {
    return "The music catalog did not answer";
  }
}

/** Where the tracks tickets name are. */
export interface Interface {
  /**
   * The track's file as the core lists it now, or none for a track that is gone, missing, or
   * outside its library's folders. Kept for a minute, as old music's media service kept it.
   */
  readonly resolve: (
    trackId: string,
  ) => Effect.Effect<Option.Option<ResolvedTrack>, TrackSourcesUnavailable>;
  /** Forgets what `resolve` kept for a track whose file turned out to be gone. */
  readonly forget: (trackId: string) => Effect.Effect<void>;
}

/** The track sources. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/MusicTrackSources",
) {}

const SOURCE_TTL = Duration.seconds(60);

const make = Effect.gen(function* () {
  const session = yield* CoreSession.Service;

  const lookup = (trackId: string) =>
    session.call(serverFunctions.resolveTrack, { trackId }).pipe(
      Effect.map(Option.fromNullOr),
      Effect.catch((error) =>
        Predicate.isTagged(error, "NotFound") || Predicate.isTagged(error, "InvalidArgs")
          ? Effect.succeed(Option.none<ResolvedTrack>())
          : Effect.logWarning("MusicTrackSources.unavailable", error).pipe(
              Effect.andThen(Effect.fail(new TrackSourcesUnavailable())),
            ),
      ),
    );

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 10_000,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value) ? SOURCE_TTL : Duration.zero,
  });

  return Service.of({
    resolve: (trackId) => Cache.get(cache, trackId),
    forget: (trackId) => Cache.invalidate(cache, trackId),
  });
});

/** Track sources from the core's `music/tracks:resolve`. */
export const layer: Layer.Layer<Service, never, CoreSession.Service> = Layer.effect(Service, make);
