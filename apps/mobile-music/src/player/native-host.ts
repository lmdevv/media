import type { NowPlayingControls } from "@media/player/playback-controller";

import type { LockScreenInfo, NativeEngine } from "./native-engine";

interface SystemPress {
  /**
   * The id of the player on the lock screen that the press acted on (`AudioOutput.id`), or null
   * when none was there.
   */
  readonly player: string | null;
}

/**
 * The events of the app's `RemoteCommands` module (`modules/remote-commands`). A type, not an
 * interface, so it fits expo's `EventEmitter`, which takes a record of events.
 */
export type RemoteCommandEvents = {
  /** A press that played the player, sent once expo-audio played it. */
  readonly play: (press: SystemPress) => void;
  /** A press that paused the player, sent once expo-audio paused it. */
  readonly pause: (press: SystemPress) => void;
  /** Headphones unplugged, or another output gone, after which expo-audio paused every player. */
  readonly unplugged: () => void;
  readonly nextTrack: () => void;
  readonly previousTrack: () => void;
  /** The scrubber, at a position in the song. */
  readonly seekTo: (event: { readonly positionMs: number }) => void;
};

/** The app's `RemoteCommands` module, as the host listens to it. */
export interface RemoteCommands {
  readonly addListener: <Event extends keyof RemoteCommandEvents>(
    event: Event,
    listener: RemoteCommandEvents[Event],
  ) => { readonly remove: () => void };
}

type SystemHandlers = NonNullable<Parameters<NowPlayingControls["setHandlers"]>[0]>;

const nothingToStop = (): void => {};

const listenForCommands = (
  engine: NativeEngine,
  commands: RemoteCommands,
  handlers: SystemHandlers,
): (() => void) => {
  const subscriptions = [
    commands.addListener("play", ({ player }) => {
      if (engine.isCurrentPlayer(player)) handlers.play();
    }),
    commands.addListener("pause", () => {
      handlers.pause();
    }),
    // An unplug pauses a song meant to play, never what the person left paused or idle.
    commands.addListener("unplugged", () => {
      if (engine.meansToPlay()) handlers.pause();
    }),
    commands.addListener("nextTrack", () => {
      handlers.next();
    }),
    commands.addListener("previousTrack", () => {
      handlers.previous();
    }),
    commands.addListener("seekTo", ({ positionMs }) => {
      handlers.seekTo(positionMs);
    }),
  ];

  return () => {
    for (const subscription of subscriptions) subscription.remove();
  };
};

const sameInfo = (a: LockScreenInfo | null, b: LockScreenInfo | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album &&
    a.artworkUrl === b.artworkUrl);

/**
 * The lock screen, Control Center, headphones, and CarPlay. expo-audio plays, pauses, and scrubs
 * the AVPlayer itself, and pauses it when headphones are unplugged, but tells the app only of the
 * player's new state, which a song's end shares. `commands` reports each play and pause as the
 * module decided it when the press came, a toggle included, and the unplug, and each reaches the
 * controller's handlers and its listener boundary as a tap does: a play while the player it acted
 * on still holds the song, a pause whatever plays, and an unplug as a pause of a song meant to
 * play (ADR 0018). The controller's seek lands on the place expo-audio moved the AVPlayer to. The
 * cover shown is the URL the controller passes: a downloaded song's file when this phone holds
 * one, so it shows without the server.
 */
export const lockScreenControls = (
  engine: NativeEngine,
  commands: RemoteCommands,
): NowPlayingControls => {
  let shown: LockScreenInfo | null = null;
  let stopListening = nothingToStop;

  return {
    setHandlers: (handlers) => {
      stopListening();
      stopListening =
        handlers === null ? nothingToStop : listenForCommands(engine, commands, handlers);
    },
    show: (track) => {
      const info =
        track === null
          ? null
          : {
              title: track.title,
              artist: track.artist,
              album: track.album,
              artworkUrl: track.artUrl,
            };

      if (sameInfo(info, shown)) return;
      shown = info;
      engine.setLockScreen(info);
    },
  };
};
