import type { CallError, PlaybackCallError } from "@media/sdk/effect";
import { Playback } from "@media/sdk/effect";
import { Data, Match } from "effect";

import type { StreamFailure } from "./stream-attachment";

const MIN_RESUME_MS = 10_000;

/**
 * Whether to ask "Resume or start over?" for a saved position. A few seconds in (a peek, or a
 * session that ended before its first progress report) is nothing worth resuming.
 */
export const offersResume = (resumePositionMs: number): boolean =>
  resumePositionMs >= MIN_RESUME_MS;

/** Where playback ends up when it cannot continue. */
export type PlaybackStop = Data.TaggedEnum<{
  /** The file was moved, renamed, or its drive is offline. */
  Missing: {};
  /** No playback path works on this device. */
  Unsupported: {};
  /** Anything else; `message` is safe to show. */
  Failed: { readonly message: string };
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
  /** Drop the failed path and negotiate the next one, telling the viewer. */
  TryAnotherWay: {};
  /** Start again at the same position with `movies.play.start`, which takes a new ticket. */
  NewSession: {};
}>;

/** Constructors and matchers for `PlaybackStep`. */
export const PlaybackStep = Data.taggedEnum<PlaybackStep>();

/** How long to wait before asking a busy media service again. */
export const RETRY_LATER_MS = 2_000;

/** The message for failures the viewer can only retry. */
export const STOPPED_MESSAGE = "Playback stopped. Try again in a moment.";

const stopWith = (stop: PlaybackStop): PlaybackStep => PlaybackStep.Stop({ stop });

const failed = (message: string): PlaybackStep => stopWith(PlaybackStop.Failed({ message }));

/**
 * The step after `movies.play.start` failed. It reports files that are all missing from disk as
 * `Conflict`; it has no other conflict.
 */
export const afterSessionFailure = (error: CallError): PlaybackStep =>
  Match.valueTags(error, {
    Conflict: () => stopWith(PlaybackStop.Missing()),
    TransportError: () => failed("Can't reach the server. Check the connection."),
    ProtocolError: () => failed(STOPPED_MESSAGE),
    Unauthenticated: ({ message }) => failed(message),
    Forbidden: ({ message }) => failed(message),
    NotFound: ({ message }) => failed(message),
    InvalidArgs: ({ message }) => failed(message),
    Expired: ({ message }) => failed(message),
    StaleRevision: () => failed(STOPPED_MESSAGE),
    RateLimited: () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS }),
    Internal: () => failed(STOPPED_MESSAGE),
  });

const recoveryStep = (error: PlaybackCallError): PlaybackStep =>
  Match.value(Playback.recoveryFor(error)).pipe(
    Match.when("reload-playlist", () => PlaybackStep.ReloadPlaylist()),
    Match.when("renegotiate", () => PlaybackStep.Renegotiate({ afterMs: 0 })),
    // The player never renews a ticket (ADR 0011): an expired one takes a new start.
    Match.when("renew-token", () => PlaybackStep.NewSession()),
    Match.when("new-session", () => PlaybackStep.NewSession()),
    Match.when("retry-later", () => PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS })),
    Match.when("unsupported", () => stopWith(PlaybackStop.Unsupported())),
    Match.when("fail", () => failed(STOPPED_MESSAGE)),
    Match.exhaustive,
  );

/**
 * The step after a media service playback request failed. A ticket the server refuses as expired,
 * or a session it reports ended, takes a new start.
 */
export const afterPlaybackFailure = (error: PlaybackCallError): PlaybackStep =>
  Match.value(error).pipe(
    Match.tag("MediaFileNotFound", () => stopWith(PlaybackStop.Missing())),
    Match.orElse(recoveryStep),
  );

/** The step after a playing stream failed, from the HTTP status of the request that failed. */
export const afterStreamFailure = (failure: StreamFailure): PlaybackStep => {
  if (failure.kind === "media") return PlaybackStep.TryAnotherWay();

  if (failure.kind === "network") return PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS });

  switch (failure.status) {
    case 410:
      return PlaybackStep.ReloadPlaylist();
    case 401:
    case 404:
      return PlaybackStep.Renegotiate({ afterMs: 0 });
    case 403:
      return failed(STOPPED_MESSAGE);
    default:
      return PlaybackStep.Renegotiate({ afterMs: RETRY_LATER_MS });
  }
};
