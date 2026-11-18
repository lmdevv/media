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

/** What decides whether the app asks the server whether it answers. */
export interface ProbeInputs {
  /** The app is on screen. */
  readonly active: boolean;
  /** This phone plays audio, which iOS keeps running in the background. */
  readonly audible: boolean;
}

/**
 * Whether the app keeps asking the server whether it answers: on screen, and in the background
 * while audio plays, so an outage met with the phone in a pocket still moves the player to the
 * downloaded songs.
 */
export const probesReach = ({ active, audible }: ProbeInputs): boolean => active || audible;
