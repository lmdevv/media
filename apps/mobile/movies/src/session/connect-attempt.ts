import { useCallback, useRef, useState } from "react";

import type { ConnectFailure, ConnectResult, ServerConnection } from "@media/mobile-core/server";

import { useConnection } from "./connection";

/** A form's connect attempt. */
export interface ConnectAttempt {
  readonly busy: boolean;
  /** Why the last attempt failed, until `clearFailure` or the next attempt. */
  readonly failure: ConnectFailure | null;
  readonly clearFailure: () => void;
  /**
   * Runs `attempt` unless one is running or `filled` is false, and connects when it succeeds,
   * after `beforeConnect`. Resolves with the result, or null when the submit was ignored.
   */
  readonly run: (
    attempt: () => Promise<ConnectResult>,
    options: {
      readonly filled: boolean;
      readonly beforeConnect?: (connection: ServerConnection) => void;
    },
  ) => Promise<ConnectResult | null>;
}

/** A connect attempt for one form. */
export const useConnectAttempt = (): ConnectAttempt => {
  const { connect } = useConnection();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const running = useRef(false);

  const clearFailure = useCallback(() => setFailure(null), []);

  const run = useCallback<ConnectAttempt["run"]>(
    async (attempt, { filled, beforeConnect }) => {
      if (running.current || !filled) return null;
      running.current = true;
      setBusy(true);
      setFailure(null);

      try {
        const result = await attempt();

        if (result.ok) {
          beforeConnect?.(result.connection);
          connect(result.connection);
        } else {
          setFailure(result.failure);
        }

        return result;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [connect],
  );

  return { busy, failure, clearFailure, run };
};
