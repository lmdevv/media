import {
  type FileResolverUnavailable,
  type MediaFileNotFound,
  type NegotiateRequest,
  type NegotiateResponse,
  type PlaybackSessionEnded,
  PlaybackTokenInvalid,
  UnsupportedPlayback,
} from "@media/contracts/media-playback";
import { Context, Duration, Effect, FileSystem, Layer, Option, Path } from "effect";
import type { Redacted } from "effect";

import * as MediaConfig from "../media-config.ts";
import { subtitleTracks } from "../subtitles/subtitle-tracks.ts";
import * as FileResolver from "./file-resolver.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import * as HardwareAcceleration from "./hardware-acceleration.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { AudioPlan, decidePlayback, PlaybackPlan, VideoPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as PlaybackToken from "./playback-grants.ts";
import * as StreamSessions from "./stream-sessions.ts";

type NegotiateError =
  | PlaybackTokenInvalid
  | PlaybackSessionEnded
  | MediaFileNotFound
  | FileResolverUnavailable
  | UnsupportedPlayback
  | StreamSessions.StartError;

/** Negotiates playback. */
export interface Interface {
  readonly negotiate: (
    request: NegotiateRequest,
  ) => Effect.Effect<NegotiateResponse, NegotiateError>;
}

/** The playback negotiator. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/PlaybackNegotiator",
) {}

const KEYFRAME_WAIT = Duration.seconds(2);

const burnedStreamIndex = (
  file: FileResolver.ResolvedMediaFile,
  trackId: string | undefined,
): number | undefined => {
  if (trackId === undefined) return undefined;
  const track = subtitleTracks(file).find((candidate) => candidate.id === trackId);

  return track?.kind === "bitmap" && track.source === "embedded" ? Number(track.id.slice(1)) : -1;
};

/**
 * The subtitle tracks of `file` as players see them; text tracks carry their WebVTT URL under
 * `base`, authorized by `token`. Media URLs carry the token because `<video>` and segment fetches
 * cannot set headers, in the parameter `withToken` puts it in.
 */
export const subtitleViews = (
  file: FileResolver.CheckedMediaFile,
  base: string,
  token: Redacted.Redacted,
  withToken: PlaybackToken.Interface["withToken"],
) =>
  subtitleTracks(file).map((track) => ({
    id: track.id,
    source: track.source,
    codec: track.codec,
    kind: track.kind,
    language: track.language,
    title: track.title,
    forced: track.forced,
    default: track.default,
    hearingImpaired: track.hearingImpaired,
    url:
      track.kind === "text"
        ? withToken(`${base}/media/subtitles/${file.fileId}/${track.id}.vtt`, token)
        : undefined,
  }));

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const verifier = yield* PlaybackToken.Service;
  const sessions = yield* StreamSessions.Service;
  const hardware = yield* HardwareAcceleration.Service;
  const reporter = yield* PlaybackReporter.Service;
  const resolver = yield* FileResolver.Service;
  const keyframes = yield* KeyframeIndex.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const negotiate = Effect.fn("PlaybackNegotiator.negotiate")(function* (
    request: NegotiateRequest,
  ) {
    const grant = yield* verifier.verify(request.token, PlaybackToken.PLAY);

    // A music track's ticket plays only on music's stream route.
    if (grant.resource !== "file") {
      return yield* new PlaybackTokenInvalid({
        reason: "wrong_purpose",
        message: "This ticket is for a song, not a movies file",
      });
    }

    const negotiation = yield* sessions.negotiate(grant);

    const file = yield* resolveInsideRoots(grant.fileId, { sidecars: true }).pipe(
      Effect.provideService(FileResolver.Service, resolver),
      Effect.provideService(MediaConfig.Service, config),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

    yield* Effect.annotateCurrentSpan({ fileId: grant.fileId, sessionId: grant.sessionId });
    const burnSubtitle = burnedStreamIndex(file, request.burnInSubtitle);

    const decision = {
      audioIndex: request.audioStreamIndex,
      hardware: yield* hardware.encoder,
      softwareToneMapping: yield* hardware.softwareToneMapping,
      quality: request.quality,
      burnSubtitle,
    };

    const preferred = decidePlayback(file.probe, request.capabilities, decision);

    const copied =
      PlaybackPlan.$is("Hls")(preferred) && VideoPlan.$is("Copy")(preferred.video)
        ? yield* keyframes.keyframesWithin(file, KEYFRAME_WAIT)
        : Option.none<ReadonlyArray<number>>();

    const encoded =
      PlaybackPlan.$is("Hls")(preferred) &&
      VideoPlan.$is("Copy")(preferred.video) &&
      Option.isNone(copied)
        ? decidePlayback(file.probe, request.capabilities, { ...decision, copyVideo: false })
        : undefined;

    const indexing = encoded !== undefined && PlaybackPlan.$is("Hls")(encoded);

    if (indexing) {
      yield* Effect.logInfo("PlaybackNegotiator.encoding_while_indexing").pipe(
        Effect.annotateLogs({ fileId: grant.fileId }),
      );
    }

    const plan = indexing ? encoded : preferred;

    const knownKeyframes =
      PlaybackPlan.$is("Hls")(plan) && VideoPlan.$is("Copy")(plan.video)
        ? Option.getOrUndefined(copied)
        : undefined;

    const video = file.probe.video;

    if (PlaybackPlan.$is("Unsupported")(plan) || video === undefined) {
      return yield* new UnsupportedPlayback({
        reason: PlaybackPlan.$is("Unsupported")(plan) ? plan.reason : "no-video-stream",
      });
    }

    const startSeconds = Math.min(
      request.startSeconds ?? 0,
      Math.max(0, file.probe.durationSeconds - 1),
    );

    const base = config.mediaBaseUrl;

    const subtitles = subtitleViews(file, base, request.token, verifier.withToken);

    const audioIndex = PlaybackPlan.$is("Direct")(plan)
      ? plan.audioIndex
      : PlaybackPlan.$is("Hls")(plan) && "index" in plan.audio
        ? plan.audio.index
        : undefined;

    const sourceAudio = file.probe.audio.find((track) => track.index === audioIndex);
    const transcodedAudio = PlaybackPlan.$is("Hls")(plan) && AudioPlan.$is("Aac")(plan.audio);

    const common = {
      durationSeconds: file.probe.durationSeconds,
      startSeconds,
      video: {
        codec: video.codec,
        width: video.width,
        height: video.height,
        dynamicRange: video.dynamicRange,
      },
      audio:
        sourceAudio === undefined
          ? undefined
          : {
              streamIndex: sourceAudio.index,
              codec: transcodedAudio ? "aac" : sourceAudio.codec,
              channels: transcodedAudio ? 2 : sourceAudio.channels,
            },
      subtitles,
      expiresAt: grant.expiresAt,
    };

    if (PlaybackPlan.$is("Direct")(plan)) {
      if (yield* negotiation.direct) {
        yield* reporter.report(
          PlaybackReporter.PlaybackEvent.cases.ModeChosen.make({
            sessionId: grant.sessionId,
            userId: grant.userId,
            fileId: grant.fileId,
            mode: "direct",
          }),
        );
      }

      return {
        ...common,
        mode: "direct",
        url: verifier.withToken(`${base}/media/direct/${grant.fileId}`, request.token),
      } satisfies NegotiateResponse;
    }

    const startWith = (chosen: typeof plan, keyframeTimes: ReadonlyArray<number> | undefined) =>
      negotiation
        .start({
          file,
          plan: chosen,
          client: request.capabilities,
          audioIndex: request.audioStreamIndex,
          startSeconds,
          quality: request.quality,
          burnSubtitle,
          keyframes: keyframeTimes,
        })
        .pipe(Effect.map((started) => ({ started, chosen })));

    const { started, chosen } = yield* startWith(plan, knownKeyframes).pipe(
      Effect.catchTag("TranscodeCapacityReached", (full) =>
        indexing && PlaybackPlan.$is("Hls")(preferred)
          ? keyframes
              .keyframes(file)
              .pipe(Effect.flatMap((keyframeTimes) => startWith(preferred, keyframeTimes)))
          : Effect.fail(full),
      ),
    );

    const outputVideo =
      VideoPlan.$is("Encode")(chosen.video) &&
      started.mode !== "remux" &&
      started.mode !== "audio-transcode"
        ? {
            codec: "h264",
            width: chosen.video.width,
            height: chosen.video.height,
            dynamicRange: "sdr" as const,
          }
        : common.video;

    return {
      ...common,
      video: outputVideo,
      mode: started.mode,
      burnedInSubtitle: burnSubtitle === undefined ? undefined : request.burnInSubtitle,
      streamId: started.streamId,
      generation: started.generation,
      url: verifier.withToken(
        `${base}/media/hls/${started.streamId}/${started.generation}/index.m3u8`,
        request.token,
      ),
    } satisfies NegotiateResponse;
  }, Effect.scoped);

  return Service.of({ negotiate });
});

/** The negotiator. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | PlaybackToken.Service
  | StreamSessions.Service
  | HardwareAcceleration.Service
  | PlaybackReporter.Service
  | FileResolver.Service
  | KeyframeIndex.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(Service, make);
