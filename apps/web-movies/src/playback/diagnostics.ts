import type { PlayerObservation, RecoveryAction } from "@media/contracts/diagnostics";
import { PlayerDiagnostics } from "@media/sdk/effect";
import { Option } from "effect";

import type { TimeRangesLike } from "./media-element-player";
import { PlaybackStep } from "./playback-policy";

/** The parts of a `<video>` element the diagnostics read. */
export interface DiagnosedElement {
  readonly currentTime: number;
  readonly buffered: TimeRangesLike;
  /** Absent in browsers without the Media Playback Quality API. */
  readonly getVideoPlaybackQuality?: () => {
    readonly droppedVideoFrames: number;
    readonly totalVideoFrames: number;
  };
}

/** Seconds the element holds from its position to the end of the range around it; 0 when none. */
export const bufferedAheadSeconds = (element: DiagnosedElement): number => {
  const { buffered, currentTime } = element;

  const ends = Array.from({ length: buffered.length }, (_, index) => index).flatMap((index) =>
    buffered.start(index) <= currentTime + 0.5 && currentTime <= buffered.end(index)
      ? [buffered.end(index)]
      : [],
  );

  return Math.max(0, ...ends.map((end) => end - currentTime));
};

/** The frames the element dropped and decoded so far, where the browser counts them. */
export const frameCounts = (
  element: DiagnosedElement,
): Option.Option<PlayerDiagnostics.FrameCounts> =>
  Option.map(Option.fromNullishOr(element.getVideoPlaybackQuality), (quality) => {
    const counts = quality.call(element);

    return { dropped: counts.droppedVideoFrames, decoded: counts.totalVideoFrames };
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
