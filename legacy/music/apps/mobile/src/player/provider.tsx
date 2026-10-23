/**
 * The player screens build on. `PlayerProvider` registers this iPhone as one of the user's
 * devices, plays the Convex playback session here while it is the active device, mirrors it while
 * another device plays, and moves playback between devices. The protocol and the decisions live
 * in `PlaybackController` from `@music/player`, shared with the web; this file only adapts it to
 * React Native and to the contract in `player-api.md`.
 */
import type { DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type { DeviceKind, PlaybackState } from "@music/commands/models";
import { PlaybackController } from "@music/player/playback-controller";
import { serverSession } from "@music/player/session-router";
import { streamSources } from "@music/player/source-resolver";
import type { StreamQuality } from "@music/player/stream-quality";
import { makeMusicClient } from "@music/sdk/client";
import type { MusicClient } from "@music/sdk/client";
import { useRead } from "@music/sdk/react";
import { useConvex } from "convex/react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { openExpoOutput } from "./expo-audio-output";
import { NativeEngine } from "./native-engine";
import {
  loadPhoneId,
  loadQuality,
  lockScreenControls,
  onForeground,
  phoneName,
  saveQuality,
} from "./native-host";
import {
  isPlaying,
  moveArgs,
  nextRepeat,
  nowPlayingOf,
  playsOnIos,
  queueItemOf,
  roleOf,
  statusOf,
} from "./player-state";
import type { NowPlaying, PlayerRole, PlayerStatus, PlayerView } from "./player-state";
import { idleTransfer, nextTransfer, TRANSFER_TIMEOUT_MS } from "./transfer";
import type { Transfer } from "./transfer";
import { mediaUrl } from "../lib/media-url";
import type { ServerOrigin } from "../lib/server";

/** How often `usePlaybackPosition` updates. */
const POSITION_INTERVAL_MS = 250;

const REFUSED_MESSAGE = "Couldn't move playback there. Try again.";

/** What screens can ask the player to do. Actions never reject: failures show up in `error`. */
export interface PlayerActions {
  /** Replaces the queue with `trackIds` and plays them here from `index`. */
  readonly play: (trackIds: ReadonlyArray<TrackId>, index?: number) => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly toggle: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly previous: () => Promise<void>;
  readonly seek: (positionMs: number) => Promise<void>;
  /** Plays the queue entry `itemId`. */
  readonly jump: (itemId: QueueItemId) => Promise<void>;
  readonly setShuffle: (on: boolean) => Promise<void>;
  /** Off, all, one, and back to off. */
  readonly cycleRepeat: () => Promise<void>;
  readonly setAutoplay: (on: boolean) => Promise<void>;
  /** From 0 to 1. */
  readonly setVolume: (volume: number) => Promise<void>;
  /** Queues songs right after the current one. */
  readonly playNext: (trackIds: ReadonlyArray<TrackId>) => Promise<void>;
  /** Queues songs after the others the listener queued, before autoplay's. */
  readonly playLater: (trackIds: ReadonlyArray<TrackId>) => Promise<void>;
  readonly removeFromQueue: (itemId: QueueItemId) => Promise<void>;
  /** Moves the entry `itemId` to `toIndex` of `usePlayer().queue`. */
  readonly moveInQueue: (itemId: QueueItemId, toIndex: number) => Promise<void>;
  /** Clears everything after the current song. */
  readonly clearQueue: () => Promise<void>;
  /** Moves playback, queue, and position to another of the user's devices. */
  readonly transferTo: (deviceId: DeviceId) => Promise<void>;
  /** Moves playback to this iPhone. */
  readonly playHere: () => Promise<void>;
  /** Saves the streaming quality; it applies from the next song. */
  readonly setQuality: (quality: StreamQuality) => void;
  /** Loads the current song again from its position after playback failed (G06). */
  readonly retry: () => void;
}

/** One of the user's devices. */
interface DeviceEntry {
  readonly id: DeviceId;
  readonly name: string;
  readonly kind: DeviceKind;
  /** The session plays on it. */
  readonly active: boolean;
  /** It checked in recently. */
  readonly online: boolean;
  readonly lastSeenAt: number;
}

/** What `useDevices` returns. */
export interface DevicesView {
  readonly thisDevice: { readonly id: DeviceId; readonly name: string };
  /** Devices seen in the last day, this iPhone included. */
  readonly devices: ReadonlyArray<DeviceEntry>;
  /**
   * A move to another device. While pending, the session still names the device that plays; a
   * failed move left playback where it was.
   */
  readonly transfer: Transfer;
  /** Clears a failed move. */
  readonly dismissTransfer: () => void;
}

/** The song, the status, and where it plays: what the mini player and song rows need. */
export interface NowPlayingView {
  readonly nowPlaying: NowPlaying | null;
  readonly status: PlayerStatus;
  readonly role: PlayerRole;
}

/** The live position, and the length of the song it is in. */
export interface PlaybackPosition {
  readonly positionMs: number;
  readonly durationMs: number;
}

const PlayerContext = createContext<PlayerView | null>(null);

const NowPlayingContext = createContext<NowPlayingView | null>(null);

const PositionContext = createContext<PlaybackPosition>({ positionMs: 0, durationMs: 0 });

const ActionsContext = createContext<PlayerActions | null>(null);

const DevicesContext = createContext<DevicesView | null>(null);

const required = <Value,>(value: Value | null, hook: string): Value => {
  if (value === null) throw new Error(`${hook} must be used inside PlayerProvider`);

  return value;
};

/** The whole player. Re-renders on every change but the position; prefer the narrower hooks. */
export const usePlayer = (): PlayerView => required(use(PlayerContext), "usePlayer");

/** The song, the status, and where it plays. Changes only when one of them does. */
export const useNowPlaying = (): NowPlayingView =>
  required(use(NowPlayingContext), "useNowPlaying");

/**
 * The live position, updated four times a second. Only components that call it re-render with
 * it: Now Playing's scrubber and the mini player's progress.
 */
export const usePlaybackPosition = (): PlaybackPosition => use(PositionContext);

/** The player's actions. Stable for the provider's lifetime, so it never re-renders a caller. */
export const usePlayerActions = (): PlayerActions =>
  required(use(ActionsContext), "usePlayerActions");

/** The user's devices and a move between them. */
export const useDevices = (): DevicesView => required(use(DevicesContext), "useDevices");

/** The controller of this iPhone, with its identity. Built once per server. */
interface Phone {
  readonly controller: PlaybackController;
  readonly client: MusicClient;
  readonly id: DeviceId;
  readonly name: string;
}

const createPhone = (client: MusicClient, origin: ServerOrigin): Phone => {
  const engine = new NativeEngine(openExpoOutput);
  const id = loadPhoneId();
  const name = phoneName();

  const controller = new PlaybackController(
    serverSession(client),
    streamSources(client, { now: Date.now, resolveUrl: (url) => mediaUrl(origin, url) }),
    { mse: null, create: () => engine },
    {
      deviceId: id,
      device: { name, kind: "phone" },
      canPlay: playsOnIos,
      now: Date.now,
      quality: loadQuality(),
      saveQuality,
      nowPlaying: lockScreenControls(engine, origin),
      onForeground,
    },
  );

  return { controller, client, id, name };
};

/** What the actions read at the moment they run. */
interface Latest {
  readonly state: PlaybackState | undefined;
  readonly playing: boolean;
  readonly listeningAlong: boolean;
}

const createActions = (
  phone: Phone,
  latest: { readonly current: Latest },
  transfer: (event: Parameters<typeof nextTransfer>[1]) => void,
): PlayerActions => {
  const { controller, client } = phone;
  const run = controller.capture.bind(controller);

  const move = async (to: DeviceId): Promise<void> => {
    if (latest.current.state?.activeDevice?.id === to) return;
    transfer({ type: "start", to });
    const landed = await (to === phone.id ? controller.playHere() : controller.transferTo(to));

    if (!landed) {
      transfer({ type: "refused", to, message: controller.getSnapshot().error ?? REFUSED_MESSAGE });
    }
  };

  return {
    play: async (trackIds, index) => {
      // In someone else's Jam the host's queue plays: "play" adds the song tapped to it.
      if (latest.current.listeningAlong) {
        const picked = trackIds[index ?? 0];

        if (picked !== undefined) await run(client.run("queue.add", { trackIds: [picked] }));

        return;
      }

      await controller.playTracks(trackIds, index);
    },
    pause: async () => {
      if (latest.current.playing) await controller.togglePlay();
    },
    resume: async () => {
      if (!latest.current.playing) await controller.togglePlay();
    },
    toggle: () => controller.togglePlay(),
    next: () => run(client.run("playback.next", {})),
    previous: () => run(client.run("playback.previous", {})),
    seek: (positionMs) => controller.seek(positionMs),
    jump: (itemId) => run(client.run("playback.jump", { itemId })),
    setShuffle: (on) => run(client.run("playback.shuffle", { on })),
    cycleRepeat: () =>
      run(
        client.run("playback.repeat", { mode: nextRepeat(latest.current.state?.repeat ?? "off") }),
      ),
    setAutoplay: (on) => run(client.run("queue.autoplay", { on })),
    setVolume: (volume) => controller.setVolume(volume),
    playNext: (trackIds) => run(client.run("queue.add", { trackIds, next: true })),
    playLater: (trackIds) => run(client.run("queue.add", { trackIds })),
    removeFromQueue: (itemId) => run(client.run("queue.remove", { itemId })),
    moveInQueue: async (itemId, toIndex) => {
      const args = moveArgs(latest.current.state?.queue ?? [], itemId, toIndex);

      if (args !== null) await run(client.run("queue.move", args));
    },
    clearQueue: () => run(client.run("queue.clear", {})),
    transferTo: move,
    playHere: () => move(phone.id),
    setQuality: (quality) => {
      controller.setQuality(quality);
    },
    retry: () => {
      controller.retry();
    },
  };
};

/** Re-renders only the position's consumers, four times a second. */
function PositionTicker({
  controller,
  durationMs,
  children,
}: {
  readonly controller: PlaybackController;
  readonly durationMs: number;
  readonly children: ReactNode;
}) {
  const [positionMs, setPositionMs] = useState(() => Math.round(controller.positionMs()));

  useEffect(() => {
    const timer = setInterval(() => {
      setPositionMs(Math.round(controller.positionMs()));
    }, POSITION_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [controller]);

  const position = useMemo(() => ({ positionMs, durationMs }), [positionMs, durationMs]);

  return <PositionContext value={position}>{children}</PositionContext>;
}

/**
 * Provides the player hooks. Mount it inside the signed-in Convex provider. `origin` is the
 * server the app connected to (`ServerConnection.origin`): media URLs resolve against it.
 */
export function PlayerProvider({
  origin,
  children,
}: {
  readonly origin: ServerOrigin;
  readonly children: ReactNode;
}) {
  const convex = useConvex();
  const phone = useMemo(() => createPhone(makeMusicClient(convex), origin), [convex, origin]);
  const { controller } = phone;

  // Separate subscriptions, so a position report re-runs only the small one. Convex delivers a
  // client's subscriptions from one database snapshot, so the two always agree.
  const position = useRead("playback.position", {});
  const queue = useRead("queue.list", {});
  const jam = useRead("jam.get", {}) ?? null;
  const devices = useRead("devices.list", { deviceId: phone.id });

  const state = useMemo(
    () => (position === undefined || queue === undefined ? undefined : { ...position, ...queue }),
    [position, queue],
  );

  const local = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => controller.start(), [controller]);

  useEffect(() => {
    if (state !== undefined) controller.sync(state);
  }, [controller, state]);

  const active = state?.activeDevice ?? null;
  const activeId = active?.id ?? null;
  const activeName = active?.name ?? null;
  const activeKind = active?.kind ?? null;

  const role = useMemo(
    () =>
      roleOf(
        activeId === null || activeName === null || activeKind === null
          ? null
          : { id: activeId, name: activeName, kind: activeKind },
        phone.id,
      ),
    [activeId, activeName, activeKind, phone.id],
  );

  const entry = queue?.queue[queue.index] ?? null;

  const nowPlaying = useMemo(
    () => (entry === null ? null : nowPlayingOf(entry, origin)),
    [entry, origin],
  );

  const items = useMemo(
    () => (queue?.queue ?? []).map((queued) => queueItemOf(queued, origin)),
    [queue, origin],
  );

  const status = statusOf(state, local, role);
  const playing = isPlaying(state, local, role);
  const listeningAlong = jam?.role === "member" && jam.status === "active";

  const player = useMemo(
    (): PlayerView => ({
      status,
      role,
      nowPlaying,
      queue: items,
      index: state?.index ?? 0,
      shuffle: state?.shuffle ?? false,
      repeat: state?.repeat ?? "off",
      autoplay: state?.autoplay ?? true,
      volume: local.pendingVolume ?? state?.volume ?? 1,
      error: local.error,
      quality: local.quality,
      following: state?.following ?? false,
    }),
    [status, role, nowPlaying, items, state, local],
  );

  const current = useMemo(
    (): NowPlayingView => ({ nowPlaying, status, role }),
    [nowPlaying, status, role],
  );

  const latest = useRef<Latest>({ state, playing, listeningAlong });

  // Updated right after the commit, before another touch can run an action on stale state.
  useLayoutEffect(() => {
    latest.current = { state, playing, listeningAlong };
  }, [state, playing, listeningAlong]);

  const [transfer, dispatchTransfer] = useReducer(nextTransfer, idleTransfer);

  useEffect(() => {
    dispatchTransfer({ type: "session", activeId });
  }, [activeId]);

  useEffect(() => {
    if (transfer.state !== "pending") return undefined;
    const { to } = transfer;

    const timer = setTimeout(() => {
      dispatchTransfer({ type: "timeout", to });
    }, TRANSFER_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [transfer]);

  const actions = useMemo(() => createActions(phone, latest, dispatchTransfer), [phone]);

  const deviceList = useMemo(
    (): DevicesView => ({
      thisDevice: { id: phone.id, name: phone.name },
      devices: (devices ?? []).map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind,
        active: device.id === activeId,
        online: device.online,
        lastSeenAt: device.lastSeenAt,
      })),
      transfer,
      dismissTransfer: () => {
        dispatchTransfer({ type: "dismiss" });
      },
    }),
    [phone, devices, activeId, transfer],
  );

  return (
    <ActionsContext value={actions}>
      <DevicesContext value={deviceList}>
        <PlayerContext value={player}>
          <NowPlayingContext value={current}>
            <PositionTicker controller={controller} durationMs={nowPlaying?.durationMs ?? 0}>
              {children}
            </PositionTicker>
          </NowPlayingContext>
        </PlayerContext>
      </DevicesContext>
    </ActionsContext>
  );
}
