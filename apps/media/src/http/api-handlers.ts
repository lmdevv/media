import { MediaApi } from "@media/contracts/media-api";
import { Effect, Layer, Option } from "effect";
import { HttpEffect } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import * as BackendHealth from "../backend-health.ts";
import * as ClientDiagnostics from "../diagnostics/client-events.ts";
import * as Downloads from "../downloads/downloads.ts";
import * as MediaConfig from "../media-config.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import * as PlaybackNegotiator from "../playback/playback-negotiator.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import { retryAfter } from "./rate-limit.ts";

const playbackHandlers = HttpApiBuilder.group(
  MediaApi,
  "playback",
  Effect.fn(function* (handlers) {
    const config = yield* MediaConfig.Service;
    const negotiator = yield* PlaybackNegotiator.Service;
    const verifier = yield* PlaybackToken.Service;
    const sessions = yield* StreamSessions.Service;
    const diagnostics = yield* ClientDiagnostics.Service;

    return handlers.handleAll({
      negotiate: ({ payload }) => negotiator.negotiate(payload),
      seek: Effect.fn("Api.seek")(function* ({ payload }) {
        const grant = yield* verifier.verify(payload.token, PlaybackToken.PLAY, payload.streamId);
        const view = yield* sessions.seek(payload.streamId, payload.positionSeconds, grant);

        return {
          streamId: view.streamId,
          generation: view.generation,
          playlistUrl: verifier.withToken(
            `${config.mediaBaseUrl}/media/hls/${view.streamId}/${view.generation}/index.m3u8`,
            payload.token,
          ),
        };
      }),
      stop: Effect.fn("Api.stop")(function* ({ payload }) {
        const grant = yield* verifier.verify(payload.token, PlaybackToken.PLAY, payload.streamId);
        yield* sessions.stop(payload.streamId, grant);
      }),
      diagnostics: ({ payload }) =>
        diagnostics
          .record(payload)
          .pipe(
            Effect.tapErrorTag("DiagnosticsRateLimited", (error) =>
              HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(retryAfter(response, error.retryAfterSeconds)),
              ),
            ),
          ),
    });
  }),
);

const downloadHandlers = HttpApiBuilder.group(
  MediaApi,
  "downloads",
  Effect.fn(function* (handlers) {
    const downloads = yield* Downloads.Service;

    return handlers.handleAll({
      prepare: ({ payload }) => downloads.prepare(payload),
    });
  }),
);

const systemHandlers = HttpApiBuilder.group(
  MediaApi,
  "system",
  Effect.fn(function* (handlers) {
    const sessions = yield* StreamSessions.Service;
    const hardware = yield* HardwareAcceleration.Service;
    const backend = yield* BackendHealth.Service;
    const config = yield* MediaConfig.Service;

    return handlers.handleAll({
      health: Effect.fn("Api.health")(function* () {
        return {
          status: "ok" as const,
          activeStreams: yield* sessions.activeCount,
          runsAwaitingExit: yield* sessions.runsAwaitingExit,
          hardwareAcceleration: (yield* hardware.encoder) ?? ("none" as const),
          backend: yield* backend.status,
        };
      }),
      clientConfig: () =>
        Effect.succeed(
          Option.match(config.convexPublicUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ convexUrl: url }),
          }),
        ),
    });
  }),
);

/** The API routes with their handlers. */
export const apiLayer = HttpApiBuilder.layer(MediaApi).pipe(
  Layer.provide([playbackHandlers, downloadHandlers, systemHandlers]),
);
