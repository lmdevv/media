import { Data } from "effect";

import { MAX_RECOVERIES } from "./policy";

/**
 * Notices playback that should be moving and is not. AVPlayer raises no error when its stream
 * disappears (the media service restarted, a segment answers 404 or 410, the session ended): it
 * sits loading, so without this the spinner turns until the viewer gives up.
 */

/** What the watchdog last knew about the playhead and its recoveries. */
export interface StallWatch {
  /** Where the playhead was when it last moved, or when watching began, and when. */
  readonly moved: { readonly positionMs: number; readonly atMs: number };
  /** Recoveries since playback last played on. */
  readonly attempts: number;
  /** Where the latest recovery restarted the stream; null before any. */
  readonly recoveredAtMs: number | null;
}

/** What to do after a check. */
export type StallVerdict = Data.TaggedEnum<{
  /** Playback moves, is paused, or may still catch up. */
  Wait: {};
  /** Start the stream again where it stopped; `attempt` counts from 1. */
  Recover: { readonly attempt: number };
  /** Recovering did not help; stop and let the viewer retry. */
  GiveUp: {};
}>;

/** Constructors and matchers for `StallVerdict`. */
export const StallVerdict = Data.taggedEnum<StallVerdict>();

/** What a check sees. */
export interface StallCheck {
  readonly atMs: number;
  /** The believed position, which a reset or skipping player does not move. */
  readonly positionMs: number;
  /** The viewer wants playback to move: playing was asked for, and it has not ended or stopped. */
  readonly intended: boolean;
  /** A new stream or a seek is heading for a position a heavy transcode takes longer to reach. */
  readonly loading: boolean;
}

/** How long playback may stand still before the first recovery; each later one waits twice as long. */
export const STALL_AFTER_MS = 15_000;

const MOVED_MS = 250;

const RECOVERED_AFTER_MS = 10_000;

/** A watch starting at `positionMs` at `atMs`, with no recoveries yet. */
export const watching = (positionMs: number, atMs: number): StallWatch => ({
  moved: { positionMs, atMs },
  attempts: 0,
  recoveredAtMs: null,
});

const stallLimitMs = (attempts: number, loading: boolean): number =>
  STALL_AFTER_MS * 2 ** attempts * (loading ? 2 : 1);

/** The watch after `check`, and what to do. */
export const checked = (
  watch: StallWatch,
  check: StallCheck,
): readonly [StallWatch, StallVerdict] => {
  const here = { positionMs: check.positionMs, atMs: check.atMs };

  if (!check.intended) return [{ ...watch, moved: here }, StallVerdict.Wait()];

  if (Math.abs(check.positionMs - watch.moved.positionMs) >= MOVED_MS) {
    const recovered =
      watch.recoveredAtMs !== null &&
      Math.abs(check.positionMs - watch.recoveredAtMs) >= RECOVERED_AFTER_MS;

    return [
      recovered ? watching(check.positionMs, check.atMs) : { ...watch, moved: here },
      StallVerdict.Wait(),
    ];
  }

  if (check.atMs - watch.moved.atMs < stallLimitMs(watch.attempts, check.loading)) {
    return [watch, StallVerdict.Wait()];
  }

  if (watch.attempts >= MAX_RECOVERIES) return [watch, StallVerdict.GiveUp()];

  const attempt = watch.attempts + 1;

  return [
    { moved: here, attempts: attempt, recoveredAtMs: check.positionMs },
    StallVerdict.Recover({ attempt }),
  ];
};
