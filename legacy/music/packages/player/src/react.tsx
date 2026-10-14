/**
 * The player contract the web app builds on. `PlayerProvider` mirrors the user's Convex playback
 * session, plays audio when this browser is the active device, and reports position back.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type { Device, RepeatMode, Track } from "@music/commands/models";
import { makeMusicClient } from "@music/sdk/client";
import { useRead } from "@music/sdk/react";
import { useConvex } from "convex/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { describeDevice, loadDeviceId, readItem, writeItem } from "./device-identity";
import type { EngineKind, PlayerEngine } from "./engine";
import { HtmlAudioEngine } from "./html-audio-engine";
import { MseEngine } from "./mse-engine";
import { PlaybackController } from "./playback-controller";
import type { EngineFactory } from "./playback-controller";
import { parseStreamQuality } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";

/** How often `usePlayerPosition` updates. */
const POSITION_INTERVAL_MS = 250;

const QUALITY_KEY = "music.streamQuality";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

export interface PlayerState {
  readonly status: PlayerStatus;
  readonly track: Track | null;
  readonly queue: ReadonlyArray<Track>;
  readonly index: number;
  readonly durationMs: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  readonly volume: number;
  /** This browser's device ID, stable per browser profile. */
  readonly deviceId: DeviceId | null;
  /** The device that outputs audio, or null when none is chosen. */
  readonly activeDevice: Device | null;
  /** True when this browser outputs the audio. */
  readonly isThisDevice: boolean;
  /** False when the media service cannot be reached; browsing still works. */
  readonly mediaOnline: boolean;
  readonly error: string | null;
  /** The streaming quality setting, saved per browser. */
  readonly quality: StreamQuality;
  /**
   * True when the browser refused to start audio without a tap, usually right after playback
   * moved here from another device. `error` then reads "Tap play to start here"; `togglePlay`
   * starts it.
   */
  readonly autoplayBlocked: boolean;
  /**
   * The engine that plays here, for diagnostics: `mse` is the sample-accurate gapless engine,
   * `html` the HTML audio fallback (data saver, browsers without MSE, or after the MSE engine
   * failed on a song this session).
   */
  readonly engine: EngineKind;
}

export interface PlayerActions {
  /** Replaces the queue and plays it on this browser. */
  readonly playTracks: (trackIds: ReadonlyArray<TrackId>, index?: number) => Promise<void>;
  readonly togglePlay: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly previous: () => Promise<void>;
  readonly seek: (positionMs: number) => Promise<void>;
  readonly jump: (index: number) => Promise<void>;
  readonly setShuffle: (on: boolean) => Promise<void>;
  readonly setRepeat: (mode: RepeatMode) => Promise<void>;
  readonly setVolume: (volume: number) => Promise<void>;
  readonly addToQueue: (trackIds: ReadonlyArray<TrackId>, next?: boolean) => Promise<void>;
  /** Removes the song at `index`; resolves whether the removal landed (a failure sets `error`). */
  readonly removeFromQueue: (index: number) => Promise<boolean>;
  /** Moves playback to this browser. */
  readonly playHere: () => Promise<void>;
  readonly transferTo: (deviceId: DeviceId) => Promise<void>;
  /** Changes the streaming quality. It applies from the next song. */
  readonly setQuality: (quality: StreamQuality) => void;
}

export type Player = PlayerState & PlayerActions;

const PlayerContext = createContext<Player | null>(null);

const PositionContext = createContext<number>(0);

/**
 * The player state and actions. Must be inside `PlayerProvider`. Actions never reject: server
 * failures show up in `error`.
 */
export const usePlayer = (): Player => {
  const player = useContext(PlayerContext);

  if (player === null) throw new Error("usePlayer must be used inside PlayerProvider");

  return player;
};

/** The live position in milliseconds. Separate from `usePlayer` because it changes often. */
export const usePlayerPosition = (): number => useContext(PositionContext);

/**
 * The engines the provider switches between. A fixed `engine` disables the switching (and is
 * reported as `html`); otherwise the gapless MSE engine plays where the browser supports it.
 */
const engineFactory = (
  engine: (() => PlayerEngine) | undefined,
  audioElement: (() => HTMLAudioElement) | undefined,
): EngineFactory => {
  if (engine !== undefined) return { mse: null, create: engine };

  return {
    mse: MseEngine.detectSupport(),
    create: (kind) =>
      kind === "mse"
        ? new MseEngine(audioElement?.() ?? new Audio())
        : new HtmlAudioEngine(audioElement),
  };
};

/** Builds the controller from browser globals. Runs once per provider mount. */
const createController = (
  convex: ReturnType<typeof useConvex>,
  engines: EngineFactory,
): PlaybackController => {
  const storage = "localStorage" in globalThis ? localStorage : null;
  const probe = document.createElement("audio");

  return new PlaybackController(makeMusicClient(convex), engines, {
    deviceId: loadDeviceId(storage, () => crypto.randomUUID()),
    device: describeDevice(navigator.userAgent, navigator.maxTouchPoints),
    canPlay: (mimeType) => probe.canPlayType(mimeType) !== "",
    now: Date.now,
    quality: parseStreamQuality(readItem(storage, QUALITY_KEY)),
    saveQuality: (quality) => {
      writeItem(storage, QUALITY_KEY, quality);
    },
  });
};

