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
 * What one connection has learned of its server. The core's socket and the calls on it speak only
 * for the core; whether the media server answers comes from its health checks and the player's
 * streams. Each observation carries its evidence, a number taken when its request left or its
 * event happened. A doubt stands until evidence newer than it settles it: a check sent after it,
 * or for a doubt about the core, the core answering again.
 */
export interface Reachability {
  /** Health checks unanswered in a row since the media server last answered. */
  readonly failures: number;
  /** When the socket closed or a call stalled, unless the core answered since; null for none. */
  readonly coreDoubt: number | null;
  /** When a request to the media service went unanswered, unless a check settled it since. */
  readonly mediaDoubt: number | null;
  /** The evidence of the newest check or stream answer applied; older ones change nothing. */
  readonly checked: number;
  /** The evidence of the newest observation of the core applied. */
  readonly core: number;
}

/** What one request or event said of the server. */
export type Observation =
  /** The media server answered: a health check, or a stream that plays again. */
  | "answered"
  /** A health check went unanswered. */
  | "failed"
  /** A hint the media server went away, which a check settles: a request to it went unanswered. */
  | "doubted"
  /** The core answered: its socket opened, or a call got its answer. */
  | "coreAnswered"
  /** A hint the core went away, which its answer or a check settles: the socket closed, a call stalled. */
  | "coreDoubted";

/** Where every connection starts: the server answers until something says otherwise. */
export const ANSWERING: Reachability = {
  failures: 0,
  coreDoubt: null,
  mediaDoubt: null,
  checked: 0,
  core: 0,
};

const settledBy = (doubt: number | null, evidence: number): number | null =>
  doubt !== null && doubt <= evidence ? null : doubt;

/** `state` after `observation`, made at `evidence`; unchanged for evidence it already outdated. */
export const observe = (
  state: Reachability,
  observation: Observation,
  evidence: number,
): Reachability => {
  if (observation === "coreAnswered" || observation === "coreDoubted") {
    if (evidence <= state.core) return state;

    return {
      ...state,
      core: evidence,
      coreDoubt: observation === "coreDoubted" ? evidence : null,
    };
  }

  if (evidence <= state.checked) return state;

  if (observation === "doubted") return { ...state, mediaDoubt: evidence };

  return {
    ...state,
    failures: observation === "answered" ? 0 : state.failures + 1,
    checked: evidence,
    coreDoubt: settledBy(state.coreDoubt, evidence),
    mediaDoubt: settledBy(state.mediaDoubt, evidence),
  };
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
 * How often the app checks while the core's socket is closed: nothing reaches the app over it then,
 * so a server that goes away meanwhile shows only in a check.
 */
export const CLOSED_RECHECK_MS = 10_000;

/**
 * In how many milliseconds the app checks the server's health on its own, or null for no check:
 * never while nothing waits on the server; `SETTLE_MS` after a doubt; `RECHECK_MS` after each
 * unanswered check, until the media server answers one; and `CLOSED_RECHECK_MS` while the core's
 * socket is not open. With the socket open and the server answering it checks nothing: the socket
 * closing, a call stalling, or a request to the media service going unanswered each brings a
 * doubt.
 * `needed` says whether anything waits on the server: the app is on screen, or it plays the
 * server's queue, which goes on with songs from the server.
 */
export const nextCheck = (
  state: Reachability,
  needed: boolean,
  socketOpen: boolean,
): number | null => {
  if (!needed) return null;

  if (state.coreDoubt !== null || state.mediaDoubt !== null) return SETTLE_MS;

  if (state.failures > 0) return RECHECK_MS;

  return socketOpen ? null : CLOSED_RECHECK_MS;
};
