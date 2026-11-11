import type {
  DeviceId,
  EpisodeId,
  MediaFileId,
  ProfileId,
  RoomId,
  TitleId,
} from "@media/contracts/ids";
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
import type { Episode, MediaFile } from "@media/contracts/models/catalog";
import type {
  ProgressEvent,
  ProgressReceipt,
  StartedPlayback,
} from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { Clock, Duration, Effect, Match, Option, Redacted, Schedule, Schema, Stream } from "effect";

import type { PlaybackCallError } from "./media-http";
import { baseUrl, encodeJson, mediaUrl, requestPlayback, withRenewedToken } from "./media-http";
import { MoviesClient } from "./movies-client";
import type { PlayerEvent, PlayerPort } from "./room-sync/player-port";
import { playerEvents } from "./room-sync/player-port";

/**
 * What to play. Omitted options pick the version the profile last played, else the best the
 * device's capabilities play directly, else the best quality, and resume from saved progress.
 */
export interface PlaybackRequest {
  readonly profileId: ProfileId;
  readonly deviceId: DeviceId;
  readonly deviceName: Option.Option<string>;
  readonly titleId: TitleId;
  readonly episodeId: Option.Option<EpisodeId>;
  readonly fileId: Option.Option<MediaFileId>;
  /** Join a room's stream; the room decides the file and the position. */
  readonly roomId: Option.Option<RoomId>;
  readonly capabilities: ClientCapabilities;
  /** Start here instead of the saved progress. */
  readonly startAtMs: Option.Option<Milliseconds>;
  /** ffmpeg stream index of the audio track to play; the file's default track when none. */
  readonly audioStreamIndex: Option.Option<number>;
  /**
   * Picks the audio track from the file the session chose, when `audioStreamIndex` is none, so the
   * first stream already plays a preferred language; none plays the file's default track.
   */
  readonly chooseAudio?: (file: MediaFile) => Option.Option<number>;
  /** The most to receive, such as 720p; the best the device plays when none. */
  readonly quality: Option.Option<PlaybackQuality>;
}

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
 * stream has nothing to stop. `reportProgress` stops the stream it was given when its scope
 * closes; stop a stream that replaced it (a renegotiation) with this. The request outlives the
 * page that sends it (`keepalive`), so a stop sent as the page goes away still frees the stream's
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
 *   stream); call `renegotiate`.
 * - `renew-token`: the token expired; call `renegotiate`, which renews it first.
 * - `new-session`: the playback session ended (signed out, or another device took over); start a
 *   new one with `start`.
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

const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;

/**
 * Negotiates again at `positionMs`, for example after `StreamNotFound`, before the token expires,
 * or to switch the audio track: renews the playback token first when it expires within five
 * minutes, then returns the playback with the new token and stream. Media URLs carry the token,
 * so load the new `stream.url`. `audioStreamIndex` and `choices` pick the audio track, a quality
 * cap, and a burned-in subtitle as in `negotiate`.
 */
export const renegotiate = Effect.fn("Playback.renegotiate")(function* (
  playback: Playback,
  capabilities: ClientCapabilities,
  positionMs: Milliseconds,
  audioStreamIndex: Option.Option<number>,
  choices: StreamChoices = defaultStreamChoices,
) {
  const client = yield* MoviesClient;
  const now = yield* Clock.currentTimeMillis;

  const renewed =
    playback.started.tokenExpiresAt - TOKEN_RENEW_MARGIN_MS <= now
      ? Option.some(
          yield* client.mutate("playback.renewToken", { sessionId: playback.started.sessionId }),
        )
      : Option.none();

  const started: StartedPlayback = Option.match(renewed, {
    onNone: () => playback.started,
    onSome: (fresh) => withRenewedToken(playback.started, fresh),
  });

  const stream = yield* negotiate(started, capabilities, positionMs, audioStreamIndex, choices);
  const next: Playback = { started, stream };

  return next;
});

