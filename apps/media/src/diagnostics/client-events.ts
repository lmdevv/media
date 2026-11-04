import {
  type ClientDiagnosticEvent,
  type ClientDiagnosticsRequest,
  DiagnosticsRateLimited,
  PlayerObservation,
} from "@media/contracts/diagnostics";
import type { PlaybackTokenInvalid } from "@media/contracts/playback-token";
import { Clock, Context, Effect, Layer, Option, Predicate } from "effect";

import { makeLimiter } from "../http/rate-limit.ts";
import type { PlaybackGrant } from "../playback/playback-token.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import {
  grantAnnotations,
  LogEvent,
  SLOW_MS,
  SLOW_STARTUP_MS,
  STARTUP_FRAGMENTS,
} from "./log-events.ts";

/** Records players' events. */
export interface Interface {
  /**
   * Writes the batch to the log. Fails with `PlaybackTokenInvalid` for a bad token and
   * `DiagnosticsRateLimited` once the session or its account has sent more than its budget;
   * nothing is written then.
   */
  readonly record: (
    request: ClientDiagnosticsRequest,
  ) => Effect.Effect<void, PlaybackTokenInvalid | DiagnosticsRateLimited>;
}

/** The client event recorder. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/ClientDiagnostics",
) {}

const SESSION_BUDGET = { burst: 300, perSecond: 2 };

const USER_BUDGET = { burst: 400, perSecond: 4 * SESSION_BUDGET.perSecond };

const commonFields = (
  event: ClientDiagnosticEvent,
  grant: PlaybackGrant,
  platform: ClientDiagnosticsRequest["platform"],
  receivedAt: number,
  ownStream: boolean,
) => ({
  source: "player",
  platform,
  occurredAt: new Date(receivedAt - event.ageMs).toISOString(),
  ...grantAnnotations(grant),
  streamId: ownStream ? (event.streamId ?? null) : null,
  claimedStreamId: ownStream ? null : (event.streamId ?? null),
});

const logObservation = (
  observation: PlayerObservation,
  fields: ReturnType<typeof commonFields>,
  startup: boolean,
) =>
  PlayerObservation.match(observation, {
    Attached: ({ mode, engine, audio }) => {
      const attached = Effect.logInfo(LogEvent.playerAttached).pipe(
        Effect.annotateLogs({ ...fields, mode, engine }),
      );

      return audio === undefined
        ? attached
        : attached.pipe(
            Effect.annotateLogs({
              audioCodec: audio.codec,
              audioChannels: audio.channels,
              audioLanguage: audio.language ?? null,
            }),
          );
    },
    StartupEnded: ({ positionSeconds, durationMs, endedBy, stages }) =>
      (durationMs >= SLOW_STARTUP_MS
        ? Effect.logWarning(LogEvent.startupEnded)
        : Effect.logInfo(LogEvent.startupEnded)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          positionSeconds,
          startupMs: durationMs,
          endedBy,
          ...Object.fromEntries(Object.entries(stages ?? {}).filter(([, ms]) => ms !== undefined)),
        }),
      ),
    BufferingStarted: ({ positionSeconds, bufferedAheadSeconds }) =>
      Effect.logInfo(LogEvent.bufferingStarted).pipe(
        Effect.annotateLogs({ ...fields, positionSeconds, bufferedAheadSeconds }),
      ),
    BufferingEnded: ({ positionSeconds, bufferedAheadSeconds, durationMs, endedBy }) =>
      (durationMs >= SLOW_MS
        ? Effect.logWarning(LogEvent.bufferingEnded)
        : Effect.logInfo(LogEvent.bufferingEnded)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          positionSeconds,
          bufferedAheadSeconds,
          stalledMs: durationMs,
          endedBy,
        }),
      ),
    PlayerError: ({ source, kind, detail, fatal, status }) =>
      (fatal
        ? Effect.logError(LogEvent.playerError)
        : Effect.logWarning(LogEvent.playerError)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          errorSource: source,
          kind,
          detail,
          fatal,
          status: status ?? null,
        }),
      ),
    DroppedFrames: ({ dropped, decoded }) =>
      Effect.logInfo(LogEvent.droppedFrames).pipe(
        Effect.annotateLogs({ ...fields, dropped, decoded }),
      ),
    FragmentLoaded: ({ segment, durationMs, firstByteMs, bytes, index }) => {
      const loaded = (
        durationMs >= SLOW_MS
          ? Effect.logWarning(LogEvent.fragmentLoaded)
          : startup
            ? Effect.logInfo(LogEvent.fragmentLoaded)
            : Effect.logDebug(LogEvent.fragmentLoaded)
      ).pipe(
        Effect.annotateLogs({
          ...fields,
          segment,
          elapsedMs: durationMs,
          firstByteMs,
          bytes,
          startup,
        }),
      );

      return index === undefined ? loaded : loaded.pipe(Effect.annotateLogs("index", index));
    },
    Recovery: ({ action, reason }) =>
      (action === "renew-token"
        ? Effect.logInfo(LogEvent.recovery)
        : Effect.logWarning(LogEvent.recovery)
      ).pipe(Effect.annotateLogs({ ...fields, action, reason })),
    DriftSampled: ({ samples, medianMs, worstMs }) =>
      Effect.logInfo(LogEvent.driftSampled).pipe(
        Effect.annotateLogs({ ...fields, samples, medianMs, worstMs }),
      ),
  });

const TRACKED_SESSIONS = 1000;

const make = Effect.gen(function* () {
  const verifier = yield* PlaybackToken.Service;
  const owners = yield* StreamOwners.Service;
  const take = makeLimiter();
  const startupIndexes = new Map<string, Set<number>>();

  const admitStartup = (sessionId: string, observation: PlayerObservation): boolean => {
    if (!Predicate.isTagged(observation, "FragmentLoaded")) return false;
    const { index } = observation;

    if (index === undefined || index >= STARTUP_FRAGMENTS) return false;
    const seen = startupIndexes.get(sessionId) ?? new Set<number>();

    if (seen.has(index)) return false;
    startupIndexes.delete(sessionId);
    startupIndexes.set(sessionId, seen.add(index));

    const oldest = startupIndexes.keys().next();

    if (startupIndexes.size > TRACKED_SESSIONS && oldest.done !== true) {
      startupIndexes.delete(oldest.value);
    }

    return true;
  };

  const record = Effect.fn("ClientDiagnostics.record")(function* (
    request: ClientDiagnosticsRequest,
  ) {
    const grant = yield* verifier.verifyReport(request.token);
    const receivedAt = yield* Clock.currentTimeMillis;
    const cost = request.events.length;

    const wait = take(
      [
        [`session\u0000${grant.sessionId}`, SESSION_BUDGET],
        [`user\u0000${grant.userId}`, USER_BUDGET],
      ],
      receivedAt,
      cost,
    );

    if (Option.isSome(wait)) {
      return yield* new DiagnosticsRateLimited({ retryAfterSeconds: wait.value });
    }

    return yield* Effect.forEach(
      request.events,
      (event) =>
        Effect.flatMap(
          event.streamId === undefined
            ? Effect.succeed(true)
            : owners.belongsTo(event.streamId, grant.sessionId),
          (ownStream) =>
            logObservation(
              event.observation,
              commonFields(event, grant, request.platform, receivedAt, ownStream),
              admitStartup(grant.sessionId, event.observation),
            ),
        ),
      { discard: true },
    );
  });

  return Service.of({ record });
});

/** The recorder over the configured verifier. */
export const layer: Layer.Layer<Service, never, PlaybackToken.Service | StreamOwners.Service> =
  Layer.effect(Service, make);
