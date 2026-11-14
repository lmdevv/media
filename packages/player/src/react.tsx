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
import type { EngineKind, PlayerEngine } from "./engine";
import { HtmlAudioEngine } from "./html-audio-engine";
import { setMediaSessionHandlers, showNowPlaying } from "./media-session";
import { MseEngine } from "./mse-engine";
import { PlaybackController } from "./playback-controller";
import type { EngineFactory, PlayerSettings, QueueState } from "./playback-controller";
import type { RepeatMode } from "./queue-order";
import { ticketSources } from "./source-resolver";
import { qualityOfSetting, settingOfQuality } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";

const POSITION_INTERVAL_MS = 250;

/** Queue entries asked for per page; the core caps a page to what one call may read. */
const QUEUE_PAGE = 200;

/** Wait this long after the last volume change before saving it. */
const VOLUME_SAVE_MS = 500;

/** A song as the music commands answer it. */
export type Track = Awaited<ReturnType<PlatformSdk["music"]["tracks"]["get"]>>;

type QueueRow = Awaited<ReturnType<PlatformSdk["music"]["queue"]["list"]>>["page"][number];

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
}

/** What the UI can ask the player to do. Actions never reject: failures become `error`. */
export interface PlayerActions {
  /** Replaces the queue and plays it on this browser. */
  readonly playTracks: (trackIds: ReadonlyArray<Track["id"]>, index?: number) => Promise<void>;
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

/** How long the queue's pages wait before they are followed again after one failed. */
const QUEUE_RESTART_MS = 250;

const queuePages = (platform: PlatformSdk) =>
  pagedStore((span) =>
    platform.music.queue.list.watch({ paginationOpts: { numItems: QUEUE_PAGE, ...span } }),
  );

/**
 * Every row of the listener's queue, followed live, loading the next page as soon as one arrives;
 * null until every page first arrived. A new queue (`music.queue.play`) lists another
 * generation's entries, so Convex refuses the cursors its pages were following (`InvalidCursor`,
 * which the SDK reports as a protocol error); the pages then start over from the top, as Convex's
 * own paginated hook does. The last whole list stays while pages reload, as when the queue grows
 * past a page or starts over, so the player never drops the song it shows.
 */
const useQueueRows = (platform: PlatformSdk): ReadonlyArray<QueueRow> | null => {
  const [store, setStore] = useState(() => queuePages(platform));
  const [last, setLast] = useState<ReadonlyArray<QueueRow> | null>(null);
  const paged = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const load = paged.status === "ready" && paged.next.kind === "more" ? paged.next.load : null;
  const whole = paged.status === "ready" && paged.next.kind === "done" ? paged.rows : null;

  if (whole !== null && whole !== last) setLast(whole);

  const failed =
    paged.status === "failed" || (paged.status === "ready" && paged.next.kind === "failed");

  useEffect(() => {
    load?.();
  }, [load]);

  useEffect(() => {
    if (!failed) return undefined;

    const timer = setTimeout(() => {
      setStore(queuePages(platform));
    }, QUEUE_RESTART_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [failed, platform]);

  return whole ?? last;
};

/** The listener's queue once its state and every page have arrived; null before. */
const useQueue = (platform: PlatformSdk): QueueState<QueueTrack> | null => {
  const info = usePlatformQuery(platform.music.queue.get);
  const list = useQueueRows(platform);
  const data = info.status === "success" ? info.data : null;

  return useMemo(() => {
    if (data === null || list === null) return null;

    return {
      entries: list.map((row) => ({
        itemId: row.itemId,
        autoplay: row.autoplay,
        track: { ...row.track, itemId: row.itemId, autoplay: row.autoplay },
      })),
      current: data.current,
      shuffle: data.shuffle,
      repeat: data.repeat,
      autoplay: data.autoplay,
    };
  }, [data, list]);
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

    const status = (): PlayerStatus => {
      if (queue === null) return "loading";

      if (track === null) return "idle";

      return local.engineStatus === "idle" ? "paused" : local.engineStatus;
    };

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
      playTracks: (ids, at) => controller.playTracks(ids, at),
      togglePlay: () => controller.togglePlay(),
      next: () => controller.next(),
      previous: () => controller.previous(),
      seek: async (positionMs) => {
        controller.seek(positionMs);
      },
      jump: (itemId) => controller.jump(itemId),
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
    };
  }, [queue, local, controller, platform]);

  const latestPlayer = useRef(player);

  useLayoutEffect(() => {
    latestPlayer.current = player;
  }, [player]);

  const readers = useMemo(
    (): PlayerReaders => ({
      player: () => latestPlayer.current,
      positionMs: () => Math.round(controller.positionMs()),
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
            <PositionTicker controller={controller}>{children}</PositionTicker>
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
