import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { pagedStore } from "@media/ui/lib/pages";
import { Brand } from "effect";
import {
  createContext,
  useCallback,
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
import { moveHere, moveTo, playOn, remoteActions } from "./connect-actions";
import type { TransportActions } from "./connect-actions";
import { devicePosition } from "./connect-devices";
import type { Device } from "./connect-devices";
import type { ConnectOutput } from "./connect-player";
import type { EngineKind, PlayerEngine } from "./engine";
import { messageOf } from "./failure";
import { HtmlAudioEngine } from "./html-audio-engine";
import { setMediaSessionHandlers, showNowPlaying } from "./media-session";
import { MseEngine } from "./mse-engine";
import { PlaybackController } from "./playback-controller";
import type {
  EngineFactory,
  PlayerSettings,
  QueueEntry,
  QueueState,
  Receiver,
} from "./playback-controller";
import { queueStateOf, useQueueListing } from "./queue-listing";
import type { QueueRow } from "./queue-listing";
import type { RepeatMode } from "./queue-order";
import { SessionPlayback, SessionPresence, playingKey, startSession } from "./session-playback";
import {
  MUSIC,
  MusicSessionProvider,
  addToSession,
  asEntryId,
  followOf,
  playInSession,
  sessionCommands,
  startCommands,
  useSessionData,
} from "./session-react";
import type { JoinedSession, MusicSession, SessionData } from "./session-react";
import { ticketSources } from "./source-resolver";
import { qualityOfSetting, settingOfQuality } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";
import { browserLocks, useConnect } from "./use-connect";
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
  /**
   * The entry's id in the queue the player plays: the listener's own queue's, or in a group session
   * the session queue's (`core.together.queue`), which the player passes back the same way.
   */
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
  /**
   * The Chromecast this browser plays through, by its name (null when it has none), or null while
   * the browser plays itself. Connect shows it as this browser's output (ADR 0018).
   */
  readonly cast: { readonly receiver: string | null } | null;
}

/**
 * What the UI can ask the player to do. Outside a group session actions never reject: failures
 * become `error`. In one, the session plays instead of the listener's queue (ADR 0017): play,
 * pause, seeks, skips, and queue changes go to it, and one it refuses rejects with why, for the
 * screen to show.
 */
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
  /**
   * Plays through a Chromecast this browser drives, as its Cast session starts, or through the
   * browser itself again for null, as the session ends. The song here moves over at the place it
   * reached, playing or paused as it was.
   */
  readonly castTo: (receiver: Receiver | null) => void;
  /**
   * Takes the song back from a Chromecast another sender's media took over: it stays here paused,
   * where the TV last played it.
   */
  readonly castTaken: () => void;
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
        // Media Session handlers run on the page's own thread, in order with its other commands.
        commanded: () => {},
      },
      resume: browserResume(storage),
    },
  );
};

