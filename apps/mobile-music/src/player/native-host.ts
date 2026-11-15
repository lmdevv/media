import type { NowPlayingControls } from "@media/player/playback-controller";

import type { LockScreenInfo, NativeEngine } from "./native-engine";

interface Stamped {
  /** The press's number, taken as it came, from the sequence of `RemoteCommands.stamp`. */
  readonly stamp: number;
}

interface SystemPress extends Stamped {
  /**
   * The id of the player on the lock screen that the press acted on (`AudioOutput.id`), or null
   * when none was there.
   */
  readonly player: string | null;
}

interface SystemSeek extends SystemPress {
  /** Where expo-audio moved that player to, in the song. */
  readonly positionMs: number;
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
  readonly unplugged: (event: Stamped) => void;
  readonly nextTrack: (event: Stamped) => void;
  readonly previousTrack: (event: Stamped) => void;
  /** The scrubber, sent once expo-audio moved the player there. */
  readonly seekTo: (seek: SystemSeek) => void;
};

/** The app's `RemoteCommands` module, as the host listens to it. */
export interface RemoteCommands {
  readonly addListener: <Event extends keyof RemoteCommandEvents>(
    event: Event,
    listener: RemoteCommandEvents[Event],
  ) => { readonly remove: () => void };
  /** Takes the next number from the sequence the module stamps presses with. */
  readonly stamp: () => number;
}

type SystemHandlers = NonNullable<Parameters<NowPlayingControls["setHandlers"]>[0]>;

/**
 * Orders the system's presses against the person's own choices. The module stamps each press as
 * it comes, and the app takes a number from the same sequence as each choice starts
 * (`NowPlayingControls.commanded`), so both share one order though a press reaches JavaScript
 * later. A press applies only if it is newer than every choice so far. An older one means the
 * person chose again since, here or through Connect, and applies to nothing (ADR 0018). Presses
 * never order each other: the module sends them in the order they came, but a decided play or
 * pause one main-queue turn later than the rest.
 */
interface CommandOrder {
  /** Runs `apply` for the press stamped `stamp`, unless the person chose again after it. */
  readonly apply: (stamp: number, apply: () => void) => void;
  /**
   * A choice of the person's starts. One the controller starts while applying a press is that
   * press, which already has its stamp.
   */
  readonly commanded: () => void;
}

const commandOrder = (commands: RemoteCommands): CommandOrder => {
  let newest = 0;
  let applying = false;

  return {
    apply: (stamp, apply) => {
      if (stamp < newest) return;
      applying = true;

      try {
        apply();
      } finally {
        applying = false;
      }
    },
    commanded: () => {
      if (!applying) newest = commands.stamp();
    },
  };
};

const nothingToStop = (): void => {};

const listenForCommands = (
  engine: NativeEngine,
  commands: RemoteCommands,
  order: CommandOrder,
  handlers: SystemHandlers,
): (() => void) => {
  const subscriptions = [
    commands.addListener("play", ({ player, stamp }) => {
      if (!engine.isCurrentPlayer(player)) return;
      order.apply(stamp, () => {
        handlers.play();
      });
    }),
    commands.addListener("pause", ({ stamp }) => {
      order.apply(stamp, () => {
        handlers.pause();
      });
    }),
    // An unplug pauses a song meant to play, never what the person left paused or idle.
    commands.addListener("unplugged", ({ stamp }) => {
      if (!engine.meansToPlay()) return;
      order.apply(stamp, () => {
        handlers.pause();
      });
    }),
    commands.addListener("nextTrack", ({ stamp }) => {
      order.apply(stamp, () => {
        handlers.next();
      });
    }),
    commands.addListener("previousTrack", ({ stamp }) => {
      order.apply(stamp, () => {
        handlers.previous();
      });
    }),
    // A scrub moved its player, whatever the person chose since; a choice of another song replaced
    // that player.
    commands.addListener("seekTo", ({ player, positionMs }) => {
      if (engine.isCurrentPlayer(player)) handlers.seekTo(positionMs);
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
 * play. Each of these, and next and previous, applies only if the person made no choice after it,
 * and the scrubber while the player it moved holds the song (ADR 0018). The controller's seek
 * lands on the place expo-audio moved the AVPlayer to. The cover shown is the URL the controller passes: a downloaded song's
 * file when this phone holds one, so it shows without the server.
 */
export const lockScreenControls = (
  engine: NativeEngine,
  commands: RemoteCommands,
): NowPlayingControls => {
  const order = commandOrder(commands);
  let shown: LockScreenInfo | null = null;
  let stopListening = nothingToStop;

  return {
    setHandlers: (handlers) => {
      stopListening();
      stopListening =
        handlers === null ? nothingToStop : listenForCommands(engine, commands, order, handlers);
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
    commanded: order.commanded,
  };
};
