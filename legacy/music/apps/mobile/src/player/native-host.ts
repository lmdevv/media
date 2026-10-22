/**
 * What `PlaybackController` needs from the iPhone: its device identity, the saved quality, the
 * lock screen, and the app's return to the foreground.
 */
import type { DeviceId } from "@music/commands/ids";
import type { Track } from "@music/commands/models";
import { loadDeviceId, readItem, writeItem } from "@music/player/device-identity";
import type { KeyValueStorage } from "@music/player/device-identity";
import type { NowPlayingControls } from "@music/player/playback-controller";
import type { StreamQuality } from "@music/player/stream-quality";
import { requireNativeModule } from "expo";
import type { EventEmitter } from "expo";
import { randomUUID } from "expo-crypto";
import { deviceName, modelName } from "expo-device";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import type { NativeEngine } from "./native-engine";
import { parseQuality } from "./player-state";
import { resolveMediaUrl } from "../lib/media-url";
import type { ServerOrigin } from "../lib/server";

const QUALITY_KEY = "music.streamQuality";

/** The keychain, read and written synchronously: the controller needs its device ID at once. */
const storage: KeyValueStorage = {
  getItem: (key) => SecureStore.getItem(key),
  setItem: (key, value) => {
    SecureStore.setItem(key, value);
  },
};

/** This phone's stable device ID, made on first use and kept in the keychain. */
export const loadPhoneId = (): DeviceId => loadDeviceId(storage, randomUUID);

/**
 * How this phone names itself in the device list: its name in Settings where iOS shares it, else
 * the model ("iPhone 17").
 */
export const phoneName = (): string => deviceName ?? modelName ?? "iPhone";

export const loadQuality = (): StreamQuality => parseQuality(readItem(storage, QUALITY_KEY));

export const saveQuality = (quality: StreamQuality): void => {
  writeItem(storage, QUALITY_KEY, quality);
};

/** Calls `listener` each time the app comes back to the screen. */
export const onForeground = (listener: () => void): (() => void) => {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") listener();
  });

  return () => {
    subscription.remove();
  };
};

/** Presses of next and previous from outside the app, from `modules/remote-commands`. */
const remoteCommands =
  requireNativeModule<EventEmitter<{ nextTrack: () => void; previousTrack: () => void }>>(
    "RemoteCommands",
  );

const nothingToStop = (): void => {};

/** Sends next and previous presses to `handlers` until the returned function runs. */
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

/**
 * The lock screen, Control Center, headphones, and CarPlay. expo-audio routes play, pause, and
 * scrubbing to the playing AVPlayer itself, which the engine sees as status changes. Next and
 * previous come from the `RemoteCommands` module and go to the controller's handlers, which ask
 * the server to move the queue.
 */
export const lockScreenControls = (
  engine: NativeEngine,
  origin: ServerOrigin,
): NowPlayingControls => {
  let shown: Track | null = null;
  let stopListening = nothingToStop;

  return {
    setHandlers: (handlers) => {
      stopListening();
      stopListening = handlers === null ? nothingToStop : listenForTrackCommands(handlers);
    },
    show: (track) => {
      if (track?.id === shown?.id && track?.title === shown?.title) return;
      shown = track;

      engine.setLockScreen(
        track === null
          ? null
          : {
              title: track.title,
              artist: track.artist,
              album: track.album,
              artworkUrl: resolveMediaUrl(origin, track.artUrl),
            },
      );
    },
  };
};
