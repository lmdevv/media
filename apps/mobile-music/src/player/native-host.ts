import type { NowPlayingControls } from "@media/player/playback-controller";

import type { LockScreenInfo, NativeEngine } from "./native-engine";

/**
 * The events of the app's `RemoteCommands` module (`modules/remote-commands`). A type, not an
 * interface, so it fits expo's `EventEmitter`, which takes a record of events.
 */
export type RemoteCommandEvents = {
  /** The play command, sent once expo-audio played the AVPlayer for it. */
  readonly play: () => void;
  /** The pause command, sent once expo-audio paused the AVPlayer for it. */
  readonly pause: () => void;
  /** The play/pause toggle, sent once expo-audio played or paused the AVPlayer for it. */
  readonly togglePlayPause: () => void;
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
    commands.addListener("play", () => {
      handlers.play();
    }),
    commands.addListener("pause", () => {
      handlers.pause();
    }),
    // expo-audio played or paused the AVPlayer for the toggle before the module sent it, so what
    // the player does now is what the person chose.
    commands.addListener("togglePlayPause", () => {
      if (engine.nativelyPlaying()) handlers.play();
      else handlers.pause();
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
 * player's new state, which a song's end shares. `commands` reports each command, and the unplug,
 * as it came, so every one reaches the controller's handlers and its listener boundary as a tap
 * does: play and pause as asked, never a toggle of what plays by then, and an unplug as a pause of
 * a song meant to play. The controller's seek lands on the place expo-audio moved the AVPlayer to.
 * The cover shown is the URL the controller passes: a downloaded song's file when this phone holds
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
