import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { pagedStore } from "@media/ui/lib/pages";
import { Brand } from "effect";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import {
  browserResume,
  browserSettings,
  browserStorage,
  saveBrowserQuality,
  saveBrowserVolume,
} from "./browser-storage";
import { devicePosition } from "./connect-devices";
import type { Device } from "./connect-devices";
import type { EngineKind, PlayerEngine } from "./engine";
import { HtmlAudioEngine } from "./html-audio-engine";
import { setMediaSessionHandlers, showNowPlaying } from "./media-session";
import { MseEngine } from "./mse-engine";
import { PlaybackController } from "./playback-controller";
import type { EngineFactory, PlayerSettings, QueueEntry, QueueState } from "./playback-controller";
import { queueStateOf, useQueueListing } from "./queue-listing";
import type { QueueRow } from "./queue-listing";
import { nextIndex, previousIndex } from "./queue-order";
import type { RepeatMode } from "./queue-order";
import { ticketSources } from "./source-resolver";
import { qualityOfSetting, settingOfQuality } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";
import { asDeviceId, useConnect } from "./use-connect";
import type { ConnectView, MusicItem } from "./use-connect";

export type { Device, DevicePlayback } from "./connect-devices";

export type { MusicItem } from "./use-connect";

const POSITION_INTERVAL_MS = 250;

/** Wait this long after the last volume change before saving it. */
const VOLUME_SAVE_MS = 500;

/** A song as the music commands answer it. */
export type Track = Awaited<ReturnType<PlatformSdk["music"]["tracks"]["get"]>>;

/** One queue entry as the UI shows it: its song, its own id, and whether autoplay added it. */
export interface QueueTrack extends Track {
  readonly itemId: QueueRow["itemId"];
  readonly autoplay: boolean;
}

/** What the player is doing: nothing queued, loading a song, playing, paused, waiting, or failed. */
export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

/** The player as the UI shows it: the queue from the core merged with this browser's audio. */
export interface PlayerState {
  readonly status: PlayerStatus;
  readonly track: QueueTrack | null;
  /** Every entry, in play order. */
  readonly queue: ReadonlyArray<QueueTrack>;
  /** Where `track` is in `queue`; 0 for an empty queue. */
  readonly index: number;
  readonly durationMs: number;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  /** Whether autoplay adds similar songs when the queue runs out. */
  readonly autoplay: boolean;
  readonly volume: number;
  /** False when the media server cannot be reached; browsing still works. */
  readonly mediaOnline: boolean;
  readonly error: string | null;
  /** The streaming quality setting, kept per device. */
  readonly quality: StreamQuality;
  /**
   * True when the browser refused to start audio without a tap. `error` then reads "Tap play to
   * start here"; `togglePlay` starts it.
   */
  readonly autoplayBlocked: boolean;
  /**
   * The engine that plays here, for diagnostics: `mse` is the sample-accurate gapless engine,
   * `html` the HTML audio fallback (data saver, gapless off, browsers without MSE, or after the
   * MSE engine failed on a song this session).
   */
  readonly engine: EngineKind;
  /** This browser's device; null until the core says, or for a session on no device. */
  readonly deviceId: string | null;
  /** The listener's other own devices that are online, by name (ADR 0018). */
  readonly devices: ReadonlyArray<Device>;
  /**
   * Another of the listener's devices that plays the queue while nothing plays here, as old music's
   * active device. While it is set, `status`, the position, play, pause, seek, and skips follow and
   * control it, and playing a list here takes playback back from it. Null while playback is here
   * or nowhere.
   */
  readonly remote: Device | null;
  /** Whether a song is loaded here, playing or paused. */
  readonly here: boolean;
}

