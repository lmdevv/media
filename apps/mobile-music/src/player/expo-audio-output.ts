import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioMetadata, AudioStatus } from "expo-audio";

import type { AudioOutput, LockScreenInfo, OutputControl, OutputStatus } from "./native-engine";

const STATUS_INTERVAL_MS = 250;

let session: Promise<void> | null = null;

const audioSession = (): Promise<void> => {
  session ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
  }).catch(() => {
    session = null;
  });

  return session;
};

const controlOf = (status: AudioStatus): OutputControl => {
  if (status.timeControlStatus === "playing") return "playing";

  return status.timeControlStatus === "waitingToPlayAtSpecifiedRate" ? "waiting" : "paused";
};

const outputStatus = (status: AudioStatus, currentTime: number): OutputStatus => ({
  loaded: status.isLoaded,
  control: controlOf(status),
  // expo-audio reports an end at the item's length, even once a seek has moved the player back.
  positionMs:
    (status.didJustFinish && Number.isFinite(currentTime) ? currentTime : status.currentTime) *
    1000,
  // expo-audio reports an unknown length (a live transcode) as 0.
  durationMs: status.isLoaded && status.duration > 0 ? status.duration * 1000 : null,
  finished: status.didJustFinish,
  error: status.error,
});

const lockScreenMetadata = (info: LockScreenInfo): AudioMetadata => {
  const metadata: AudioMetadata = {
    title: info.title,
    artist: info.artist,
    albumTitle: info.album,
  };

  if (info.artworkUrl !== null) metadata.artworkUrl = info.artworkUrl;

  return metadata;
};

/** Opens `url` on a new expo-audio player, paused. */
export const openExpoOutput = (url: string): AudioOutput => {
  void audioSession();

  const player = createAudioPlayer(
    { uri: url },
    {
      updateInterval: STATUS_INTERVAL_MS,
      keepAudioSessionActive: true,
      allowsExternalPlayback: false,
    },
  );

  let wantsPlay = false;
  let starting = false;
  let measuredMs = 0;
  let released = false;
  let seeking: Promise<void> = Promise.resolve();

  return {
    samplePlayback: () => {
      const currentTime = player.currentTime;

      if (Number.isFinite(currentTime)) measuredMs = currentTime * 1000;

      return {
        positionMs: measuredMs,
        control: starting ? "waiting" : controlOf(player.currentStatus),
      };
    },
    play: () => {
      wantsPlay = true;
      starting = true;

      const start = async (): Promise<void> => {
        try {
          await Promise.all([audioSession(), seeking.catch(() => undefined)]);

          if (wantsPlay && !released) player.play();
        } finally {
          starting = false;
        }
      };

      void start();
    },
    pause: () => {
      wantsPlay = false;
      starting = false;
      player.pause();
    },
    seek: (positionMs) => {
      seeking = player.seekTo(positionMs / 1000);

      return seeking;
    },
    setVolume: (volume) => {
      player.volume = volume;
    },
    showOnLockScreen: (info, live) => {
      if (info === null) {
        player.setActiveForLockScreen(false);

        return;
      }

      player.setActiveForLockScreen(true, lockScreenMetadata(info), {
        showSeekForward: false,
        showSeekBackward: false,
        isLiveStream: live,
      });
    },
    subscribe: (listener) => {
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        listener(outputStatus(status, player.currentTime));
      });

      return () => {
        subscription.remove();
      };
    },
    release: () => {
      released = true;
      // `remove()` only forgets the player and leaves it playing until garbage collection;
      // `release()` stops it and frees it now.
      player.release();
    },
  };
};
