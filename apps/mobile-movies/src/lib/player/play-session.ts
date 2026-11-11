import {
  Conflict,
  Expired,
  Forbidden,
  Internal,
  InvalidArgs,
  NotFound,
  RateLimited,
  StaleRevision,
  Unauthenticated,
} from "@media/contracts/errors";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { StartedPlayback } from "@media/contracts/models/playback";
import type { CallError } from "@media/sdk/effect";
import { ProtocolError, TransportError } from "@media/sdk/effect";
import type { PlatformSdk } from "@media/sdk/promise";
import { Option, Result, Schema } from "effect";

import type { EpisodeId, MediaFileId, TitleId } from "@/lib/catalog";

/** The platform commands a playback calls: one start per ticket, and its progress reports. */
export interface PlayCommands {
  readonly start: PlatformSdk["movies"]["play"]["start"];
  readonly report: PlatformSdk["movies"]["play"]["report"];
}

/** What `movies.play.start` takes. */
export type StartArgs = Parameters<PlayCommands["start"]>[0];

/** What `movies.play.start` answers: the file, where to resume, and this start's ticket. */
export type CoreStart = Awaited<ReturnType<PlayCommands["start"]>>;

/**
 * One start of a playback. `start` is the core's answer, whose ids name things to the platform and
 * whose `playbackId` and `startedAt` every report carries. `started` is the same start as the
 * media server's playback API and the player diagnostics read it: its `token` is the ticket, its
 * `tokenExpiresAt` the ticket's expiry, and its `sessionId` the `playbackId`.
 */
export interface StartedPlay {
  readonly start: CoreStart;
  readonly started: StartedPlayback;
}

type CoreCapabilities = NonNullable<StartArgs["capabilities"]>;

const present = <A, B>(value: A | undefined, field: (defined: A) => B): B | {} =>
  Option.match(Option.fromUndefinedOr(value), { onNone: () => ({}), onSome: field });

/** `capabilities` as `movies.play.start` takes them, which leaves out an absent limit's key. */
const coreCapabilities = (capabilities: ClientCapabilities): CoreCapabilities => ({
  containers: capabilities.containers,
  videoCodecs: capabilities.videoCodecs.map((video) => ({
    codec: video.codec,
    ...present(video.profiles, (profiles) => ({ profiles })),
    ...present(video.maxLevel, (maxLevel) => ({ maxLevel })),
    ...present(video.maxBitDepth, (maxBitDepth) => ({ maxBitDepth })),
    ...present(video.dynamicRanges, (dynamicRanges) => ({ dynamicRanges })),
  })),
  audioCodecs: capabilities.audioCodecs.map((audio) => ({
    codec: audio.codec,
    ...present(audio.maxChannels, (maxChannels) => ({ maxChannels })),
  })),
  maxWidth: capabilities.maxWidth,
  maxHeight: capabilities.maxHeight,
  hls: capabilities.hls,
  mse: capabilities.mse,
});

/** What a start plays: a movie, or an episode of a show. */
export interface PlayTarget {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
}

/**
 * The arguments that start `target` in version `fileId`, or in the version the server picks: the
 * one last played, else the best `capabilities` plays directly.
 */
export const startArgs = (
  target: PlayTarget,
  fileId: MediaFileId | null,
  capabilities: ClientCapabilities,
): StartArgs => ({
  titleId: target.titleId,
  ...Option.match(Option.fromNullishOr(target.episodeId), {
    onNone: () => ({}),
    onSome: (episodeId) => ({ episodeId }),
  }),
  ...Option.match(Option.fromNullishOr(fileId), {
    onNone: () => ({}),
    onSome: (chosen) => ({ fileId: chosen }),
  }),
  capabilities: coreCapabilities(capabilities),
});

const decodeStarted = Schema.decodeUnknownResult(StartedPlayback);

/**
 * `start` with the media server's view of it at `mediaBaseUrl`. Fails with `ProtocolError` when the
 * core answered with a start the media contracts do not describe. The core lists only files on
 * disk, so the file is never missing.
 */
export const startedPlay = (
  start: CoreStart,
  mediaBaseUrl: string,
): Result.Result<StartedPlay, ProtocolError> =>
  decodeStarted({
    sessionId: start.playbackId,
    titleId: start.titleId,
    episodeId: start.episodeId,
    episode: start.episode,
    file: { ...start.file, missing: false },
    token: start.ticket,
    tokenExpiresAt: start.expiresAt,
    mediaBaseUrl,
    resumePositionMs: start.resumePositionMs,
  }).pipe(
    Result.mapError(
      (cause) =>
        new ProtocolError({
          operation: "movies.play.start",
          message:
            "Protocol error in movies.play.start: the start does not describe a playable file",
          cause,
        }),
    ),
    Result.map((started) => ({ start, started })),
  );

const isCallError = Schema.is(
  Schema.Union([
    Unauthenticated,
    Forbidden,
    NotFound,
    InvalidArgs,
    Conflict,
    Expired,
    StaleRevision,
    RateLimited,
    Internal,
    TransportError,
    ProtocolError,
  ]),
);

/**
 * Starts a playback at `mediaBaseUrl` with `movies.play.start`, which takes a new ticket. Expected
 * failures come back as values; anything else, such as a defect in the client, rejects.
 */
export const startPlay = async (
  commands: Pick<PlayCommands, "start">,
  args: StartArgs,
  mediaBaseUrl: string,
): Promise<Result.Result<StartedPlay, CallError>> => {
  try {
    return startedPlay(await commands.start(args), mediaBaseUrl);
  } catch (cause) {
    if (isCallError(cause)) return Result.fail(cause);

    throw cause;
  }
};
