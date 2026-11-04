import { PlaybackMode } from "@media/contracts/models/playback";
import { Context, Effect, Layer, Ref, Schema } from "effect";

import { MediaFileId, PlaybackSessionId, UserId } from "@media/contracts/ids";
import { StreamId } from "@media/contracts/media-playback";

import { LogEvent } from "../diagnostics/log-events.ts";
import { Snapshot } from "./stream-liveness.ts";

const StreamEndReason = Schema.Literals([
  "stopped",
  "abandoned",
  "expired",
  "unattended",
  "resume-refused",
  "replaced",
  "failed",
  "shutdown",
  "session-ended",
]);

/** Why an HLS stream closed. */
export type StreamEndReason = typeof StreamEndReason.Type;

/** Something that happened to a per-device playback session. */
export const PlaybackEvent = Schema.TaggedUnion({
  /** Negotiation chose a mode. HLS sessions carry their stream ID. */
  ModeChosen: {
    sessionId: PlaybackSessionId,
    userId: UserId,
    fileId: MediaFileId,
    streamId: Schema.optional(StreamId),
    mode: PlaybackMode,
  },
  /** A running session switched modes, for example from QSV to software. */
  ModeChanged: {
    sessionId: PlaybackSessionId,
    userId: UserId,
    fileId: MediaFileId,
    streamId: StreamId,
    from: PlaybackMode,
    to: PlaybackMode,
    reason: Schema.Literals(["hardware-unavailable"]),
  },
  /**
   * An HLS session closed and its temporary segments were deleted. The liveness fields say how
   * recently the stream was used when it closed.
   */
  StreamEnded: {
    sessionId: PlaybackSessionId,
    userId: UserId,
    fileId: MediaFileId,
    streamId: StreamId,
    reason: StreamEndReason,
    ...Snapshot.fields,
  },
});

/** Something that happened to a per-device playback session. */
export type PlaybackEvent = typeof PlaybackEvent.Type;

/** Receives playback events. Reporting never fails playback. */
export interface Interface {
  readonly report: (event: PlaybackEvent) => Effect.Effect<void>;
}

/** The playback event reporter. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/PlaybackReporter",
) {}

/** Logs `event` at `INFO` under its playback event name, with its fields as annotations. */
export const logEvent = (event: PlaybackEvent): Effect.Effect<void> => {
  const { _tag, ...fields } = event;

  return Effect.logInfo(
    PlaybackEvent.match(event, {
      ModeChosen: () => LogEvent.streamStarted,
      ModeChanged: () => LogEvent.modeChanged,
      StreamEnded: () => LogEvent.streamEnded,
    }),
  ).pipe(Effect.annotateLogs(fields));
};

/** Only logs events, for standalone mode. */
export const layerLog: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({ report: logEvent }),
);

/** Inspection of a recording reporter. */
export interface RecordingInterface {
  readonly events: Effect.Effect<ReadonlyArray<PlaybackEvent>>;
}

/** A reporter that keeps every event in memory, for tests. */
export class Recording extends Context.Service<Recording, RecordingInterface>()(
  "@media/server/PlaybackReporter/Recording",
) {}

/** A recording reporter providing both the reporter and its inspection service. */
export const layerRecording: Layer.Layer<Service | Recording> = Layer.effectContext(
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<PlaybackEvent>>([]);

    return Context.empty().pipe(
      Context.add(
        Service,
        Service.of({
          report: (event) =>
            Effect.andThen(
              logEvent(event),
              Ref.update(events, (seen) => [...seen, event]),
            ),
        }),
      ),
      Context.add(Recording, Recording.of({ events: Ref.get(events) })),
    );
  }),
);
