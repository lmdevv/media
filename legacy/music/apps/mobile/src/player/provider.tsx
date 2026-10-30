/**
 * The player screens build on. `PlayerProvider` registers this iPhone as one of the user's
 * devices, plays the Convex playback session here while it is the active device, mirrors it while
 * another device plays, and moves playback between devices. Without the server it plays its own
 * session over the downloads, and hands it back when the server answers (`SessionRouter`). The protocol and the decisions live
 * in `PlaybackController` from `@music/player`, shared with the web; this file only adapts it to
 * React Native and to the contract in `player-api.md`.
 */
import type { DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type { DeviceKind, PlaybackState } from "@music/commands/models";
import { PlaybackController } from "@music/player/playback-controller";
import { SessionRouter, systemClock } from "@music/player/session-router";
import type { SessionStore } from "@music/player/session-router";
import { localFirst, streamSources } from "@music/player/source-resolver";
import type { StreamQuality } from "@music/player/stream-quality";
import { makeMusicClient } from "@music/sdk/client";
import { useRead } from "@music/sdk/react";
import { useConvex } from "convex/react";
import type { ConvexReactClient } from "convex/react";
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

import { convexConnection } from "./convex-connection";
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
  sameSong,
  statusOf,
} from "./player-state";
import type { NowPlaying, PlayerRole, PlayerStatus, PlayerView } from "./player-state";
import { idleTransfer, nextTransfer, TRANSFER_TIMEOUT_MS } from "./transfer";
import type { Transfer } from "./transfer";
import { useLocalCopies, useSessionStore } from "../downloads";
import type { DownloadedCopies } from "../downloads";
import { mediaUrl, resolveMediaUrl } from "../lib/media-url";
import type { ServerOrigin } from "../lib/server";
import { useServerReach } from "../session/server-reach";

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

const SongContext = createContext<NowPlaying | null>(null);

const OwnSessionContext = createContext(false);

const SessionRunContext = createContext<SessionRouter["run"] | null>(null);

const PositionReaderContext = createContext<(() => number) | null>(null);

const required = <Value,>(value: Value | null, hook: string): Value => {
  if (value === null) throw new Error(`${hook} must be used inside PlayerProvider`);

  return value;
};

/** The whole player. Re-renders on every change but the position; prefer the narrower hooks. */
export const usePlayer = (): PlayerView => required(use(PlayerContext), "usePlayer");

/** The song, the status, and where it plays. Changes only when one of them does. */
export const useNowPlaying = (): NowPlayingView =>
  required(use(NowPlayingContext), "useNowPlaying");

/** The song alone, for what doesn't show the status or the role. Changes only when the song does. */
export const useSong = (): NowPlaying | null => use(SongContext);

/**
 * The live position, updated four times a second. Only components that call it re-render with
 * it: Now Playing's scrubber and the mini player's progress.
 */
export const usePlaybackPosition = (): PlaybackPosition => use(PositionContext);

/**
 * A stable function that returns the live position in milliseconds, worked out afresh on every
 * call: between the engine's reports it moves on with a monotonic clock while this phone plays,
 * and runs on from the last report while another device plays. For frame loops that follow
 * playback closely, such as synced lyrics; it never re-renders its caller.
 */
export const usePositionReader = (): (() => number) =>
  required(use(PositionReaderContext), "usePositionReader");

/** The player's actions. Stable for the provider's lifetime, so it never re-renders a caller. */
export const usePlayerActions = (): PlayerActions =>
  required(use(ActionsContext), "usePlayerActions");

/**
 * Whether the session plays on this phone's own copy of it, as it does without the server, until it
 * is handed back. Changes only when that does.
 */
export const useOwnSession = (): boolean => use(OwnSessionContext);

/** The user's devices and a move between them. */
export const useDevices = (): DevicesView => required(use(DevicesContext), "useDevices");

/**
 * Runs a command where the session plays: on the server, or on this phone while it plays its own
 * session offline. Unlike the actions it rejects with the failure, for a sheet that keeps a
 * refusal on screen. Stable for the provider's lifetime.
 */
export const useSessionRun = (): SessionRouter["run"] =>
  required(use(SessionRunContext), "useSessionRun");

/** The controller of this iPhone, with its identity. Built once per server. */
interface Phone {
  readonly controller: PlaybackController;
  /** Where every playback and queue command goes: the server, or this phone's own session. */
  readonly session: SessionRouter;
  readonly id: DeviceId;
  readonly name: string;
}

