import {
  type ClientCapabilities,
  MEDIA_ROUTES,
  NegotiateRequest,
  type PlaybackQuality,
  NegotiateResponse,
  SeekRequest,
  SeekResponse,
  StopRequest,
  StopRequestText,
} from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { Duration, Effect, Match, Option, Redacted, Schedule, Schema, Stream } from "effect";

import type { PlaybackCallError } from "./media-http";
import { baseUrl, encodeJson, mediaUrl, requestPlayback } from "./media-http";

/**
 * What a viewer chose about the stream besides its position and audio: a quality cap, and a
 * picture subtitle (PGS, VobSub) to burn into the video, by its subtitle track ID. Choosing one
 * the stream does not have yet means negotiating again.
 */
export interface StreamChoices {
  readonly quality: Option.Option<PlaybackQuality>;
  readonly burnInSubtitle: Option.Option<string>;
}

/** No cap and no burned-in subtitle. */
export const defaultStreamChoices: StreamChoices = {
  quality: Option.none(),
  burnInSubtitle: Option.none(),
};

/** A playing session on this device. */
export interface Playback {
  readonly started: StartedPlayback;
  readonly stream: NegotiateResponse;
}

/**
 * Asks the media service for a stream of a started session's file at `startAtMs`, with the audio
 * track `audioStreamIndex` (an ffmpeg stream index) or the file's default track, within `choices`.
 */
export const negotiate = Effect.fn("Playback.negotiate")(function* (
  started: StartedPlayback,
  capabilities: ClientCapabilities,
  startAtMs: Milliseconds,
  audioStreamIndex: Option.Option<number>,
  choices: StreamChoices = defaultStreamChoices,
) {
  return yield* requestPlayback(
    {
      operation: "playback.negotiate",
      url: yield* mediaUrl(started, MEDIA_ROUTES.negotiate),
      method: "POST",
      body: Option.some(
        yield* encodeJson(NegotiateRequest, {
          token: Redacted.make(started.token),
          capabilities,
          startSeconds: startAtMs / 1000,
          ...Option.match(audioStreamIndex, {
            onNone: () => ({}),
            onSome: (index) => ({ audioStreamIndex: index }),
          }),
          ...Option.match(choices.quality, {
            onNone: () => ({}),
            onSome: (quality) => ({ quality }),
          }),
          ...Option.match(choices.burnInSubtitle, {
            onNone: () => ({}),
            onSome: (burnInSubtitle) => ({ burnInSubtitle }),
          }),
        }),
      ),
      bearer: Option.none(),
    },
    NegotiateResponse,
  );
});

/** Moves an HLS stream to `positionMs`; returns the playlist to load next, or none for direct play. */
export const seekStream = Effect.fn("Playback.seekStream")(function* (
  playback: Playback,
  positionMs: Milliseconds,
) {
  const streamId = Option.fromNullishOr(playback.stream.streamId);

  if (Option.isNone(streamId)) return Option.none<SeekResponse>();

  return Option.some(
    yield* requestPlayback(
      {
        operation: "playback.seek",
        url: yield* mediaUrl(playback.started, MEDIA_ROUTES.seek),
        method: "POST",
        body: Option.some(
          yield* encodeJson(SeekRequest, {
            token: Redacted.make(playback.started.token),
            streamId: streamId.value,
            positionSeconds: positionMs / 1000,
          }),
        ),
        bearer: Option.none(),
      },
      SeekResponse,
    ),
  );
});

/**
 * Ends an HLS stream so the media service can stop encoding and delete its segments; a direct
 * stream has nothing to stop. The request outlives the page that sends it (`keepalive`), so a stop sent as the page goes away still frees the stream's
 * transcode slot rather than holding it until the service's idle release.
 */
export const stop = (playback: Playback): Effect.Effect<void, PlaybackCallError> =>
  Option.match(Option.fromNullishOr(playback.stream.streamId), {
    onNone: () => Effect.void,
    onSome: (streamId) =>
      Effect.gen(function* () {
        yield* requestPlayback(
          {
            operation: "playback.stop",
            url: yield* mediaUrl(playback.started, MEDIA_ROUTES.stop),
            method: "POST",
            body: Option.some(
              yield* encodeJson(StopRequest, {
                token: Redacted.make(playback.started.token),
                streamId,
              }),
            ),
            bearer: Option.none(),
            keepalive: true,
          },
          Schema.Null,
        );
      }),
  });

