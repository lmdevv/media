import type { CallError } from "@media/sdk/effect";
import { Effect, Layer, Queue, Stream } from "effect";

import * as PlaybackReporter from "../playback/playback-reporter.ts";
import * as MediaBackend from "./media-backend.ts";

const QUEUE_CAPACITY = 1024;

/** The reporter over the Convex connection; its writer lives as long as the layer. */
export const layer: Layer.Layer<PlaybackReporter.Service, never, MediaBackend.Service> =
  Layer.effect(
    PlaybackReporter.Service,
    Effect.gen(function* () {
      const backend = yield* MediaBackend.Service;
      const queue = yield* Queue.dropping<PlaybackReporter.PlaybackEvent>(QUEUE_CAPACITY);

      const write = (event: PlaybackReporter.PlaybackEvent): Effect.Effect<void> =>
        PlaybackReporter.PlaybackEvent.match(event, {
          ModeChosen: ({ sessionId, mode }): Effect.Effect<void, CallError> =>
            backend
              .call("mediaService.recordPlaybackMode", { sessionId, mode })
              .pipe(Effect.asVoid),
          ModeChanged: ({ sessionId, to }): Effect.Effect<void, CallError> =>
            backend
              .call("mediaService.recordPlaybackMode", { sessionId, mode: to })
              .pipe(Effect.asVoid),
          StreamEnded: (): Effect.Effect<void, CallError> => Effect.void,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("PlaybackReporter.write_failed", error).pipe(
              Effect.annotateLogs({ sessionId: event.sessionId }),
            ),
          ),
        );

      yield* Stream.fromQueue(queue).pipe(Stream.runForEach(write), Effect.forkScoped);

      return PlaybackReporter.Service.of({
        report: (event) =>
          Effect.andThen(
            PlaybackReporter.logEvent(event),
            Queue.offer(queue, event).pipe(Effect.asVoid),
          ),
      });
    }),
  );