const createPhone = (
  convex: ConvexReactClient,
  origin: ServerOrigin,
  copies: DownloadedCopies,
  store: SessionStore,
  inJam: () => boolean,
): Phone => {
  const client = makeMusicClient(convex);
  const engine = new NativeEngine(openExpoOutput);
  const id = loadPhoneId();
  const name = phoneName();

  const session = new SessionRouter({
    client,
    connection: convexConnection(convex),
    store,
    device: { id, name, kind: "phone" },
    playable: (trackId) => copies.find(trackId)?.track ?? null,
    clock: systemClock,
    random: Math.random,
    inJam,
  });

  // A downloaded song plays from its file, online too; anything else streams.
  const sources = localFirst(
    copies,
    streamSources(client, { now: Date.now, resolveUrl: (url) => mediaUrl(origin, url) }),
    session,
  );

  const controller = new PlaybackController(
    session,
    sources,
    { mse: null, create: () => engine },
    {
      deviceId: id,
      device: { name, kind: "phone" },
      canPlay: playsOnIos,
      now: Date.now,
      monotonicNow: () => performance.now(),
      quality: loadQuality(),
      saveQuality,
      nowPlaying: lockScreenControls(
        engine,
        (track) => copies.find(track.id)?.artUri ?? resolveMediaUrl(origin, track.artUrl),
      ),
      onForeground,
    },
  );

  return { controller, session, id, name };
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
  const { controller, session } = phone;
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

        if (picked !== undefined) await run(session.run("queue.add", { trackIds: [picked] }));

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
    next: () => run(session.run("playback.next", {})),
    previous: () => run(session.run("playback.previous", {})),
    seek: (positionMs) => controller.seek(positionMs),
    jump: (itemId) => run(session.run("playback.jump", { itemId })),
    setShuffle: (on) => run(session.run("playback.shuffle", { on })),
    cycleRepeat: () =>
      run(
        session.run("playback.repeat", { mode: nextRepeat(latest.current.state?.repeat ?? "off") }),
      ),
    setAutoplay: (on) => run(session.run("queue.autoplay", { on })),
    setVolume: (volume) => controller.setVolume(volume),
    playNext: (trackIds) => run(session.run("queue.add", { trackIds, next: true })),
    playLater: (trackIds) => run(session.run("queue.add", { trackIds })),
    removeFromQueue: (itemId) => run(session.run("queue.remove", { itemId })),
    moveInQueue: async (itemId, toIndex) => {
      const args = moveArgs(latest.current.state?.queue ?? [], itemId, toIndex);

      if (args !== null) await run(session.run("queue.move", args));
    },
    clearQueue: () => run(session.run("queue.clear", {})),
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
  const copies = useLocalCopies();
  const store = useSessionStore();
  // Whether the account is in a Jam, as the server last said; the router reads it when it decides.
  const inJam = useRef(false);

  const phone = useMemo(
    () => createPhone(convex, origin, copies, store, () => inJam.current),
    [convex, origin, copies, store],
  );

  const { controller, session } = phone;

  // Separate subscriptions, so a position report re-runs only the small one. Convex delivers a
  // client's subscriptions from one database snapshot, so the two always agree.
  const position = useRead("playback.position", {});
  const queue = useRead("queue.list", {});
  const jam = useRead("jam.get", {}) ?? null;

  useLayoutEffect(() => {
    inJam.current = jam?.status === "active";
  }, [jam]);
  const devices = useRead("devices.list", { deviceId: phone.id });

  const served = useMemo(
    () => (position === undefined || queue === undefined ? undefined : { ...position, ...queue }),
    [position, queue],
  );

  // A launch that never reached the server plays this phone's own session from the start.
  const offline = useServerReach() === "offline";

  useEffect(() => session.start(), [session]);

  useEffect(() => {
    if (served !== undefined) session.offerServer(served);
  }, [session, served]);

  useEffect(() => {
    if (offline) void session.startLocal();
  }, [session, offline]);

  // The session the router says plays: the server's, or this phone's own while it is offline.
  const { state, mode } = useSyncExternalStore(session.subscribe, session.getSnapshot);
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

  const entry = state?.queue[state.index] ?? null;

  const latestSong = useMemo(
    () => (entry === null ? null : nowPlayingOf(entry, origin, copies.find(entry.id)?.artUri)),
    [entry, origin, copies],
  );

  // Every session update brings a new entry; only one that changes the song may reach its readers.
  const [nowPlaying, setNowPlaying] = useState(latestSong);

  if (!sameSong(nowPlaying, latestSong)) setNowPlaying(latestSong);

  const items = useMemo(
    () =>
      (state?.queue ?? []).map((queued) =>
        queueItemOf(queued, origin, copies.find(queued.id)?.artUri),
      ),
    [state?.queue, origin, copies],
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
  const readPosition = useMemo(() => () => controller.positionMs(), [controller]);

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
    <SessionRunContext value={session.run}>
      <PositionReaderContext value={readPosition}>
        <ActionsContext value={actions}>
          <DevicesContext value={deviceList}>
            <PlayerContext value={player}>
              <NowPlayingContext value={current}>
                <SongContext value={nowPlaying}>
                  <OwnSessionContext value={mode === "local"}>
                    <PositionTicker
                      controller={controller}
                      durationMs={nowPlaying?.durationMs ?? 0}
                    >
                      {children}
                    </PositionTicker>
                  </OwnSessionContext>
                </SongContext>
              </NowPlayingContext>
            </PlayerContext>
          </DevicesContext>
        </ActionsContext>
      </PositionReaderContext>
    </SessionRunContext>
  );
}