/** Re-renders only its position consumers, about four times a second. */
function PositionTicker({
  controller,
  children,
}: {
  readonly controller: PlaybackController;
  readonly children: ReactNode;
}) {
  const [position, setPosition] = useState(() => Math.round(controller.positionMs()));

  useEffect(() => {
    const timer = setInterval(() => {
      setPosition(Math.round(controller.positionMs()));
    }, POSITION_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [controller]);

  return <PositionContext.Provider value={position}>{children}</PositionContext.Provider>;
}

/**
 * Provides `usePlayer` and `usePlayerPosition`. Place it inside the Convex provider of a signed-in
 * user. It registers this browser as a device, plays audio while this browser is the session's
 * active device, and stops the moment another device takes over.
 */
export function PlayerProvider({
  children,
  engine,
  audioElement,
}: {
  readonly children: ReactNode;
  /**
   * Builds a fixed audio engine once per mount, replacing the automatic choice between the
   * gapless MSE engine and HTML audio. Pass a stable function.
   */
  readonly engine?: () => PlayerEngine;
  /**
   * Makes the audio elements the built-in engines play through, for example to route output
   * through Web Audio. Pass a stable function.
   */
  readonly audioElement?: () => HTMLAudioElement;
}) {
  const convex = useConvex();

  const controller = useMemo(
    () => createController(convex, engineFactory(engine, audioElement)),
    [convex, engine, audioElement],
  );

  // The position and the queue are separate subscriptions, so a position report re-runs only the
  // small one. Convex delivers every subscription of a client from one database snapshot, so the
  // two always agree.
  const position = useRead("playback.position", {});
  const queue = useRead("queue.list", {});

  const state = useMemo(
    () => (position === undefined || queue === undefined ? undefined : { ...position, ...queue }),
    [position, queue],
  );

  const local = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => controller.start(), [controller]);

  useEffect(() => {
    if (state !== undefined) controller.sync(state);
  }, [controller, state]);

  const player = useMemo((): Player => {
    const track = state?.queue[state.index] ?? null;
    const isThisDevice = state?.activeDevice?.id === controller.deviceId;
    const playing = local.pendingPlaying ?? state?.playing ?? false;
    const client = makeMusicClient(convex);

    const localStatus = (): PlayerStatus => {
      if (track === null) return "idle";

      return local.engineStatus === "idle" ? "loading" : local.engineStatus;
    };

    const remoteStatus = (): PlayerStatus => {
      if (track === null) return "idle";

      return playing ? "playing" : "paused";
    };

    const status = (): PlayerStatus => {
      if (state === undefined) return "loading";

      return isThisDevice ? localStatus() : remoteStatus();
    };

    return {
      status: status(),
      track,
      queue: state?.queue ?? [],
      index: state?.index ?? 0,
      durationMs: track?.durationMs ?? 0,
      shuffle: state?.shuffle ?? false,
      repeat: state?.repeat ?? "off",
      volume: local.pendingVolume ?? state?.volume ?? 1,
      deviceId: controller.deviceId,
      activeDevice: state?.activeDevice ?? null,
      isThisDevice,
      mediaOnline: local.mediaOnline,
      error: local.error,
      quality: local.quality,
      autoplayBlocked: local.autoplayBlocked,
      engine: local.engine,
      playTracks: (ids, index) => controller.playTracks(ids, index),
      togglePlay: () => controller.togglePlay(),
      next: () => controller.capture(client.run("playback.next", {})),
      previous: () => controller.capture(client.run("playback.previous", {})),
      seek: (positionMs) => controller.seek(positionMs),
      jump: (index) => controller.capture(client.run("playback.jump", { index })),
      setShuffle: (on) => controller.capture(client.run("playback.shuffle", { on })),
      setRepeat: (mode) => controller.capture(client.run("playback.repeat", { mode })),
      setVolume: (volume) => controller.setVolume(volume),
      addToQueue: (ids, toFront) =>
        controller.capture(
          client.run(
            "queue.add",
            toFront === undefined ? { trackIds: ids } : { trackIds: ids, next: toFront },
          ),
        ),
      removeFromQueue: (index) => controller.attempt(client.run("queue.remove", { index })),
      playHere: () => controller.playHere(),
      transferTo: (deviceId) => controller.transferTo(deviceId),
      setQuality: (quality) => {
        controller.setQuality(quality);
      },
    };
  }, [state, local, controller, convex]);

  return (
    <PlayerContext.Provider value={player}>
      <PositionTicker controller={controller}>{children}</PositionTicker>
    </PlayerContext.Provider>
  );
}