/** What the UI can ask the player to do. Actions never reject: failures become `error`. */
export interface PlayerActions {
  /** Replaces the queue and plays it on this browser. */
  readonly playTracks: (trackIds: ReadonlyArray<Track["id"]>, index?: number) => Promise<void>;
  /**
   * Primes the audio output inside a tap whose playback starts after an await, so iOS Safari
   * allows it. Call it before the first await; `playTracks` primes by itself when it comes first.
   */
  readonly primeOutput: () => void;
  readonly togglePlay: () => Promise<void>;
  readonly next: () => Promise<void>;
  readonly previous: () => Promise<void>;
  /** Seeks at once; resolves at once, as every action can be awaited. */
  readonly seek: (positionMs: number) => Promise<void>;
  /** Plays a queue entry. */
  readonly jump: (itemId: QueueTrack["itemId"]) => Promise<void>;
  readonly setShuffle: (on: boolean) => Promise<void>;
  readonly setRepeat: (mode: RepeatMode) => Promise<void>;
  /** Sets the volume at once and saves it on this device; resolves at once. */
  readonly setVolume: (volume: number) => Promise<void>;
  /**
   * Adds songs to the queue, after the current song when `next` is set; resolves whether they all
   * landed. A failure sets `error` and is never sent again blindly, since an add may have landed:
   * the queue shows what did.
   */
  readonly addToQueue: (trackIds: ReadonlyArray<Track["id"]>, next?: boolean) => Promise<boolean>;
  /** Removes the entry `itemId`; resolves whether the removal landed (a failure sets `error`). */
  readonly removeFromQueue: (itemId: QueueTrack["itemId"]) => Promise<boolean>;
  readonly setAutoplay: (on: boolean) => Promise<void>;
  /** Changes the streaming quality. It applies from the next song. */
  readonly setQuality: (quality: StreamQuality) => void;
  /**
   * Moves playback from the device the player follows to this browser at the same place in the
   * song (`core.connect.targets.move`), as old music's "Play here" did. Call it inside the tap, so
   * the browser lets the song start. Resolves whether the core took it.
   */
  readonly moveHere: () => Promise<boolean>;
  /**
   * Moves playback to another of the listener's devices at the same place in the song, from this
   * browser or the device the player follows, as old music's transfer did; with nothing playing
   * anywhere it plays the current song there from where it stands here. Resolves whether the core
   * took it.
   */
  readonly moveTo: (deviceId: string) => Promise<boolean>;
  /**
   * Plays a song or an album on another device (`core.connect.targets.load`), which takes playback
   * over, as old music's play on a chosen device made it the active one: this browser stops, or
   * the device the player followed pauses. Resolves whether the core took it.
   */
  readonly playOn: (deviceId: string, item: MusicItem) => Promise<boolean>;
}

/** The player state and actions that `usePlayer` returns. */
export type Player = PlayerState & PlayerActions;

const PlayerContext = createContext<Player | null>(null);

const PositionContext = createContext<number>(0);

/** The song that plays and what the player does with it: the slice a long song list needs. */
export interface CurrentTrack {
  readonly trackId: Track["id"] | null;
  readonly status: PlayerStatus;
}

const CurrentTrackContext = createContext<CurrentTrack>({ trackId: null, status: "idle" });

const HasTrackContext = createContext(false);

/** Reads the player when it is needed (in an event handler) without re-rendering on its changes. */
interface PlayerReaders {
  readonly player: () => Player;
  readonly positionMs: () => number;
}

const ReadersContext = createContext<PlayerReaders | null>(null);

const useReaders = (): PlayerReaders => {
  const readers = useContext(ReadersContext);

  if (readers === null) throw new Error("Player readers must be used inside PlayerProvider");

  return readers;
};

/**
 * The player state and actions. Must be inside `PlayerProvider`. Actions never reject: failures
 * show up in `error`.
 */
export const usePlayer = (): Player => {
  const player = useContext(PlayerContext);

  if (player === null) throw new Error("usePlayer must be used inside PlayerProvider");

  return player;
};

/** The live position in milliseconds. Separate from `usePlayer` because it changes often. */
export const usePlayerPosition = (): number => useContext(PositionContext);

/**
 * The current song's ID and the player status, which change far less often than the rest of the
 * player. Long lists use it to mark the playing row without re-rendering every row on each change.
 */
export const useCurrentTrack = (): CurrentTrack => useContext(CurrentTrackContext);

/**
 * Whether a song is loaded. Changes only when the queue goes from empty to not, for chrome (the
 * player bar's frame, the shell's surfaces) that shows or hides with it but ignores play, pause,
 * and buffering.
 */
export const useHasTrack = (): boolean => useContext(HasTrackContext);

/**
 * A stable function that returns the player as it is now. For event handlers and callbacks that
 * act on the player but don't show it, so their component doesn't re-render on player changes.
 */
export const useLatestPlayer = (): (() => Player) => useReaders().player;

/**
 * A stable function that returns the live position in milliseconds, worked out afresh on every
 * call. For handlers (such as a seek shortcut) that would otherwise re-render with every position
 * tick, and for animation-frame loops that follow playback closely, such as synced lyrics.
 */
export const usePositionReader = (): (() => number) => useReaders().positionMs;

