import type { NowPlayingControls } from "@media/player/playback-controller";
import { requireNativeModule } from "expo";
import type { EventEmitter } from "expo";

import type { LockScreenInfo, NativeEngine } from "./native-engine";

const remoteCommands =
  requireNativeModule<EventEmitter<{ nextTrack: () => void; previousTrack: () => void }>>(
    "RemoteCommands",
  );

const nothingToStop = (): void => {};

const listenForTrackCommands = (handlers: {
  readonly next: () => void;
  readonly previous: () => void;
}): (() => void) => {
  const subscriptions = [
    remoteCommands.addListener("nextTrack", () => {
      handlers.next();
    }),
    remoteCommands.addListener("previousTrack", () => {
      handlers.previous();
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
 * The lock screen, Control Center, headphones, and CarPlay. expo-audio routes play, pause, and
 * scrubbing to the playing AVPlayer itself, which the engine sees as status changes. Next and
 * previous come from the `RemoteCommands` module and go to the controller's handlers. The cover
 * shown is the URL the controller passes: a downloaded song's file when this phone holds one, so
 * it shows without the server.
 */
export const lockScreenControls = (engine: NativeEngine): NowPlayingControls => {
  let shown: LockScreenInfo | null = null;
  let stopListening = nothingToStop;

  return {
    setHandlers: (handlers) => {
      stopListening();
      stopListening = handlers === null ? nothingToStop : listenForTrackCommands(handlers);
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
