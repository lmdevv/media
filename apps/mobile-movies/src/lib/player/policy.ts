import type { ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";
import type { CallError, PlaybackCallError } from "@media/sdk/effect";
import { Playback } from "@media/sdk/effect";
import { Data, Match, Predicate, Struct } from "effect";

/** Where playback ends up when it cannot continue. */
export type PlaybackStop = Data.TaggedEnum<{
  /** The file was moved, renamed, or its drive is offline. */
  Missing: {};
  /** No playback path works on this device. */
  Unsupported: {};
  /** Anything else; `message` is safe to show. */
  Interrupted: { readonly message: string };
}>;

/** Constructors and matchers for `PlaybackStop`. */
export const PlaybackStop = Data.taggedEnum<PlaybackStop>();

/** What to do next after a failure. */
export type PlaybackStep = Data.TaggedEnum<{
  Stop: { readonly stop: PlaybackStop };
  /** Load the stream's current HLS generation at the same position. */
  ReloadPlaylist: {};
  /** Negotiate a new stream at the same position with the same ticket. */
  Renegotiate: { readonly afterMs: number };
  /** Drop the failed path and negotiate the next one. */
  TryAnotherWay: {};
  /** Start again at the same position with `movies.play.start`, which takes a new ticket. */
  NewSession: {};
}>;

/** Constructors and matchers for `PlaybackStep`. */
export const PlaybackStep = Data.taggedEnum<PlaybackStep>();

/** How long to wait before asking a busy media service again. */
export const RETRY_LATER_MS = 2_000;

/** Recoveries in a row, without playback resuming between them, before playback gives up. */
export const MAX_RECOVERIES = 3;

/** The line for a connection that dropped (F09). */
export const CONNECTION_LOST = "Your connection was lost.";

/** The line for failures the viewer can only retry. */
export const STOPPED_MESSAGE = "Playback stopped. Try again in a moment.";

const stopWith = (stop: PlaybackStop): PlaybackStep => PlaybackStep.Stop({ stop });

const interrupted = (message: string): PlaybackStep =>
  stopWith(PlaybackStop.Interrupted({ message }));

/**
 * The step after `movies.play.start` failed. It reports files that are all missing from disk as
 * `Conflict`; it has no other conflict.
 */
export const afterSessionFailure = (error: CallError): PlaybackStep =>
  Match.valueTags(error, {
    Conflict: () => stopWith(PlaybackStop.Missing()),
    TransportError: () => interrupted(CONNECTION_LOST),
    ProtocolError: () => interrupted(STOPPED_MESSAGE),
    Unauthenticated: ({ message }) => interrupted(message),
    Forbidden: ({ message }) => interrupted(message),
    NotFound: ({ message }) => interrupted(message),
    InvalidArgs: ({ message }) => interrupted(message),
    Expired: ({ message }) => interrupted(message),
    StaleRevision: () => interrupted(STOPPED_MESSAGE),
    RateLimited: () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    Internal: () => interrupted(STOPPED_MESSAGE),
  });

const recoveryStep = (error: PlaybackCallError): PlaybackStep =>
  Match.value(Playback.recoveryFor(error)).pipe(
    Match.when("reload-playlist", () => PlaybackStep.ReloadPlaylist()),
    Match.when("renegotiate", () => PlaybackStep.Renegotiate({ afterMs: 0 })),
    Match.when("renew-token", () => PlaybackStep.NewSession()),
    Match.when("new-session", () => PlaybackStep.NewSession()),
    Match.when("retry-later", () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS })),
    Match.when("unsupported", () => stopWith(PlaybackStop.Unsupported())),
    Match.when("fail", () => interrupted(STOPPED_MESSAGE)),
    Match.exhaustive,
  );

/**
 * The step after a media service playback request failed. The player never renews a ticket (ADR
 * 0011): a ticket the server refuses as expired, or a session it reports ended, takes a new start.
 */
export const afterPlaybackFailure = (error: PlaybackCallError): PlaybackStep =>
  Match.value(error).pipe(
    Match.tag("MediaFileNotFound", () => stopWith(PlaybackStop.Missing())),
    Match.orElse(recoveryStep),
  );

/**
 * The step after AVPlayer reported an error for the loaded stream. AVPlayer does not say which
 * request failed or with what status, so an HLS stream first loads its current generation (a seek
 * may have replaced it, or the service restarted, which `seekStream` reports). When the reloaded
 * stream fails again before it plays, AVPlayer cannot decode it: the failed path is dropped, so a
 * copied codec gives way to a transcode. A direct file gives way to HLS at once.
 *
 * @param reloaded - The stream was already reloaded after an error and has not played since.
 */
export const afterPlayerError = (
  stream: Pick<NegotiateResponse, "mode">,
  reloaded: boolean,
): PlaybackStep =>
  stream.mode === "direct" || reloaded
    ? PlaybackStep.TryAnotherWay()
    : PlaybackStep.ReloadPlaylist();

/**
 * The capabilities without the path that just failed, so renegotiating picks the next rung: a
 * failed direct file drops progressive playback, and a failed copied stream drops its video codec
 * (except H.264, which every transcode produces). Null when nothing is left to drop.
 */
export const withoutFailedPath = (
  capabilities: ClientCapabilities,
  stream: Pick<NegotiateResponse, "mode" | "video">,
): ClientCapabilities | null => {
  if (stream.mode === "direct") {
    return capabilities.containers.length === 0
      ? null
      : Struct.evolve(capabilities, { containers: () => [] });
  }

  if (stream.mode === "remux" || stream.mode === "audio-transcode") {
    if (stream.video.codec === "h264") return null;

    const videoCodecs = capabilities.videoCodecs.filter(
      (support) => support.codec !== stream.video.codec,
    );

    return videoCodecs.length === capabilities.videoCodecs.length
      ? null
      : Struct.evolve(capabilities, { videoCodecs: () => videoCodecs });
  }

  return null;
};

const UNHONOURED = [
  "UnsupportedPlayback",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
] as const;

/**
 * Whether the service could not give a stream with the quality cap or picture subtitle asked for,
 * so asking again without them may work.
 */
export const isUnhonoured = (failure: PlaybackCallError): boolean =>
  UNHONOURED.some((tag) => Predicate.isTagged(failure, tag));
