/**
 * What the iPhone player tells the media service about playback (`PlayerDiagnostics` in the SDK):
 * how much AVPlayer holds ahead, the observations for an AVPlayer failure, and the recovery the
 * controller chose. AVPlayer reports neither dropped frames nor segment load times through
 * expo-video, so neither is sent; the timeline says so.
 */
import { PlayerObservation, type RecoveryAction } from "@media/contracts/diagnostics";
import { PlayerDiagnostics } from "@media/sdk/effect";
import { Option } from "effect";

import { PlaybackStep } from "./policy";

/** Seconds AVPlayer holds ahead of its position; 0 when it does not say (`bufferedPosition` ≤ 0). */
export const bufferedAheadSeconds = (video: {
  readonly currentTime: number;
  readonly bufferedPosition: number;
}): number => Math.max(0, video.bufferedPosition - video.currentTime);

/** An AVPlayer failure as the service records it. */
export const playerErrorObservation = (message: string | undefined): PlayerObservation =>
  PlayerObservation.cases.PlayerError.make({
    source: "avplayer",
    kind: "error",
    detail: (message ?? "AVPlayer failed without a message").slice(0, 300),
    fatal: true,
  });

const actionOf = (step: PlaybackStep): Option.Option<RecoveryAction> =>
  PlaybackStep.$match(step, {
    ReloadPlaylist: () => Option.some<RecoveryAction>("reload-playlist"),
    Renegotiate: () => Option.some<RecoveryAction>("renegotiate"),
    TryAnotherWay: () => Option.some<RecoveryAction>("try-another-way"),
    NewSession: () => Option.some<RecoveryAction>("new-session"),
    Stop: () => Option.none(),
  });

/** The recovery `step` takes after `reason`, as an observation; none for a step that stops. */
export const recoveryObservation = (
  step: PlaybackStep,
  reason: string,
): Option.Option<PlayerObservation> =>
  Option.map(actionOf(step), (action) => PlayerDiagnostics.recovery(action, reason));
