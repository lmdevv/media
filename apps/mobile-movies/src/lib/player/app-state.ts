/**
 * What the player does with its media server stream as the app moves between the foreground and
 * the background. The media service runs only a few transcodes at once, so a stream must not hold
 * one while nobody watches: the app may stay in the background for hours, or be killed there
 * without running any more code, so the stream stops as the app goes.
 */

/** The app's state as React Native's `AppState` reports it. */
export type AppStatus = "active" | "background" | "inactive" | "unknown" | "extension";

/** What the player holds on the media server. */
export type HeldStream =
  /** Nothing to stop: a kept download, direct play of the file, or no start yet. */
  | "none"
  /** A stream the media service runs for this player, or one being negotiated. */
  | "server";

/** What the player does after the app's state changed. */
export type AppStateStep =
  /** Stop the server stream at once and remember where playback was. */
  | "park"
  /** Back in the foreground after parking: start again where playback was, with a new start. */
  | "return"
  | "stay";

/**
 * The step for the app's new state `status`. Only `background` parks: `inactive` (Control Center,
 * an incoming call's banner) keeps playing. A parked player returns on the next `active`.
 */
export const appStateStep = (
  status: AppStatus,
  player: { readonly parked: boolean; readonly holds: HeldStream },
): AppStateStep => {
  if (player.parked) return status === "active" ? "return" : "stay";

  return status === "background" && player.holds === "server" ? "park" : "stay";
};
