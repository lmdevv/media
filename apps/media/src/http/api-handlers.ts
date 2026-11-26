import { isReceiverCredential } from "@media/contracts/cast";
import { MediaApi } from "@media/contracts/media-api";
import { PlaybackTokenInvalid } from "@media/contracts/media-playback";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpEffect } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import * as BackendHealth from "../backend-health.ts";
import * as ClientDiagnostics from "../diagnostics/client-events.ts";
import * as Downloads from "../downloads/downloads.ts";
import * as MediaConfig from "../media-config.ts";
import * as TranscodeCapabilities from "../playback/transcode-capabilities.ts";
import * as PlaybackNegotiator from "../playback/playback-negotiator.ts";
import * as PlaybackToken from "../playback/playback-grants.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import { RELEASE } from "../release.ts";
import { retryAfter } from "./rate-limit.ts";

/**
 * Refuses a receiver credential on a route only the sender calls, such as moving or stopping a
 * stream: a receiver only fetches what its sender loaded on it (ADR 0011).
 */
const fromSender = (token: Redacted.Redacted): Effect.Effect<void, PlaybackTokenInvalid> =>
  isReceiverCredential(Redacted.value(token))
    ? Effect.fail(
        new PlaybackTokenInvalid({
          reason: "wrong_purpose",
          message: "A receiver credential only fetches its cast's stream",
        }),
      )
    : Effect.void;

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
        yield* fromSender(payload.token);
        const grant = yield* verifier.verify(payload.token, PlaybackToken.PLAY, payload.streamId);
        const view = yield* sessions.seek(payload.streamId, payload.positionSeconds, grant);

        return {
          streamId: view.streamId,
          generation: view.generation,
          playlistUrl: verifier.withToken(
            `${config.mediaBaseUrl}/media/hls/${view.streamId}/${view.generation}/index.m3u8`,
            payload.token,
          ),
          mode: view.mode,
          video: view.video,
          transcode: view.transcode,
        };
      }),
      receiver: Effect.fn("Api.receiver")(function* ({ payload }) {
        const credential = yield* verifier
          .lend(payload.token)
          .pipe(Effect.mapError((refused) => refused.error));

        return { credential };
      }),
      stop: Effect.fn("Api.stop")(function* ({ payload }) {
        yield* fromSender(payload.token);
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
    const capabilities = yield* TranscodeCapabilities.Service;
    const backend = yield* BackendHealth.Service;
    const config = yield* MediaConfig.Service;

    return handlers.handleAll({
      health: Effect.fn("Api.health")(function* () {
        return {
          status: "ok" as const,
          release: RELEASE,
          activeStreams: yield* sessions.activeCount,
          runsAwaitingExit: yield* sessions.runsAwaitingExit,
          hardwareAcceleration: (yield* capabilities.hardwareEncoder) ?? ("none" as const),
          backend: yield* backend.status,
        };
      }),
      clientConfig: () =>
        Effect.succeed({
          release: RELEASE,
          ...Option.match(config.convexPublicUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ convexUrl: url }),
          }),
          ...Option.match(config.webDistDir, {
            onNone: () => ({}),
            onSome: () => ({ moviesUrl: `${config.mediaBaseUrl}/movies` }),
          }),
        }),
    });
  }),
);

/** The API routes with their handlers. */
export const apiLayer = HttpApiBuilder.layer(MediaApi).pipe(
  Layer.provide([playbackHandlers, downloadHandlers, systemHandlers]),
);
