import { WATCHING, autoplayDue, unanswered, viewerActed } from "@media/contracts/still-watching";
import type { StillWatching } from "@media/contracts/still-watching";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How often an open question checks the wall clock for its time running out. */
const CLOSE_CHECK_MS = 1_000;

/** "Are you still watching?" kept above the player, so autoplay's jumps add up across episodes. */
export interface StillWatchingControl {
  readonly watching: StillWatching;
  /**
   * Autoplay's countdown ran out: counts the jump and says whether to start the next episode. False
   * means the player asks instead.
   */
  readonly countdownEnded: () => boolean;
  /** The viewer answered Continue watching; the player then starts the next episode. */
  readonly continueWatching: () => void;
  /** The viewer answered I'm done, which closes the player. */
  readonly done: () => void;
}

/**
 * The still-watching count of a watch page. A pointer press or key press anywhere on the page
 * resets it; moving the pointer does not. While the question shows, it checks the wall clock, so a
 * computer that slept through the wait closes the player when it wakes.
 *
 * @param close - Leaves the player for the title's page; called by I'm done and when the question
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
    const acted = () => update(viewerActed(latest.current));

    window.addEventListener("pointerdown", acted, true);
    window.addEventListener("keydown", acted, true);

    return () => {
      window.removeEventListener("pointerdown", acted, true);
      window.removeEventListener("keydown", acted, true);
    };
  }, [update]);

  useEffect(() => {
    if (watching.state !== "asking") return undefined;

    const timer = setInterval(() => {
      if (!unanswered(watching, Date.now())) return;

      clearInterval(timer);
      close();
    }, CLOSE_CHECK_MS);

    return () => clearInterval(timer);
  }, [watching, close]);

  const countdownEnded = useCallback(() => {
    const step = autoplayDue(latest.current, Date.now());

    update(step.next);

    return step.play;
  }, [update]);

  const continueWatching = useCallback(() => update(WATCHING), [update]);

  return useMemo(
    () => ({ watching, countdownEnded, continueWatching, done: close }),
    [watching, countdownEnded, continueWatching, close],
  );
}
