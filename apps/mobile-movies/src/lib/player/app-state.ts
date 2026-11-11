/**
 * When the player's media server stream may run while the app is away. The media service runs only
 * three transcodes, so a stream nobody watches must not hold one: the app may stay in the
 * background for hours, or be killed there without running any more code. A stream someone still
 * watches or hears, in Picture in Picture or as background audio, keeps its slot.
 */

/** The app's state as React Native's `AppState` reports it. */
export type AppStatus = "active" | "background" | "inactive" | "unknown" | "extension";

/** What the player holds on the media server. */
export type HeldStream =
  /** Nothing to stop: a kept download, direct play of the file, or no stream yet. */
  | "none"
  /** A stream the media service runs for this player, or one being negotiated. */
  | "server";

/** What the player does after an event. */
export type LifecycleStep =
  /** Stop the server stream at once and remember where playback was. */
  | "stop"
  /** Back in the foreground after a stop or a deferred start: start again, with a new start. */
  | "restart"
  /** The start answered while the app is in front: negotiate its first stream. */
  | "negotiate"
  /** The start answered while the app is away: open no stream until the app comes back. */
  | "defer"
  | "none";

/** Whether `status` puts the app in the background; `inactive` (Control Center, a call banner) does not. */
const inBackground = (status: AppStatus): boolean => status === "background";

/**
 * The player's stream lifecycle as the app moves between the foreground and the background, Picture
 * in Picture opens and closes, and playback plays and pauses. Each event returns what the player
 * does. Pure: the controller calls the server and the player.
 */
export class StreamLifecycle {
  #foreground: boolean;
  #pictureInPicture = false;
  #playing: boolean;
  /** The stream was stopped, or the start deferred, while the app was away. */
  #parked = false;
  #closed = false;

  /**
   * @param background - Whether the app is in the background as the player opens, from
   *   `AppState.currentState`.
   * @param playing - Whether playback is meant to play from the start.
   */
  constructor(background: boolean, playing: boolean) {
    this.#foreground = !background;
    this.#playing = playing;
  }

  /** Whether the stream is stopped, or the start deferred, until the app comes back. */
  get parked(): boolean {
    return this.#parked;
  }

  /** Nobody watches or hears the stream: the app is away, with no Picture in Picture or sound. */
  #unwatched(): boolean {
    return !this.#foreground && !this.#pictureInPicture && !this.#playing;
  }

  #settle(holds: HeldStream): LifecycleStep {
    if (this.#closed) return "none";

    if (this.#parked) {
      if (!this.#foreground) return "none";
      this.#parked = false;

      return "restart";
    }

    if (holds === "server" && this.#unwatched()) {
      this.#parked = true;

      return "stop";
    }

    return "none";
  }

  /** The app's state changed. */
  appState(status: AppStatus, holds: HeldStream): LifecycleStep {
    this.#foreground = !inBackground(status);

    return this.#settle(holds);
  }

  /** Picture in Picture opened or closed. */
  pictureInPicture(active: boolean, holds: HeldStream): LifecycleStep {
    this.#pictureInPicture = active;

    return this.#settle(holds);
  }

  /** Playback started playing, or paused or ended. */
  playing(playing: boolean, holds: HeldStream): LifecycleStep {
    this.#playing = playing;

    return this.#settle(holds);
  }

  /**
   * The start (`movies.play.start`) answered. A player already closed does nothing with it; one
   * whose app is away defers its stream until the app comes back. A start opens no stream, so a
   * deferred one leaves nothing running; its ticket lapses unused.
   */
  started(): LifecycleStep {
    if (this.#closed) return "none";

    if (!this.#foreground) {
      this.#parked = true;

      return "defer";
    }

    return "negotiate";
  }

  /** The player closed: every later event does nothing. */
  close(): void {
    this.#closed = true;
  }
}