/**
 * Starts playing: creates the session (which ends this device's previous one), then negotiates
 * a stream at the requested position, the saved progress, or the room's start.
 */
export const start = Effect.fn("Playback.start")(function* (request: PlaybackRequest) {
  const client = yield* MoviesClient;

  const started = yield* client.mutate("playback.createSession", {
    profileId: request.profileId,
    deviceId: request.deviceId,
    titleId: request.titleId,
    ...Option.match(request.deviceName, {
      onNone: () => ({}),
      onSome: (deviceName) => ({ deviceName }),
    }),
    ...Option.match(request.episodeId, {
      onNone: () => ({}),
      onSome: (episodeId) => ({ episodeId }),
    }),
    ...Option.match(request.fileId, { onNone: () => ({}), onSome: (fileId) => ({ fileId }) }),
    ...Option.match(request.roomId, { onNone: () => ({}), onSome: (roomId) => ({ roomId }) }),
    capabilities: request.capabilities,
  });

  const startAt = Option.getOrElse(request.startAtMs, () => started.resumePositionMs);

  const { chooseAudio } = request;

  const audioStreamIndex = Option.orElse(request.audioStreamIndex, () =>
    chooseAudio === undefined ? Option.none() : chooseAudio(started.file),
  );

  const stream = yield* negotiate(started, request.capabilities, startAt, audioStreamIndex, {
    quality: request.quality,
    burnInSubtitle: Option.none(),
  });

  const playback: Playback = { started, stream };

  return playback;
});

/** How often a playing device reports progress between events. */
export const PROGRESS_INTERVAL_MS = 10_000;

const EXIT_REPORT_TIMEOUT_MS = 2_000;

const EVENT_REPORTS: Readonly<Record<PlayerEvent, ProgressEvent | null>> = {
  playing: "resume",
  paused: "pause",
  seeked: "seek",
  ended: "ended",
  waiting: null,
};

const position = (player: PlayerPort): Milliseconds =>
  Milliseconds.make(Math.max(0, player.positionMs()));

/**
 * Reports progress for a playing session until its scope closes: every ten seconds while
 * playing, and on pause, resume, seek, and end. Closing the scope ends the session and its HLS
 * stream on a best-effort basis. Report failures are logged and skipped; the next report retries.
 */
export const reportProgress = Effect.fn("Playback.reportProgress")(function* (
  playback: Playback,
  player: PlayerPort,
) {
  const client = yield* MoviesClient;
  const sessionId = playback.started.sessionId;

  const report = (event: ProgressEvent): Effect.Effect<Option.Option<ProgressReceipt>> =>
    client
      .mutate("playback.reportProgress", { sessionId, positionMs: position(player), event })
      .pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning("Playback.reportFailed", error).pipe(
            Effect.annotateLogs({ sessionId, event }),
            Effect.as(Option.none()),
          ),
        ),
      );

  const events = yield* playerEvents(player);

  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        client.mutate("playback.endSession", { sessionId, positionMs: position(player) }),
        stop(playback),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeout(Duration.millis(EXIT_REPORT_TIMEOUT_MS)), Effect.ignore),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(events, (event) => {
      const kind = EVENT_REPORTS[event];

      return kind === null ? Effect.void : report(kind);
    }),
  );

  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.suspend(() => (player.isPaused() ? Effect.void : report("tick"))).pipe(
        Effect.delay(Duration.millis(PROGRESS_INTERVAL_MS)),
      ),
      Schedule.forever,
    ),
  );
});

/** The episode after `episodeId` for this profile, or none after the last one. */
export const nextEpisode = Effect.fn("Playback.nextEpisode")(function* (
  profileId: ProfileId,
  episodeId: EpisodeId,
) {
  const client = yield* MoviesClient;

  const next: Episode | null = yield* client.query("playback.nextEpisode", {
    profileId,
    episodeId,
  });

  return Option.fromNullishOr(next);
});

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