/** A browser that plays its own sound. */
const LOCAL_OUTPUT: ConnectOutput = { kind: "local" };

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

  const output = useMemo(
    (): ConnectOutput =>
      local.cast === null ? LOCAL_OUTPUT : { kind: "cast", receiver: local.cast.receiver },
    [local.cast],
  );

  const connect = useConnect(platform, controller, local, {
    locks: browserLocks(),
    onCore: true,
    output,
  });

  const [presence] = useState(
    () => new SessionPresence(() => platform.core.together.heartbeat({ domain: MUSIC })),
  );

  const [sessionPlayback] = useState(
    () =>
      new SessionPlayback({
        controller,
        commands: sessionCommands(platform),
        serverTime: presence,
        describe: messageOf,
      }),
  );

  const sessionData = useSessionData(platform, pagedStore);
  const following = useSyncExternalStore(sessionPlayback.subscribe, sessionPlayback.getSnapshot);
  const [starting, setStarting] = useState(false);
  /** The person started the session from this player: its song goes on without a gap. */
  const startedHere = useRef(false);

  useEffect(() => controller.start(), [controller]);

  useEffect(() => sessionPlayback.start(), [sessionPlayback]);

  const view = sessionData.view;
  const beatFor = view?.state === "joined" || view?.state === "pending" ? view.sessionId : null;

  // Heartbeats on every screen keep the person's place, and a host's session playing (ADR 0017).
  useEffect(() => {
    presence.keep(beatFor);
  }, [presence, beatFor]);

  useEffect(
    () => () => {
      presence.keep(null);
    },
    [presence],
  );

  const follow = useMemo(() => (starting ? null : followOf(sessionData)), [starting, sessionData]);

  const inSession = follow !== null;

  // Before the listener's own queue below: leaving a session first gives the player back to it.
  useEffect(() => {
    sessionPlayback.update(follow, startedHere.current);

    if (follow !== null) startedHere.current = false;
  }, [sessionPlayback, follow]);

  // Held while the person's session is read, so a session never shows their own song first.
  useEffect(() => {
    if (queue !== null && view !== undefined && !inSession) controller.sync(queue);
  }, [controller, queue, view, inSession]);

  const synced = settings.status === "success" ? settings.data : null;
  const latestGapless = synced?.user.gapless;
  const deviceQuality = synced?.device?.streamQuality;
  const deviceVolume = synced?.device?.volume;

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
    if (follow !== null && view?.state === "joined") {
      return sessionPlayerOf({
        data: sessionData,
        view,
        local,
        controller,
        sessionPlayback,
        platform,
        connect,
      });
    }

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

    const here = localActions(controller);

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
      cast: local.cast,
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
      castTo: (receiver) => {
        controller.castTo(receiver);
      },
      castTaken: () => {
        controller.castTaken();
      },
    };
  }, [queue, local, controller, platform, connect, follow, view, sessionData, sessionPlayback]);

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
        // The player's own remote: none in a group session, which plays here.
        const { remote } = latestPlayer.current;
        const playback = remote === null ? null : current.playbackOf(remote.id);

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

  const start = useCallback(async (): Promise<string> => {
    const own = latestPlayer.current;
    const song = own.track;

    if (song === null) throw new Error("Play a song to start a Jam");

    controller.primeOutput();
    setStarting(true);

    try {
      const started = await startSession(
        {
          trackId: song.id,
          // What the person hears and sees: the device the player follows, when it follows one.
          positionNow: readers.positionMs,
          playing: own.status === "playing" || own.status === "buffering",
          upcoming: own.queue.slice(own.index + 1).map((entry) => entry.id),
        },
        startCommands(platform),
      );

      startedHere.current = true;
      // The queue fills behind the start; the core refuses its rest once the session is over.
      started.queued.catch(() => undefined);

      return started.link;
    } finally {
      setStarting(false);
    }
  }, [controller, platform, readers]);

  const musicSession = useMemo(
    (): MusicSession => ({ ...sessionData, following: following.follower, starting, start }),
    [sessionData, following, starting, start],
  );

  return (
    <ReadersContext.Provider value={readers}>
      <PlayerContext.Provider value={player}>
        <CurrentTrackContext.Provider value={current}>
          <HasTrackContext.Provider value={trackId !== null}>
            <MusicSessionProvider value={musicSession}>
              <PositionTicker read={readers.positionMs}>{children}</PositionTicker>
            </MusicSessionProvider>
          </HasTrackContext.Provider>
        </CurrentTrackContext.Provider>
      </PlayerContext.Provider>
    </ReadersContext.Provider>
  );
}

interface InSession {
  readonly data: SessionData;
  readonly view: JoinedSession;
  readonly local: ReturnType<PlaybackController["getSnapshot"]>;
  readonly controller: PlaybackController;
  readonly sessionPlayback: SessionPlayback;
  readonly platform: PlatformSdk;
  readonly connect: ConnectView;
}

const refused = (message: string | null): void => {
  if (message !== null) throw new Error(message);
};

