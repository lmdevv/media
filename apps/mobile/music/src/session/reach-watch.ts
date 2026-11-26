import type { ConnectionState } from "@media/sdk/promise";

import { ANSWERING, isLost, nextCheck, observe } from "@/lib/server-reach";
import type { Observation, Reachability } from "@/lib/server-reach";

/** How long after an unanswered check the next one goes, so the app notices the server back soon. */
export const RECHECK_MS = 3000;

/**
 * How long a call may wait for its answer with the socket open before the server is doubted: one
 * that stopped answering without closing the socket shows only this way, or after Convex's own
 * 60 second silence check.
 */
export const STALL_MS = 5000;

/** The timers a watch sets, as `setTimeout` and `clearTimeout`. */
export interface WatchTimers {
  readonly after: (ms: number, run: () => void) => () => void;
  /** Milliseconds since the Unix epoch, the clock the socket's `waitingSince` reads. */
  readonly now: () => number;
}

/** The global timers and clock. */
const systemTimers: WatchTimers = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);

    return () => {
      clearTimeout(timer);
    };
  },
  now: () => Date.now(),
};

/**
 * Whether one connection's server answers, learned from what the app hears anyway and from health
 * checks sent only when there is something to decide: after a doubt or an unanswered check, while
 * something needs the server, and when the app asks (`check`), as on coming back on screen.
 * Identity: it belongs to one connection; once `close`d, nothing it hears or any check's answer
 * changes it. Within it, a check's answer applies only when no newer evidence has (`observe`).
 */
export interface ReachWatch {
  /** Calls `listener` whenever `lost` changes; returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Whether the server counts as gone (`isLost`). */
  readonly lost: () => boolean;
  /** Checks the server's health now; resolves whether it answered. */
  readonly check: () => Promise<boolean>;
  /** Takes in what another request said, such as a stream that failed or came back. */
  readonly hear: (observation: Observation) => void;
  /** Takes in how the core's socket stands, from the platform client. */
  readonly connection: (state: ConnectionState) => void;
  /** Says whether anything waits on the server: the app on screen, or the server's queue playing. */
  readonly need: (needed: boolean) => void;
  /** Lets go of the connection: nothing changes the watch after. */
  readonly close: () => void;
}

/** A `ReachWatch` whose health check is `answers`. */
export const reachWatch = (
  answers: () => Promise<boolean>,
  timers: WatchTimers = systemTimers,
): ReachWatch => {
  const listeners = new Set<() => void>();
  let state: Reachability = ANSWERING;
  let evidence = 0;
  /** The evidence of the newest check sent; its answer settles anything older. */
  let sent = 0;
  let needed = false;
  let closed = false;
  let socket: ConnectionState = { connected: false, waitingSince: null };
  let cancelRecheck: (() => void) | null = null;
  let cancelStall: (() => void) | null = null;

  const stamp = (): number => {
    evidence += 1;

    return evidence;
  };

  const apply = (observation: Observation, at: number): void => {
    if (closed) return;
    const wasLost = isLost(state);

    state = observe(state, observation, at);
    follow();

    if (isLost(state) !== wasLost) for (const listener of listeners) listener();
  };

  const check = async (): Promise<boolean> => {
    if (closed) return false;
    const at = stamp();

    sent = at;
    cancelRecheck?.();
    cancelRecheck = null;
    const answered = await answers();

    apply(answered ? "answered" : "failed", at);

    return answered;
  };

  /** Sends the check `nextCheck` calls for, unless one sent after the newest evidence is out. */
  function follow(): void {
    const due = nextCheck(state, needed);

    if (due !== "soon" || closed) {
      cancelRecheck?.();
      cancelRecheck = null;
    }

    if (closed || due === "none" || sent > state.newest) return;

    if (due === "now") {
      void check();

      return;
    }

    cancelRecheck ??= timers.after(RECHECK_MS, () => {
      cancelRecheck = null;
      void check();
    });
  }

  const watchStall = (): void => {
    cancelStall?.();
    cancelStall = null;
    const { connected, waitingSince } = socket;

    if (closed || !connected || waitingSince === null) return;

    cancelStall = timers.after(Math.max(0, waitingSince + STALL_MS - timers.now()), () => {
      cancelStall = null;

      if (socket.connected && socket.waitingSince === waitingSince) apply("doubted", stamp());
    });
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    lost: () => isLost(state),
    check,
    hear: (observation) => {
      apply(observation, stamp());
    },
    connection: (next) => {
      const was = socket;

      socket = next;

      if (next.connected && !was.connected) apply("answered", stamp());
      else if (!next.connected && was.connected) apply("doubted", stamp());
      // The oldest call waiting got its answer: the server answers.
      else if (
        next.connected &&
        was.waitingSince !== null &&
        next.waitingSince !== was.waitingSince
      )
        apply("answered", stamp());

      watchStall();
    },
    need: (next) => {
      if (next === needed) return;
      needed = next;
      follow();
    },
    close: () => {
      closed = true;
      cancelRecheck?.();
      cancelStall?.();
      cancelRecheck = null;
      cancelStall = null;
      listeners.clear();
    },
  };
};