const engineFactory = (engine: (() => PlayerEngine) | undefined): EngineFactory => {
  if (engine !== undefined) return { mse: null, create: engine };

  return {
    mse: MseEngine.detectSupport(),
    create: (kind) => (kind === "mse" ? new MseEngine(new Audio()) : new HtmlAudioEngine()),
  };
};

/** A queue row as the player shows it: its song with the entry's own id and how it joined. */
const queueTrack = (row: QueueRow): QueueEntry<QueueTrack> => ({
  itemId: row.itemId,
  autoplay: row.autoplay,
  track: { ...row.track, itemId: row.itemId, autoplay: row.autoplay },
});

/** The listener's queue once its state and every page have arrived; null before. */
const useQueue = (platform: PlatformSdk): QueueState<QueueTrack> | null => {
  const info = usePlatformQuery(platform.music.queue.get);
  const listing = useQueueListing(platform, pagedStore);
  const data = info.status === "success" ? info.data : null;

  return useMemo(
    () => (data === null || listing === null ? null : queueStateOf(data, listing, queueTrack)),
    [data, listing],
  );
};

interface ControllerProps {
  readonly platform: PlatformSdk;
  readonly mediaBaseUrl: string;
  readonly engine: (() => PlayerEngine) | undefined;
  readonly settings: PlayerSettings;
  /** Whether the core keeps settings for this device, read when a change is saved. */
  readonly deviceSettings: () => boolean;
  /** The volume chosen here whose save the core has not answered yet, set when it is saved. */
  readonly unsavedVolume: { current: number | null };
}

const createController = ({
  platform,
  mediaBaseUrl,
  engine,
  settings,
  deviceSettings,
  unsavedVolume,
}: ControllerProps): PlaybackController => {
  const storage = browserStorage();
  const probe = document.createElement("audio");
  let volumeTimer: ReturnType<typeof setTimeout> | undefined;

  const saveSetting = (patch: Parameters<PlatformSdk["core"]["settings"]["set"]>[0]): void => {
    if (deviceSettings()) void platform.core.settings.set(patch).catch(() => undefined);
  };

  const sources = ticketSources(
    (trackId) => platform.music.play.start({ trackId: asTrackId(trackId) }),
    {
      now: Date.now,
      baseUrl: mediaBaseUrl,
    },
  );

  return new PlaybackController(
    {
      play: (trackIds, index) =>
        platform.music.queue.play(
          index === undefined
            ? { trackIds: trackIds.map(asTrackId) }
            : { trackIds: trackIds.map(asTrackId), index },
        ),
      track: (trackId) => platform.music.tracks.get({ trackId: asTrackId(trackId) }),
      jump: async (itemId) => {
        await platform.music.queue.jump({ itemId: asItemId(itemId) });
      },
      report: async (trackId, playbackId) => {
        await platform.music.play.report({ trackId: asTrackId(trackId), playbackId });
      },
    },
    sources,
    engineFactory(engine),
    {
      canPlay: (mimeType) => probe.canPlayType(mimeType) !== "",
      now: Date.now,
      monotonicNow: () => performance.now(),
      settings,
      saveQuality: (quality) => {
        saveBrowserQuality(storage, quality);
        saveSetting({ streamQuality: settingOfQuality(quality) });
      },
      saveVolume: (volume) => {
        saveBrowserVolume(storage, volume);

        if (deviceSettings()) unsavedVolume.current = volume;
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(() => {
          saveSetting({ volume });
        }, VOLUME_SAVE_MS);
      },
      nowPlaying: {
        setHandlers: setMediaSessionHandlers,
        show: (track, playing, positionMs) => {
          showNowPlaying(
            track === null
              ? null
              : {
                  ...track,
                  artUrl: track.artUrl === null ? null : `${mediaBaseUrl}${track.artUrl}`,
                },
            playing,
            positionMs,
          );
        },
      },
      resume: browserResume(storage),
    },
  );
};

/** Song and entry ids the controller hands back, which the core answered in its queue and lists. */
const asTrackId = Brand.nominal<Track["id"]>();

const asItemId = Brand.nominal<QueueTrack["itemId"]>();

