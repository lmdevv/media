import { useCallback, useEffect, useRef, useState } from "react";

import { describeFailure } from "@/lib/failure";

/** An action's state and the way to run it. */
export interface Task<Args extends ReadonlyArray<unknown>, A> {
  /** Runs the action; resolves with its result, or null when it failed or was already running. */
  readonly run: (...args: Args) => Promise<{ readonly value: A } | null>;
  readonly busy: boolean;
  /** The failure's line, until the next run. */
  readonly error: string | null;
  readonly clearError: () => void;
}

/**
 * Wraps `work` so a second press while it runs does nothing, the screen knows it is busy, and a
 * failure becomes a short line. State stops updating once the screen is gone.
 */
export const useTask = <Args extends ReadonlyArray<unknown>, A>(
  work: (...args: Args) => Promise<A>,
): Task<Args, A> => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(work);

  useEffect(() => {
    latest.current = work;
  });

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: Args): Promise<{ readonly value: A } | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError(null);

    try {
      return { value: await latest.current(...args) };
    } catch (cause) {
      if (mounted.current) setError(describeFailure(cause));

      return null;
    } finally {
      running.current = false;

      if (mounted.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { run, busy, error, clearError };
};
