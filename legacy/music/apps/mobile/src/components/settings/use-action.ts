/**
 * The pending and failure state of a screen's mutations: one runs at a time, a rejection shows the
 * server's message, and the form stays as it was so the person can retry.
 */
import { errorMessage } from "@music/sdk/errors";
import { useRef, useState } from "react";

/** What a screen reads to show a running mutation and its failure. */
export interface Action {
  readonly pending: boolean;
  /** The last failure's message, cleared when the next run starts. */
  readonly failure: string | null;
  /** Runs `task` unless one is already running. */
  readonly run: (task: () => Promise<void>) => void;
}

/** Pending and failure state for the mutations a screen runs one at a time. */
export const useAction = (): Action => {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const perform = async (task: () => Promise<void>) => {
    running.current = true;
    setPending(true);
    setFailure(null);

    try {
      await task();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  return {
    pending,
    failure,
    run: (task) => {
      if (!running.current) void perform(task);
    },
  };
};
