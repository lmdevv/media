import { WATCHING, autoplayDue, unanswered, viewerActed } from "@media/contracts/still-watching";
import type { StillWatching } from "@media/contracts/still-watching";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How often an open question checks the wall clock for its time running out. */
const CLOSE_CHECK_MS = 1_000;

/** "Are you still watching?" kept above the player, so autoplay's jumps add up across episodes. */
export interface StillWatchingControl {
  readonly watching: StillWatching;
  /** The viewer touched the player, which resets the count. */
  readonly acted: () => void;
  /**
   * Autoplay's countdown ran out: counts the jump and says whether to start the next episode. False
   * means the player asks instead.
   */
  readonly countdownEnded: () => boolean;
  /** The viewer answered Continue Watching; the player then starts the next episode. */
  readonly continueWatching: () => void;
  /** The viewer answered I'm Done, which closes the player. */
  readonly done: () => void;
}

/**
 * The still-watching count of the watch screen. While the question shows, it checks the wall clock,
 * so an app that was away through the wait closes the player when it comes back.
 *
 * @param close - Leaves the player for the title's page; called by I'm Done and when the question
 *   goes unanswered.
 */
export function useStillWatching(close: () => void): StillWatchingControl {
  const [watching, setWatching] = useState<StillWatching>(WATCHING);

  // The countdown's end decides from the latest count before React renders it.
  const latest = useRef<StillWatching>(WATCHING);

  // Every press lands here, so an unchanged count skips the render.
  const update = useCallback((next: StillWatching) => {
    if (next === latest.current) return;

    latest.current = next;
    setWatching(next);
  }, []);

  useEffect(() => {
    if (watching.state !== "asking") return undefined;

    const timer = setInterval(() => {
      if (!unanswered(watching, Date.now())) return;

      clearInterval(timer);
      close();
    }, CLOSE_CHECK_MS);

    return () => clearInterval(timer);
  }, [watching, close]);

  const acted = useCallback(() => update(viewerActed(latest.current)), [update]);

  const countdownEnded = useCallback(() => {
    const step = autoplayDue(latest.current, Date.now());

    update(step.next);

    return step.play;
  }, [update]);

  const continueWatching = useCallback(() => update(WATCHING), [update]);

  return useMemo(
    () => ({ watching, acted, countdownEnded, continueWatching, done: close }),
    [watching, acted, countdownEnded, continueWatching, close],
  );
}
