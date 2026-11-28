import type { SessionPhase } from "./session-phase";

/**
 * Whether the downloads show in place of the server: no; because the person chose them while the
 * server failed; or because the server stayed silent as the app opened with downloads here.
 */
export type Offline = "no" | "chosen" | "silent";

/** Whether the server has yet to say who is signed in: the phase loads, or shows a saved answer. */
export const waitsForServer = (phase: SessionPhase): boolean =>
  phase.kind === "loading" || (phase.kind === "ready" && phase.saved);

/** Whether `phase` is the server's word on who is signed in, or that no one is. */
export const isServersAnswer = (phase: SessionPhase): boolean =>
  phase.kind === "signedOut" ||
  phase.kind === "createOwner" ||
  phase.kind === "setup" ||
  (phase.kind === "ready" && !phase.saved);

/** What the app knows of the server and this phone, for whether it shows the downloads. */
export interface LaunchView {
  /** The server has said who is signed in, or that no one is, since the app opened. */
  readonly heard: boolean;
  /** The server has not said who is signed in yet: the splash shows, or the saved Home. */
  readonly waiting: boolean;
  /** This phone holds a download ready to play for the person signed in here. */
  readonly hasDownloads: boolean;
  /** The downloads list is the screen on top. */
  readonly onDownloadsList: boolean;
  readonly offline: Offline;
}

/**
 * Whether the app is waiting out the server's silence at launch, after which it opens on the
 * downloads (D11). A server that answered once this launch never sends the app there.
 */
export const waitsToOpenDownloads = (view: LaunchView): boolean =>
  !view.heard && view.waiting && view.hasDownloads && view.offline === "no";

/**
 * Whether to leave the downloads the server's silence opened, now that it answered: only from
 * the list itself, since leaving remounts the screens and would close a download or its player.
 */
export const returnsHome = (view: LaunchView): boolean =>
  view.offline === "silent" && view.heard && view.onDownloadsList;