const encodeStop = Schema.encodeSync(StopRequestText);

/**
 * Sends `playback`'s stop before it returns, for a page that is going away: a `pagehide` handler,
 * or a player torn down by a navigation that may unload the page next. `stop` runs as an Effect
 * fiber, which can yield to the scheduler before it reaches `fetch`, and a page in `pagehide`
 * never runs that later task, so its stream would hold a transcode slot until the media service's
 * idle release. This encodes the request and calls `fetch` at once, with `keepalive` so the
 * request outlives the page, and ignores the answer. The JSON body goes as `text/plain`, a simple
 * request with no CORS preflight, which a browser does not send from `pagehide`: a client on
 * another origin than the media service, as in development, needs one for JSON. A direct stream
 * has nothing to stop.
 */
export const stopNow = (playback: Playback): void => {
  const streamId = playback.stream.streamId;

  if (streamId === undefined) return;
  const body = encodeStop({ token: Redacted.make(playback.started.token), streamId });

  void fetch(`${baseUrl(playback.started.mediaBaseUrl)}${MEDIA_ROUTES.stop}`, {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body,
  }).catch(() => undefined);
};

/**
 * What a player should do after a playback API failure:
 *
 * - `reload-playlist`: a seek replaced the HLS generation; load the current one (`seekStream`).
 * - `renegotiate`: the stream is gone (a restart, an expired token, or a replaced or stopped
 *   stream); negotiate again.
 * - `renew-token`: the token expired; renew it, then negotiate again.
 * - `new-session`: the playback session ended (signed out, or another device took over); start a
 *   new one.
 * - `retry-later`: the service is busy or briefly unable to answer; retry after a pause.
 * - `unsupported`: this device cannot play the file in any mode; tell the viewer.
 * - `fail`: anything else; report the error.
 */
export type Recovery =
  | "reload-playlist"
  | "renegotiate"
  | "renew-token"
  | "new-session"
  | "retry-later"
  | "unsupported"
  | "fail";

/** The recovery for a playback API failure. */
export const recoveryFor = (error: PlaybackCallError): Recovery =>
  Match.valueTags(error, {
    StreamGenerationGone: (): Recovery => "reload-playlist",
    StreamNotFound: (): Recovery => "renegotiate",
    PlaybackTokenInvalid: ({ reason }): Recovery => (reason === "expired" ? "renew-token" : "fail"),
    PlaybackSessionEnded: (): Recovery => "new-session",
    TranscodeCapacityReached: (): Recovery => "retry-later",
    InsufficientTranscodeSpace: (): Recovery => "retry-later",
    FileResolverUnavailable: (): Recovery => "retry-later",
    SegmentNotReady: (): Recovery => "retry-later",
    TransportError: (): Recovery => "retry-later",
    UnsupportedPlayback: (): Recovery => "unsupported",
    MediaFileNotFound: (): Recovery => "fail",
    StreamAccessDenied: (): Recovery => "fail",
    SegmentNotFound: (): Recovery => "fail",
    TranscodeFailed: (): Recovery => "fail",
    KeyframeIndexFailed: (): Recovery => "fail",
    ProtocolError: (): Recovery => "fail",
  });

/** How often a playing device reports progress between events. */
export const PROGRESS_INTERVAL_MS = 10_000;

/**
 * An autoplay countdown: the remaining time now and then every `stepMs` until zero. Play the next
 * episode when it completes; interrupt it to cancel.
 */
export const autoplayCountdown = (totalMs: number, stepMs: number): Stream.Stream<Milliseconds> => {
  const steps = Math.ceil(Math.max(0, totalMs) / stepMs);

  return Stream.fromEffectSchedule(Effect.void, Schedule.spaced(Duration.millis(stepMs))).pipe(
    Stream.take(steps + 1),
    Stream.zipWithIndex,
    Stream.map(([, index]) => Milliseconds.make(Math.max(0, totalMs - index * stepMs))),
  );
};
