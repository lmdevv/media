import type { NowPlayingControls } from "@media/player/playback-controller";
import { requireNativeModule } from "expo";
import type { EventEmitter } from "expo";

import type { LockScreenInfo, NativeEngine } from "./native-engine";

const remoteCommands = requireNativeModule<
  EventEmitter<{
    nextTrack: () => void;
    previousTrack: () => void;
    seekTo: (event: { readonly positionMs: number }) => void;
  }>
>("RemoteCommands");

/** What the controller's handlers for the system's media controls do. */
type SystemHandlers = NonNullable<Parameters<NowPlayingControls["setHandlers"]>[0]>;

const nothingToStop = (): void => {};

const listenForCommands = (
  handlers: Pick<SystemHandlers, "next" | "previous" | "seekTo">,
): (() => void) => {
  const subscriptions = [
    remoteCommands.addListener("nextTrack", () => {
      handlers.next();
    }),
    remoteCommands.addListener("previousTrack", () => {
      handlers.previous();
    }),
    remoteCommands.addListener("seekTo", ({ positionMs }) => {
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
 * The lock screen, Control Center, headphones, and CarPlay. expo-audio routes play and pause to
 * the playing AVPlayer itself; the engine sees each as a change it did not ask for and reports it
 * to the controller as the person's own action (`system`). Next, previous, and scrubbing come from
 * the `RemoteCommands` module and go to the controller's handlers, so every one of them reaches
 * the controller's listener boundary, as a tap does. expo-audio moves the AVPlayer for a scrub
 * too, and the controller's seek then lands on the same place. The cover shown is the URL the
 * controller passes: a downloaded song's file when this phone holds one, so it shows without the
 * server.
 */
export const lockScreenControls = (engine: NativeEngine): NowPlayingControls => {
  let shown: LockScreenInfo | null = null;
  let stopListening = nothingToStop;

  return {
    setHandlers: (handlers) => {
      stopListening();
      stopListening = handlers === null ? nothingToStop : listenForCommands(handlers);
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