function PositionTicker({
  read,
  children,
}: {
  /** The live position in milliseconds; a stable function. */
  readonly read: () => number;
  readonly children: ReactNode;
}) {
  const [position, setPosition] = useState(() => Math.round(read()));

  useEffect(() => {
    const timer = setInterval(() => {
      setPosition(Math.round(read()));
    }, POSITION_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [read]);

  return <PositionContext.Provider value={position}>{children}</PositionContext.Provider>;
}

/**
 * Provides `usePlayer`, `usePlayerPosition`, `useCurrentTrack`, `useHasTrack`,
 * `useLatestPlayer`, and `usePositionReader`. Place it inside the platform provider of a
 * signed-in person. It plays the person's queue on this browser with the settings the core keeps
 * for them and this device (D36), starting from this browser's last choice until they answer.
 */
export function PlayerProvider({
  children,
  mediaBaseUrl,
  engine,
}: {
  readonly children: ReactNode;
  /** The media server's address, which stream and art paths are relative to. */
  readonly mediaBaseUrl: string;
  /**
   * Builds a fixed audio engine once per mount, replacing the automatic choice between the
   * gapless MSE engine and HTML audio. Pass a stable function.
   */
  readonly engine?: () => PlayerEngine;
}) {
  const platform = usePlatform();
  const settings = usePlatformQuery(platform.core.settings.get);
  const [fallback] = useState(() => browserSettings(browserStorage(), true));
  const keepsDeviceSettings = settings.status === "success" && settings.data.device !== null;
  const deviceSettings = useRef(keepsDeviceSettings);
  const unsavedVolume = useRef<number | null>(null);

  useLayoutEffect(() => {
    deviceSettings.current = keepsDeviceSettings;
  }, [keepsDeviceSettings]);

  // State rather than a memo: React may drop a memo, which would build a second controller.
  const [controller] = useState(() =>
    createController({
      platform,
      mediaBaseUrl,
      engine,
      settings: fallback,
      deviceSettings: () => deviceSettings.current,
      unsavedVolume,
    }),
  );

  const queue = useQueue(platform);
  const local = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const connect = useConnect(platform, controller, local);

  useEffect(() => controller.start(), [controller]);

  useEffect(() => {
    if (queue !== null) controller.sync(queue);
  }, [controller, queue]);

  const view = settings.status === "success" ? settings.data : null;
  const latestGapless = view?.user.gapless;
  const deviceQuality = view?.device?.streamQuality;
  const deviceVolume = view?.device?.volume;

  useEffect(() => {
    if (latestGapless === undefined) return;

    // Without settings the core keeps for this device, this browser's last choice stands, read now
    // rather than at mount, so a change from elsewhere never undoes one made here since.
    const browser = browserSettings(browserStorage(), latestGapless);

    // The core answers each volume save with the value saved, which may be older than the one
    // chosen since; the newest choice stands until the core answers with it.
    if (unsavedVolume.current === deviceVolume) unsavedVolume.current = null;

    controller.applySettings({
      quality: deviceQuality === undefined ? browser.quality : qualityOfSetting(deviceQuality),
      volume: deviceVolume === undefined ? browser.volume : (unsavedVolume.current ?? deviceVolume),
      gapless: latestGapless,
    });
  }, [controller, latestGapless, deviceQuality, deviceVolume]);

  const player = useMemo((): Player => {
    const entries = queue?.entries ?? [];
    const found = entries.findIndex((entry) => entry.itemId === local.current);
    const index = Math.max(0, found);
    const track = found === -1 ? null : (entries[found]?.track ?? null);
    const remote = connect.remote?.playback ?? null;

    const status = (): PlayerStatus => {
      if (queue === null) return "loading";

      if (track === null) return "idle";

      if (remote !== null) return remote.playing ? "playing" : "paused";

      return local.engineStatus === "idle" ? "paused" : local.engineStatus;
    };

    const here = localActions(controller, connect);

    const elsewhere =
      connect.remote === null
        ? null
        : remoteActions({
            platform,
            controller,
            connect,
            device: connect.remote,
            entries,
            index: found === -1 ? null : found,
            repeat: queue?.repeat ?? "off",
            durationMs: track?.durationMs ?? 0,
          });

    const actions = elsewhere ?? here;

    return {
      status: status(),
      track,
      queue: entries.map((entry) => entry.track),
      index,
      durationMs: track?.durationMs ?? 0,
      shuffle: queue?.shuffle ?? false,
      repeat: queue?.repeat ?? "off",
      autoplay: queue?.autoplay ?? true,
      volume: local.volume,
      mediaOnline: local.mediaOnline,
      error: local.error,
      quality: local.quality,
      autoplayBlocked: local.autoplayBlocked,
      engine: local.engine,
      deviceId: connect.deviceId,
      devices: connect.devices,
      remote: connect.remote,
      here: connect.here,
      ...actions,
      primeOutput: () => {
        controller.primeOutput();
      },
      setShuffle: (on) => controller.capture(platform.music.queue.shuffle({ on })),
      setRepeat: (mode) => controller.capture(platform.music.queue.repeat({ mode })),
      setVolume: async (volume) => {
        controller.setVolume(volume);
      },
      addToQueue: (ids, toFront) => controller.attempt(addAll(platform, ids, toFront === true)),
      removeFromQueue: (itemId) => controller.attempt(platform.music.queue.remove({ itemId })),
      setAutoplay: (on) => controller.capture(platform.music.queue.autoplay({ on })),
      setQuality: (quality) => {
        controller.setQuality(quality);
      },
      moveHere: () => moveHere(platform, controller, connect, track),
      moveTo: (deviceId) => moveTo(platform, controller, connect, deviceId, track),
      playOn: (deviceId, item) => playOn(platform, controller, connect, deviceId, item),
    };
  }, [queue, local, controller, platform, connect]);

  const latestPlayer = useRef(player);

  useLayoutEffect(() => {
    latestPlayer.current = player;
  }, [player]);

  const latestConnect = useRef(connect);

  useLayoutEffect(() => {
    latestConnect.current = connect;
  }, [connect]);

  const readers = useMemo(
    (): PlayerReaders => ({
      player: () => latestPlayer.current,
      positionMs: () => {
        const current = latestConnect.current;
        const playback = current.remote === null ? null : current.playbackOf(current.remote.id);

        if (playback === null) return Math.round(controller.positionMs());

        return Math.round(
          devicePosition(playback, current.serverNow(), latestPlayer.current.durationMs),
        );
      },
    }),
    [controller],
  );

  const trackId = player.track?.id ?? null;
  const status = player.status;
  const current = useMemo((): CurrentTrack => ({ trackId, status }), [trackId, status]);

  return (
    <ReadersContext.Provider value={readers}>
      <PlayerContext.Provider value={player}>
        <CurrentTrackContext.Provider value={current}>
          <HasTrackContext.Provider value={trackId !== null}>
            <PositionTicker read={readers.positionMs}>{children}</PositionTicker>
          </HasTrackContext.Provider>
        </CurrentTrackContext.Provider>
      </PlayerContext.Provider>
    </ReadersContext.Provider>
  );
}

/**
 * Adds every song, a call at a time: each call takes as many as it can read and answers the rest,
 * which the next call adds right after the last entry added so far, so the songs keep their order.
 * A failed call stops: an add may have landed even when its answer was lost, so it is never sent
 * again blindly (#153), and the queue on screen shows what landed.
 */
const addAll = async (
  platform: PlatformSdk,
  trackIds: ReadonlyArray<Track["id"]>,
  next: boolean,
  after?: QueueTrack["itemId"],
): Promise<void> => {
  if (trackIds.length === 0) return;

  const placement = after === undefined ? (next ? { next: true } : {}) : { afterItemId: after };

  const added = await platform.music.queue.add({ trackIds: [...trackIds], ...placement });

  if (added.rest.length >= trackIds.length) throw new Error("The queue stopped taking songs");

  await addAll(platform, added.rest, next, added.itemIds.at(-1) ?? after);
};

/** What a play, pause, skip, or seek does: here, or on the device the player follows. */
type TransportActions = Pick<
  PlayerActions,
  "playTracks" | "togglePlay" | "next" | "previous" | "seek" | "jump"
>;

/**
 * Playback here. Each action the listener takes makes the Connect requests seen so far moot
 * (ADR 0018), so one still loading never lands over it.
 */
const localActions = (controller: PlaybackController, connect: ConnectView): TransportActions => {
  const own = (): void => {
    connect.player.supersede();
  };

  return {
    playTracks: (ids, at) => {
      own();

      return controller.playTracks(ids, at);
    },
    togglePlay: () => {
      own();

      return controller.togglePlay();
    },
    next: () => {
      own();

      return controller.next();
    },
    previous: () => {
      own();

      return controller.previous();
    },
    seek: async (positionMs) => {
      own();
      controller.seek(positionMs);
    },
    jump: (itemId) => {
      own();

      return controller.jump(itemId);
    },
  };
};

interface RemoteContext {
  readonly platform: PlatformSdk;
  readonly controller: PlaybackController;
  readonly connect: ConnectView;
  readonly device: Device;
  readonly entries: ReadonlyArray<QueueState<QueueTrack>["entries"][number]>;
  /** Where the current entry is in `entries`; null when the queue does not hold it yet. */
  readonly index: number | null;
  readonly repeat: RepeatMode;
  readonly durationMs: number;
}

/**
 * Playback on the device the player follows, as old music's remote control: play, pause, and seek
 * ask that device (`core.connect.targets.control`); skips move the queue it plays, which it
 * follows; and playing a list here takes playback back, pausing that device, as old music made
 * this browser the active one.
 */
const remoteActions = ({
  platform,
  controller,
  connect,
  device,
  entries,
  index,
  repeat,
  durationMs,
}: RemoteContext): TransportActions => {
  const deviceId = asDeviceId(device.id);
  const playing = device.playback?.playing === true;

  const control = (change: { readonly playing: boolean } | { readonly positionMs: number }) =>
    controller.capture(platform.core.connect.targets.control({ deviceId, ...change }));

  const jumpTo = async (at: number | null): Promise<void> => {
    const entry = at === null ? undefined : entries[at];

    if (entry !== undefined) {
      await controller.capture(platform.music.queue.jump({ itemId: asItemId(entry.itemId) }));
    }
  };

  const positionMs = (): number => {
    const playback = connect.playbackOf(device.id);

    return playback === null ? 0 : devicePosition(playback, connect.serverNow(), durationMs);
  };

  return {
    playTracks: async (ids, at) => {
      connect.player.supersede();

      if (playing) void control({ playing: false });
      await controller.playTracks(ids, at);
    },
    togglePlay: () => control({ playing: !playing }),
    next: async () => {
      if (index !== null) await jumpTo(nextIndex(index, entries.length, repeat));
    },
    previous: async () => {
      if (index === null) return;
      const at = previousIndex(positionMs(), index, entries.length, repeat);

      await (at === index ? control({ positionMs: 0 }) : jumpTo(at));
    },
    seek: (target) => control({ positionMs: Math.max(0, Math.round(target)) }),
    jump: async (itemId) => {
      await controller.capture(platform.music.queue.jump({ itemId }));
    },
  };
};

/** Resolves whether `call` landed, without rejecting. */
const succeeded = async (call: Promise<unknown>): Promise<boolean> => {
  try {
    await call;

    return true;
  } catch {
    return false;
  }
};

const moveHere = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  track: QueueTrack | null,
): Promise<boolean> => {
  const self = connect.deviceId;
  const { remote } = connect;

  // Inside the tap, so the browser lets the song start once the move lands here.
  controller.primeOutput();

  if (self === null) return false;

  if (remote === null) {
    // Nothing plays anywhere: this browser takes the current song, paused where it stands, as old
    // music's transfer made it the active device.
    if (connect.here || track === null) return true;
    connect.player.supersede();

    return controller.playCurrentAt(track.id, controller.positionMs(), false);
  }

  // This tab applies the load the move makes of this browser's device, not another tab of it.
  await connect.lead();

  return succeeded(
    platform.core.connect.targets.move({ from: asDeviceId(remote.id), to: asDeviceId(self) }),
  );
};

const moveTo = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  target: string,
  track: QueueTrack | null,
): Promise<boolean> => {
  const self = connect.deviceId;
  const { remote } = connect;
  const { move, load } = platform.core.connect.targets;

  if (self === null) return false;

  const from = connect.here ? self : (remote?.id ?? null);

  if (from === target) return true;

  if (from !== null) {
    return succeeded(move({ from: asDeviceId(from), to: asDeviceId(target) }));
  }

  if (track === null) return false;

  return succeeded(
    load({
      deviceId: asDeviceId(target),
      item: { domain: "music", ref: { type: "track", id: track.id } },
      positionMs: Math.round(controller.positionMs()),
    }),
  );
};

const playOn = async (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  deviceId: string,
  item: MusicItem,
): Promise<boolean> => {
  const { load, control } = platform.core.connect.targets;
  const loaded = await succeeded(load({ deviceId: asDeviceId(deviceId), item }));
  const { remote } = connect;

  if (!loaded) return false;

  if (connect.here) {
    connect.player.supersede();
    controller.release();
  } else if (remote !== null && remote.id !== deviceId && remote.playback?.playing === true) {
    void succeeded(control({ deviceId: asDeviceId(remote.id), playing: false }));
  }

  return true;
};