/**
 * The player while the person's music session plays: the session's song and queue, as far as read,
 * with the song the engine moved on to by itself first once it did; transport moves go to the
 * session, and queue changes to its queue.
 */
const sessionPlayerOf = ({
  data,
  view,
  local,
  controller,
  sessionPlayback,
  platform,
  connect,
}: InSession): Player => {
  const songs = [
    { key: playingKey(view.sessionId, view.entryId), track: data.playing },
    ...data.entries.map((entry) => ({ key: entry.key, track: entry.track })),
  ];

  const at = Math.max(
    0,
    songs.findIndex((song) => song.key === local.current),
  );

  const shown = songs
    .slice(at)
    .flatMap(({ key, track }) =>
      track === null ? [] : [{ ...track, itemId: asItemId(key), autoplay: false }],
    );

  const track = songs[at]?.track === null || songs[at] === undefined ? null : (shown[0] ?? null);

  const status = (): PlayerStatus => {
    if (track === null) return data.playingHidden ? "idle" : "loading";

    return local.engineStatus === "idle" ? "paused" : local.engineStatus;
  };

  return {
    status: status(),
    track,
    queue: shown,
    index: 0,
    durationMs: track?.durationMs ?? 0,
    shuffle: false,
    repeat: "off",
    autoplay: false,
    volume: local.volume,
    mediaOnline: local.mediaOnline,
    error: local.error,
    quality: local.quality,
    autoplayBlocked: local.autoplayBlocked,
    engine: local.engine,
    // The session plays on each of the person's players that follows it, and Connect neither moves
    // nor loads one (ADR 0017), so it offers no other device.
    deviceId: connect.deviceId,
    devices: [],
    remote: null,
    here: connect.here,
    playTracks: async (ids, index) => {
      controller.primeOutput();
      refused(await playInSession(platform, view, sessionPlayback, ids, index));
    },
    primeOutput: () => {
      controller.primeOutput();
    },
    togglePlay: async () => {
      controller.primeOutput();
      refused(await sessionPlayback.togglePlay());
    },
    next: async () => {
      refused(await sessionPlayback.next());
    },
    previous: async () => {
      refused(await sessionPlayback.previous());
    },
    seek: async (positionMs) => {
      refused(await sessionPlayback.seek(positionMs));
    },
    jump: async (itemId) => {
      controller.primeOutput();
      refused(await sessionPlayback.jump(itemId));
    },
    // A session's queue has no shuffle, repeat, or autoplay; the listener's own keeps theirs.
    setShuffle: async () => {},
    setRepeat: async () => {},
    setVolume: async (volume) => {
      controller.setVolume(volume);
    },
    addToQueue: async (ids, toFront) => {
      await addToSession(platform, view, ids, toFront === true);

      return true;
    },
    removeFromQueue: (itemId) =>
      controller.attempt(
        platform.core.together.remove({ domain: MUSIC, entryId: asEntryId(itemId) }),
      ),
    setAutoplay: async () => {},
    setQuality: (quality) => {
      controller.setQuality(quality);
    },
    moveHere: async () => true,
    moveTo: async () => false,
    playOn: async () => false,
    cast: local.cast,
    // A Jam plays here and casts nowhere, as old music had no casting (ADR 0018): only the end of a
    // cast, as the person joins, reaches the controller.
    castTo: (receiver) => {
      if (receiver === null) controller.castTo(null);
    },
    castTaken: () => {
      controller.castTaken();
    },
  };
};

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

/**
 * Playback here. Each of these is a listener action of the controller, which makes the Connect
 * requests seen so far moot (ADR 0018), so one still loading never lands over it.
 */
const localActions = (controller: PlaybackController): TransportActions => ({
  playTracks: (ids, at) => controller.playTracks(ids, at),
  togglePlay: () => controller.togglePlay(),
  next: () => controller.next(),
  previous: () => controller.previous(),
  seek: async (positionMs) => {
    controller.seek(positionMs);
  },
  jump: (itemId) => controller.jump(itemId),
});
