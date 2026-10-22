/**
 * `AudioOutput` on expo-audio: one `AudioPlayer` (an AVPlayer) per opened stream. expo-audio also
 * owns the audio session's reactions: a call or Siri pauses the players and resumes them after,
 * and unplugged headphones pause them. Those pauses reach the engine as status changes.
 */
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import type { AudioMetadata, AudioStatus } from "expo-audio";

import type { AudioOutput, LockScreenInfo, OutputControl, OutputStatus } from "./native-engine";

/** How often a playing player reports its position. */
const STATUS_INTERVAL_MS = 250;

let session: Promise<void> | null = null;

/**
 * Configures the audio session once, before the first play: audio plays with the ringer off and
 * in the background, and pauses other apps' audio, as the lock screen controls require. Without
 * a confirmed mode, iOS pauses playback within a second of the app leaving the screen.
 */
const audioSession = (): Promise<void> => {
  session ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
  }).catch(() => {
    // The session keeps its default mode, so playback still works while the app is open; the
    // next play asks again rather than staying without background audio.
    session = null;
  });

  return session;
};

const controlOf = (status: AudioStatus): OutputControl => {
  if (status.timeControlStatus === "playing") return "playing";

  return status.timeControlStatus === "waitingToPlayAtSpecifiedRate" ? "waiting" : "paused";
};

const outputStatus = (status: AudioStatus): OutputStatus => ({
  loaded: status.isLoaded,
  control: controlOf(status),
  positionMs: status.currentTime * 1000,
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

  // A player that stays active between songs keeps the app running in the background while the
  // next one starts; AirPlay still routes through the session.
  const player = createAudioPlayer(
    { uri: url },
    {
      updateInterval: STATUS_INTERVAL_MS,
      keepAudioSessionActive: true,
      allowsExternalPlayback: false,
    },
  );

  let wantsPlay = false;
  let released = false;
  // AVPlayer drops a play at the end of an item while a seek back is in flight (repeat one).
  let seeking: Promise<void> = Promise.resolve();

  return {
    play: () => {
      wantsPlay = true;

      const start = async (): Promise<void> => {
        await Promise.all([audioSession(), seeking]);

        if (wantsPlay && !released) player.play();
      };

      void start();
    },
    pause: () => {
      wantsPlay = false;
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
        listener(outputStatus(status));
      });

      return () => {
        subscription.remove();
      };
    },
    release: () => {
      released = true;
      player.remove();
    },
  };
};
