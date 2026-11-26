/** How the app stands with its server. */
export type ServerReach =
  | "online"
  /** The server hasn't answered since launch: the app opened on the downloads (D11). */
  | "offline"
  /** The server answered this launch, then went away; Convex calls it again on its own (G04, D14). */
  | "reconnecting";

/** What the reach is read from. */
export interface ReachInputs {
  /** The app opened without the server (the `offline` phase). */
  readonly offlinePhase: boolean;
  /** The socket has been down past the grace, after it was up this launch. */
  readonly socketLost: boolean;
  /** A request has waited past the grace with the socket up. */
  readonly stalled: boolean;
}

/** The reach for screens and for the notice. */
export interface Reach {
  /** From the socket alone: a busy server, such as one mid-scan, still answers. */
  readonly reach: ServerReach;
  /**
   * Also reconnecting while a request waits: a server that stops answering without closing the
   * socket only shows as a closed socket after Convex's 60 second silence check.
   */
  readonly notice: ServerReach;
}

/** Where the app stands with its server, from the phase and the connection. */
export const reachOf = ({ offlinePhase, socketLost, stalled }: ReachInputs): Reach => {
  const reach = offlinePhase ? "offline" : socketLost ? "reconnecting" : "online";

  return { reach, notice: reach === "online" && stalled ? "reconnecting" : reach };
};

/** How many health checks in a row must go unanswered before the server counts as gone. */
export const LOST_AFTER = 2;

/**
 * What one connection has learned of its server: from the requests the app makes anyway (the
 * core's socket, the calls on it, the player's streams) and from the health checks it sends when
 * it must decide. Each observation carries its evidence, a number taken when its request left or
 * its event happened; evidence older than the newest applied changes nothing, so the answer to a
 * check a later check or event replaced is dropped.
 */
export interface Reachability {
  /** Health checks unanswered in a row since the server last answered. */
  readonly failures: number;
  /** The socket closed, a call stalled, or a stream failed since the server last answered. */
  readonly doubted: boolean;
  /** The newest evidence applied. */
  readonly newest: number;
}

/** What one request or event said of the server. */
export type Observation =
  /** It answered: a health check, the socket opening, a call's answer. */
  | "answered"
  /** A health check went unanswered. */
  | "failed"
  /** A hint that it went away, which a health check settles. */
  | "doubted";

/** Where every connection starts: the server answers until something says otherwise. */
export const ANSWERING: Reachability = { failures: 0, doubted: false, newest: 0 };

/** `state` after `observation`, made at `evidence`; unchanged for evidence older than its newest. */
export const observe = (
  state: Reachability,
  observation: Observation,
  evidence: number,
): Reachability => {
  if (evidence <= state.newest) return state;

  if (observation === "answered") return { failures: 0, doubted: false, newest: evidence };

  if (observation === "failed") {
    return { failures: state.failures + 1, doubted: false, newest: evidence };
  }

  return { ...state, doubted: true, newest: evidence };
};

/** Whether the server counts as gone: `LOST_AFTER` health checks in a row went unanswered. */
export const isLost = (state: Reachability): boolean => state.failures >= LOST_AFTER;

/**
 * How long after a doubt the app checks the server, so a socket that drops and opens again at
 * once, as after the phone slept, settles it without a check.
 */
export const SETTLE_MS = 1000;

/** How long after an unanswered check the next one goes, so the app notices the server back soon. */
export const RECHECK_MS = 3000;

/**
 * How often the app checks while the core's socket is closed: the core can't tell it then that the
 * media server went away.
 */
export const CLOSED_RECHECK_MS = 10_000;

/**
 * In how many milliseconds the app checks the server's health on its own, or null for no check:
 * never while nothing waits on the server; `SETTLE_MS` after a doubt; and `RECHECK_MS` after each
 * unanswered check, until it answers. `needed` says whether anything waits on the server: the app
 * is on screen, or it plays the server's queue, which goes on with songs from the server.
 */
export const nextCheck = (state: Reachability, needed: boolean): number | null => {
  if (!needed) return null;

  if (state.doubted) return SETTLE_MS;

  return state.failures > 0 ? RECHECK_MS : null;
};
