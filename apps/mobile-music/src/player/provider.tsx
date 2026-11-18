import { describeFailure } from "@media/mobile-core/failure";
import { pagedStore } from "@media/mobile-core/pages";
import { readHealth } from "@media/mobile-core/server";
import { lastPerson } from "@media/mobile-core/sign-in";
import { moveHere, moveTo, playOn, remoteActions } from "@media/player/connect-actions";
import type { TransportActions } from "@media/player/connect-actions";
import { devicePosition } from "@media/player/connect-devices";
import type { Device } from "@media/player/connect-devices";
import { PlaybackController } from "@media/player/playback-controller";
import type {
  ControllerSnapshot,
  MusicCommands,
  NowPlayingControls,
  QueueEntry,
  QueueState,
  ResumePoint,
} from "@media/player/playback-controller";
import { queueStateOf, useQueueListing } from "@media/player/queue-listing";
import type { QueueRow } from "@media/player/queue-listing";
import type { RepeatMode } from "@media/player/queue-order";
import {
  SessionPlayback,
  SessionPresence,
  playingKey,
  startSession,
} from "@media/player/session-playback";
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
} from "@media/player/session-react";
import type { JoinedSession, MusicSession, SessionData } from "@media/player/session-react";
import { ticketSources } from "@media/player/source-resolver";
import { settingOfQuality } from "@media/player/stream-quality";
import type { StreamQuality, StreamQualitySetting } from "@media/player/stream-quality";
import { useConnect } from "@media/player/use-connect";
import type { ConnectView, MusicItem } from "@media/player/use-connect";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform } from "@media/sdk/react";
import { Option, Schema } from "effect";
import { requireNativeModule } from "expo";
import type { EventEmitter } from "expo";
import { randomUUID } from "expo-crypto";
import { Alert } from "react-native";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { useLocalCopies } from "../downloads";
import type { DownloadedCopies } from "../downloads";
import { asQueueItemId, asTrackId } from "../lib/models";
import type { QueueItemId, Track, TrackId } from "../lib/models";
import { useReadSettled } from "../lib/platform";
import { appKeychains } from "../lib/keychains";
import { resolveMediaUrl } from "../lib/media-url";
import { readValue, writeValue } from "../lib/secure-storage";
import {
  HERE,
  idleTransfer,
  nextTransfer,
  TRANSFER_TIMEOUT_MS,
  transferArrived,
} from "../lib/transfer";
import type { MoveEnd, MoveTarget, Transfer } from "../lib/transfer";
import { useServer } from "../session/connection";
import { useProbeReach, useReachWhileAudible, useServerReach } from "../session/server-reach";
import { useSessionPhase } from "../session/session-phase";
import { openExpoOutput } from "./expo-audio-output";
import type { LockScreenPlayers } from "./expo-audio-output";
import {
  addLocal,
  clearLocal,
  handBack,
  jumpLocal,
  moveLocal,
  playingView,
  playLocal,
  recordPlay,
  removeLocal,
  repeatLocal,
  seedLocal,
  shuffleLocal,
} from "./local-queue";
import { withDeadline } from "./deadline";
import { handOver } from "./hand-over";
import type { HandBackStep, LocalQueue } from "./local-queue";
import { LocalStore, offlinePlaysKey } from "./local-store";
import { NativeEngine } from "./native-engine";
import type { TimelineMark } from "./native-engine";
import { lockScreenControls } from "./native-host";
import type { RemoteCommandEvents, RemoteCommands } from "./native-host";
import { boundedSources, NOT_DOWNLOADED, phoneSources, SERVER_AWAY } from "./phone-sources";
import {
  isPlaying,
  moveArgs,
  nextRepeat,
  nowPlayingOf,
  playsOnIos,
  queueItemOf,
  sameSong,
  statusOf,
} from "./player-state";
import type { NowPlaying, PlayerStatus, PlayerView, QueueItem, RemoteDevice } from "./player-state";
import { useAudioOutput } from "./audio-route";

const POSITION_INTERVAL_MS = 250;

const REFUSED_MESSAGE = "Couldn’t move playback there. Try again.";

/**
 * How long a new queue, or a song's ticket, may go unanswered before this phone plays its own
 * downloaded songs instead. A connection that died without the platform client noticing shows up
 * this way.
 */
const ACK_DEADLINE_MS = 4000;

const QUALITY_KEY = "music.streamQuality";

const RESUME_KEY = "music.resume";

/** Offline plays one `music.play.reportOffline` takes at most, as the core accepts. */
const OFFLINE_PLAYS_MAX = 500;

const OFFLINE_PLAYS_RETRY_MS = 30_000;

/**
 * How long a hand-back may go unanswered before the phone goes back to its own queue, and how long
 * it then waits to try again. A core that never answers while the media server does shows up this
 * way.
 */
const HAND_BACK_DEADLINE_MS = 10_000;

const HAND_BACK_RETRY_MS = 15_000;

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
  /** Saves the streaming quality; it applies from the next song. */
  readonly setQuality: (quality: StreamQuality) => void;
  /** Loads the current song again from its position after playback failed (G06). */
  readonly retry: () => void;
}

/**
 * Queue changes that reject with the failure, for a sheet that keeps a refusal on screen. An add
 * is never sent again after a failure: it may have landed, and the queue shows what did.
 */
export interface PlayerCommands {
  readonly addToQueue: (trackIds: ReadonlyArray<TrackId>, next: boolean) => Promise<void>;
  readonly clearQueue: () => Promise<void>;
}

/** The song, the status, and where it plays: what the mini player and song rows need. */
export interface NowPlayingView {
  readonly nowPlaying: NowPlaying | null;
  readonly status: PlayerStatus;
  /** The device the player follows while nothing plays here (`PlayerView.remote`). */
  readonly remote: RemoteDevice | null;
  /**
   * The person's Jam plays a song they may not play, as a kid an explicit one: nothing plays here
   * until the Jam moves on, and the screens show it as `Hidden song`.
   */
  readonly hidden: boolean;
}

/** The person's devices and a move between them, for the device sheet. */
export interface DevicesView {
  /** The person's other own devices that are online now, by name (ADR 0018). */
  readonly devices: ReadonlyArray<Device>;
  /** The device that plays: `HERE` while a song is loaded on this phone, another's id, or null. */
  readonly active: MoveTarget | null;
  /**
   * A move to another device, or here: pending until that device answers it, and failed when the
   * core refused it or the device did not answer within `TRANSFER_TIMEOUT_MS`.
   */
  readonly transfer: Transfer;
  /** Moves playback, at the same place in the song, to `target`: `HERE` or a device's id. */
  readonly moveTo: (target: MoveTarget) => void;
  /** Forgets the move: a failed one, or a pending one, which goes on unwatched. */
  readonly dismissTransfer: () => void;
  /**
   * Plays an album or a song on another device, which takes playback over. Resolves whether the
   * core took it.
   */
  readonly playOn: (deviceId: string, item: MusicItem) => Promise<boolean>;
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

const CommandsContext = createContext<PlayerCommands | null>(null);

const SongContext = createContext<NowPlaying | null>(null);

const OwnSessionContext = createContext(false);

const DevicesContext = createContext<DevicesView | null>(null);

const PositionReaderContext = createContext<(() => number) | null>(null);

const required = <Value,>(value: Value | null, hook: string): Value => {
  if (value === null) throw new Error(`${hook} must be used inside PlayerProvider`);

  return value;
};

/** The whole player. Re-renders on every change but the position; prefer the narrower hooks. */
export const usePlayer = (): PlayerView => required(use(PlayerContext), "usePlayer");

/** The song and the status. Changes only when one of them does. */
export const useNowPlaying = (): NowPlayingView =>
  required(use(NowPlayingContext), "useNowPlaying");

/** The song alone, for what doesn't show the status. Changes only when the song does. */
export const useSong = (): NowPlaying | null => use(SongContext);

/**
 * The live position, updated four times a second. Only components that call it re-render with
 * it: Now Playing's scrubber and the mini player's progress.
 */
export const usePlaybackPosition = (): PlaybackPosition => use(PositionContext);

/**
 * A stable function that returns the live position in milliseconds, worked out afresh on every
 * call. For frame loops that follow playback closely, such as synced lyrics; it never re-renders
 * its caller.
 */
export const usePositionReader = (): (() => number) =>
  required(use(PositionReaderContext), "usePositionReader");

/** The player's actions. Stable for the provider's lifetime, so it never re-renders a caller. */
export const usePlayerActions = (): PlayerActions =>
  required(use(ActionsContext), "usePlayerActions");

/** Queue changes that reject with their failure. Stable for the provider's lifetime. */
export const usePlayerCommands = (): PlayerCommands =>
  required(use(CommandsContext), "usePlayerCommands");

/**
 * Whether the player plays this phone's own queue of downloaded songs, as it does without the
 * server, until it hands it back. Changes only when that does.
 */
export const useOwnSession = (): boolean => use(OwnSessionContext);

/** The person's devices and a move between them. */
export const useDevices = (): DevicesView => required(use(DevicesContext), "useDevices");

/** A queue row as the player plays it. */
const serverEntry = (row: QueueRow): QueueEntry<Track> => ({
  itemId: row.itemId,
  autoplay: row.autoplay,
  track: row.track,
});

/** The listener's queue on the core once its state and every page have arrived; null before. */
const useServerQueue = (platform: PlatformSdk): QueueState<Track> | null => {
  const info = useReadSettled(platform.music.queue.get, {});
  const listing = useQueueListing(platform, pagedStore);
  const data = info === undefined || info instanceof Error ? null : info;

  return useMemo(
    () => (data === null || listing === null ? null : queueStateOf(data, listing, serverEntry)),
    [data, listing],
  );
};

/**
 * This phone's quality: the core's tier for this device, or the last one chosen here before the
 * core keeps settings for it. A phone's `auto` plays `high` (AAC 320 kbps): lossless originals are
 * a choice in settings, not a surprise on a cellular plan.
 */
const phoneQuality = (setting: StreamQualitySetting): StreamQuality => {
  if (setting === "low") return "data-saver";

  return setting === "original" ? "lossless" : "high";
};

const StoredQuality = Schema.Literals(["lossless", "high", "data-saver"]);

const loadQuality = (): StreamQuality =>
  Option.getOrElse(Schema.decodeUnknownOption(StoredQuality)(readValue(QUALITY_KEY)), () => "high");

const StoredResume = Schema.fromJsonString(
  Schema.Struct({ itemId: Schema.String, positionMs: Schema.Finite }),
);

const resumeStore = {
  load: (): ResumePoint | null =>
    Option.getOrNull(Schema.decodeUnknownOption(StoredResume)(readValue(RESUME_KEY))),
  save: (point: ResumePoint | null): void => {
    writeValue(RESUME_KEY, point === null ? null : Schema.encodeSync(StoredResume)(point));
  },
};

/** A downloaded song as the player plays it offline, its cover this phone's own file. */
const trackOfCopy = (copies: DownloadedCopies, trackId: string): Track | null => {
  const copy = copies.find(trackId);

  if (copy === null) return null;
  const { track } = copy;

  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistId: track.artistId,
    album: track.album,
    albumId: track.albumId,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    durationMs: track.durationMs,
    codec: track.codec,
    lossless: track.lossless,
    bitrate: track.bitrate,
    sampleRate: track.sampleRate,
    bitDepth: track.bitDepth,
    artUrl: copy.artUri,
    liked: false,
  };
};

const logTimeline = (mark: TimelineMark): void => {
  if (__DEV__) console.info(`[gapless] ${JSON.stringify(mark)}`);
};

interface Phone {
  readonly controller: PlaybackController;
  readonly local: LocalStore;
  /** Whether commands go to the core or to this phone's own queue, read when a command runs. */
  readonly mode: { current: "server" | "local" };
  /**
   * The new queues (`music.queue.play`) sent to the server that went unanswered when this phone
   * gave up waiting, one token each. One leaves once it fails, or once it lands while the player
   * follows the server. Any still here at the hand-back landed, or may land, while this phone played
   * its own queue, so the server no longer holds the entries the phone names.
   */
  readonly unanswered: Set<symbol>;
  /**
   * The hand-back under way, from when commands go to the core until the player follows its
   * queue, or null.
   */
  readonly handing: { current: symbol | null };
}

/**
 * Keeps `pending`, a new queue sent to the core that this phone stopped waiting for, in
 * `unanswered` until it fails, or lands while the player follows the core.
 */
const holdUnanswered = (
  { mode, unanswered }: Pick<Phone, "mode" | "unanswered">,
  pending: Promise<unknown>,
): void => {
  const left = Symbol("unanswered play");

  unanswered.add(left);

  const settle = async (): Promise<void> => {
    const landed = await pending.then(
      () => true,
      () => false,
    );

    if (!landed || mode.current === "server") unanswered.delete(left);
  };

  void settle();
};

interface PhoneProps {
  readonly platform: PlatformSdk;
  readonly mediaUrl: string;
  readonly copies: DownloadedCopies;
  /** Asks the server now whether it answers. */
  readonly probe: { current: () => void };
  /** Moves the player onto this phone's own queue, seeded from the core's last answer. */
  readonly goLocal: { current: () => void };
  /** Where this server's and person's offline plays wait, or null when no one is known. */
  readonly playsKey: string | null;
}

const createPhone = ({
  platform,
  mediaUrl,
  copies,
  probe,
  goLocal,
  playsKey,
}: PhoneProps): Phone => {
  const remoteCommands = requireNativeModule<
    EventEmitter<RemoteCommandEvents> & Pick<RemoteCommands, "stamp"> & LockScreenPlayers
  >("RemoteCommands");

  const engine = new NativeEngine((url) => openExpoOutput(url, remoteCommands), {
    mark: logTimeline,
    now: () => performance.now(),
  });

  const local = new LocalStore(appKeychains().own, playsKey);
  const mode: Phone["mode"] = { current: "server" };
  const unanswered: Phone["unanswered"] = new Set();
  const handing: Phone["handing"] = { current: null };

  const controls = lockScreenControls(engine, remoteCommands);

  const artFor = (artUrl: string | null): string | null => resolveMediaUrl(mediaUrl, artUrl);

  const nowPlaying: NowPlayingControls = {
    setHandlers: controls.setHandlers,
    commanded: controls.commanded,
    show: (track, playing, positionMs) => {
      controls.show(
        track === null ? null : { ...track, artUrl: artFor(track.artUrl) },
        playing,
        positionMs,
      );
    },
  };

  const remote = boundedSources(
    ticketSources((trackId) => platform.music.play.start({ trackId: asTrackId(trackId) }), {
      now: Date.now,
      baseUrl: mediaUrl,
    }),
    {
      deadlineMs: ACK_DEADLINE_MS,
      answers: async () => Option.isSome(await readHealth(mediaUrl)),
      away: () => {
        probe.current();
        goLocal.current();
        // At once, so the player is on the phone's queue before the unanswered source fails, and
        // moves on from there.
        controller.sync(playingView(local.getSnapshot()));
      },
    },
  );

  const sources = phoneSources(copies, remote, mode, randomUUID);

  /**
   * Plays the songs this phone holds of `trackIds` as its own new queue, from the one at `index`,
   * or the next it holds after it, as the core's `music.queue.play`
   * picks.
   */
  const playLocally = (trackIds: ReadonlyArray<string>, index: number | undefined) => {
    const found = trackIds.map((id) => trackOfCopy(copies, id));
    const tracks = found.filter((track) => track !== null);

    if (tracks.length === 0) throw new Error(NOT_DOWNLOADED);
    const before = found.slice(0, index ?? 0).filter((track) => track !== null).length;
    const start = Math.min(before, tracks.length - 1);

    const queue = local.update((held) => playLocal(held, tracks, start, Math.random));
    controller.sync(playingView(queue));

    return { current: queue.state.current ?? "" };
  };

  const commands: MusicCommands = {
    play: async (trackIds, index) => {
      if (mode.current === "local") return playLocally(trackIds, index);

      const pending = platform.music.queue.play(
        index === undefined
          ? { trackIds: trackIds.map(asTrackId) }
          : { trackIds: trackIds.map(asTrackId), index },
      );

      const answered = await withDeadline(pending, ACK_DEADLINE_MS);

      if (Option.isSome(answered)) return answered.value;

      // A slow server that still answers gets the play: going local now would hand it a second
      // queue once it is back.
      if (Option.isSome(await readHealth(mediaUrl))) return pending;
      holdUnanswered({ mode, unanswered }, pending);
      probe.current();

      if (!trackIds.some((id) => copies.find(id) !== null)) throw new Error(SERVER_AWAY);
      goLocal.current();

      return playLocally(trackIds, index);
    },
    track: async (trackId) => {
      const copy = trackOfCopy(copies, trackId);

      if (copy !== null) return copy;

      if (mode.current === "local") throw new Error(NOT_DOWNLOADED);

      return platform.music.tracks.get({ trackId: asTrackId(trackId) });
    },
    jump: async (itemId) => {
      if (mode.current === "local") {
        controller.sync(playingView(local.update((held) => jumpLocal(held, itemId))));

        return;
      }

      await platform.music.queue.jump({ itemId: asQueueItemId(itemId) });
    },
    report: async (trackId, playbackId) => {
      if (!playbackId.startsWith("local:")) {
        await platform.music.play.report({ trackId: asTrackId(trackId), playbackId });

        return;
      }

      // A downloaded song plays from its file; history still hears of it, now or once the
      // server answers again.
      if (mode.current === "server") {
        const started = await withDeadline(
          platform.music.play.start({ trackId: asTrackId(trackId) }),
          ACK_DEADLINE_MS,
        );

        if (Option.isSome(started)) {
          await platform.music.play.report({
            trackId: asTrackId(trackId),
            playbackId: started.value.playbackId,
          });

          return;
        }
      }

      local.update((held) => recordPlay(held, trackId, Date.now()));
    },
  };

  const controller = new PlaybackController(
    commands,
    sources,
    { mse: null, create: () => engine },
    {
      canPlay: playsOnIos,
      now: Date.now,
      monotonicNow: () => performance.now(),
      settings: { quality: loadQuality(), volume: 1, gapless: true },
      saveQuality: (quality) => {
        writeValue(QUALITY_KEY, quality);
        void platform.core.settings
          .set({ streamQuality: settingOfQuality(quality) })
          .catch(() => undefined);
      },
      saveVolume: (volume) => {
        void platform.core.settings.set({ volume }).catch(() => undefined);
      },
      nowPlaying,
      resume: resumeStore,
    },
  );

  return { controller, local, mode, unanswered, handing };
};

/** What the actions read at the moment they run. */
interface Latest {
  readonly queue: QueueState<Track> | null;
  readonly shownPlaying: boolean;
  readonly connect: ConnectView;
  readonly track: Track | null;
}

/**
 * Adds every song, a call at a time: each call takes as many as it can read and answers the rest,
 * which the next call adds right after the last entry added so far, so the songs keep their order.
 * A failed call stops: an add may have landed even when its answer was lost, so it is never sent
 * again blindly (#153), and the queue on screen shows what landed.
 */
const addAll = async (
  platform: PlatformSdk,
  trackIds: ReadonlyArray<TrackId>,
  next: boolean,
  after?: QueueItemId,
): Promise<void> => {
  if (trackIds.length === 0) return;

  const placement = after === undefined ? (next ? { next: true } : {}) : { afterItemId: after };

  const added = await platform.music.queue.add({ trackIds: [...trackIds], ...placement });

  if (added.rest.length >= trackIds.length) throw new Error("The queue stopped taking songs");

  await addAll(platform, added.rest, next, added.itemIds.at(-1) ?? after);
};

const createCommands = (
  platform: PlatformSdk,
  phone: Phone,
  copies: DownloadedCopies,
): PlayerCommands => {
  const { controller, local, mode } = phone;

  const changeLocal = (change: (queue: LocalQueue<Track>) => LocalQueue<Track>): void => {
    controller.sync(playingView(local.update(change)));
  };

  return {
    addToQueue: async (trackIds, next) => {
      if (mode.current === "local") {
        const tracks = trackIds.flatMap((id) => trackOfCopy(copies, id) ?? []);

        if (tracks.length === 0) throw new Error(NOT_DOWNLOADED);
        changeLocal((queue) => addLocal(queue, tracks, next));

        return;
      }

      await addAll(platform, trackIds, next);
    },
    clearQueue: async () => {
      if (mode.current === "local") {
        changeLocal(clearLocal);

        return;
      }

      await platform.music.queue.clear({});
    },
  };
};

const transportOf = (
  platform: PlatformSdk,
  controller: PlaybackController,
  { connect, queue, track }: Latest,
): TransportActions => {
  const device = connect.remote;

  if (device === null) {
    return {
      playTracks: (ids, at) => controller.playTracks(ids, at),
      togglePlay: () => controller.togglePlay(),
      next: () => controller.next(),
      previous: () => controller.previous(),
      seek: async (positionMs) => {
        controller.seek(positionMs);
      },
      jump: (itemId) => controller.jump(itemId),
    };
  }

  const entries = queue?.entries ?? [];
  const current = controller.getSnapshot().current;
  const index = entries.findIndex((entry) => entry.itemId === current);

  return remoteActions({
    platform,
    controller,
    connect,
    device,
    entries,
    index: index === -1 ? null : index,
    repeat: queue?.repeat ?? "off",
    durationMs: track?.durationMs ?? 0,
  });
};

const createActions = (
  platform: PlatformSdk,
  phone: Phone,
  commands: PlayerCommands,
  latest: { readonly current: Latest },
): PlayerActions => {
  const { controller, local, mode } = phone;
  const run = <A,>(call: () => Promise<A>) => controller.capture(call());
  const transport = (): TransportActions => transportOf(platform, controller, latest.current);

  const changeLocal = (change: (queue: LocalQueue<Track>) => LocalQueue<Track>): void => {
    controller.sync(playingView(local.update(change)));
  };

  const repeat = (): RepeatMode =>
    mode.current === "local"
      ? local.getSnapshot().state.repeat
      : (latest.current.queue?.repeat ?? "off");

  return {
    play: (trackIds, index) => transport().playTracks(trackIds, index),
    pause: async () => {
      if (latest.current.shownPlaying) await transport().togglePlay();
    },
    resume: async () => {
      if (!latest.current.shownPlaying) await transport().togglePlay();
    },
    toggle: () => transport().togglePlay(),
    next: () => transport().next(),
    previous: () => transport().previous(),
    seek: (positionMs) => transport().seek(positionMs),
    jump: (itemId) => transport().jump(itemId),
    setShuffle: async (on) => {
      if (mode.current === "local") changeLocal((queue) => shuffleLocal(queue, on, Math.random));
      else await run(() => platform.music.queue.shuffle({ on }));
    },
    cycleRepeat: async () => {
      const next = nextRepeat(repeat());

      if (mode.current === "local") changeLocal((queue) => repeatLocal(queue, next));
      else await run(() => platform.music.queue.repeat({ mode: next }));
    },
    setAutoplay: async (on) => {
      if (mode.current === "server") await run(() => platform.music.queue.autoplay({ on }));
    },
    setVolume: async (volume) => {
      controller.setVolume(volume);
    },
    playNext: (trackIds) => run(() => commands.addToQueue(trackIds, true)),
    playLater: (trackIds) => run(() => commands.addToQueue(trackIds, false)),
    removeFromQueue: async (itemId) => {
      if (mode.current === "local") changeLocal((queue) => removeLocal(queue, itemId));
      else await run(() => platform.music.queue.remove({ itemId }));
    },
    moveInQueue: async (itemId, toIndex) => {
      if (mode.current === "local") {
        const args = moveArgs(playingView(local.getSnapshot()).entries, itemId, toIndex);

        if (args !== null) changeLocal((queue) => moveLocal(queue, args.itemId, args.afterItemId));

        return;
      }

      const args = moveArgs(latest.current.queue?.entries ?? [], itemId, toIndex);

      if (args !== null) {
        await run(() =>
          platform.music.queue.move(
            args.afterItemId === undefined
              ? { itemId }
              : { itemId, afterItemId: asQueueItemId(args.afterItemId) },
          ),
        );
      }
    },
    clearQueue: () => run(() => commands.clearQueue()),
    setQuality: (quality) => {
      controller.setQuality(quality);
    },
    retry: () => {
      controller.retry();
    },
  };
};

type JoinedView = JoinedSession;

/** The person's session as the actions read it when they run. */
interface SessionAct {
  readonly view: JoinedView;
  readonly sessionPlayback: SessionPlayback;
  /** The entries `usePlayer().queue` shows, the song playing first. */
  readonly shown: ReadonlyArray<string>;
}

const alertRefusal = (message: string | null): void => {
  if (message !== null) Alert.alert("Jam", message);
};

const alertIfRefused = (refused: Promise<string | null>): Promise<void> =>
  refused.then(alertRefusal);

/** A Jam song this person may not play, as a kid an explicit one, as the queue shows it. */
const hiddenItem = (itemId: string): QueueItem => ({
  itemId: asQueueItemId(itemId),
  trackId: null,
  title: "Hidden song",
  artist: "Not available to you",
  artUrl: null,
  durationMs: 0,
  autoplay: false,
});

interface SessionSongs {
  /** The song playing on this phone, or null while its details load or when it is hidden. */
  readonly current: QueueEntry<Track> | null;
  /**
   * What the queue shows from the song playing on: that song, or `Hidden song` in its place, then
   * what plays after it, hidden songs included. Songs whose details still load show once they do.
   */
  readonly rows: ReadonlyArray<QueueItem>;
  /** Where the song playing is in `rows`: 0, or -1 while its details load. */
  readonly index: number;
  /** The song playing is one this person may not play. */
  readonly hidden: boolean;
}

/**
 * The session's song as this phone plays it, and what plays after it: the song the engine moved
 * on to by itself first once it did, and songs this person may not play shown as hidden, as the
 * web shows them, so a kid sees an explicit song coming and the silence it plays as.
 */
const sessionSongsOf = (
  data: SessionData,
  view: JoinedView,
  current: string | null,
  art: (track: Track) => string | null,
): SessionSongs => {
  const songs = [
    {
      key: playingKey(view.sessionId, view.entryId),
      track: data.playing,
      hidden: data.playingHidden,
    },
    ...data.entries.map((entry) => ({ key: entry.key, track: entry.track, hidden: entry.hidden })),
  ];

  const at = Math.max(
    0,
    songs.findIndex((song) => song.key === current),
  );

  const rows = songs.slice(at).flatMap(({ key, track, hidden }): ReadonlyArray<QueueItem> => {
    if (track !== null) return [queueItemOf({ itemId: key, autoplay: false, track }, art)];

    return hidden ? [hiddenItem(key)] : [];
  });

  const playing = songs[at];
  const hidden = playing?.hidden === true;

  return {
    current:
      playing === undefined || playing.track === null
        ? null
        : { itemId: playing.key, autoplay: false, track: playing.track },
    rows,
    index: playing?.track != null || hidden ? 0 : -1,
    hidden,
  };
};

/**
 * The player's actions while the person's music session plays (ADR 0017): play, pause, seeks,
 * skips, and queue changes go to the session, and what it refuses shows in an alert. Outside a
 * session they are the person's own queue's, `own`.
 */
const inSessionActions = (
  platform: PlatformSdk,
  latest: { readonly current: SessionAct | null },
  own: PlayerActions,
): PlayerActions => {
  const inSession =
    <Args extends ReadonlyArray<unknown>>(
      session: (act: SessionAct, ...args: Args) => Promise<void>,
      outside: (...args: Args) => Promise<void>,
    ) =>
    async (...args: Args): Promise<void> => {
      const act = latest.current;

      if (act === null) {
        await outside(...args);

        return;
      }

      try {
        await session(act, ...args);
      } catch (cause) {
        alertRefusal(describeFailure(cause));
      }
    };

  return {
    ...own,
    play: inSession(
      ({ view, sessionPlayback }, trackIds: ReadonlyArray<TrackId>, index?: number) =>
        alertIfRefused(playInSession(platform, view, sessionPlayback, trackIds, index)),
      own.play,
    ),
    pause: inSession(async ({ view, sessionPlayback }) => {
      if (view.clock.status === "playing") await alertIfRefused(sessionPlayback.togglePlay());
    }, own.pause),
    resume: inSession(async ({ view, sessionPlayback }) => {
      if (view.clock.status !== "playing") await alertIfRefused(sessionPlayback.togglePlay());
    }, own.resume),
    toggle: inSession(
      ({ sessionPlayback }) => alertIfRefused(sessionPlayback.togglePlay()),
      own.toggle,
    ),
    next: inSession(({ sessionPlayback }) => alertIfRefused(sessionPlayback.next()), own.next),
    previous: inSession(
      ({ sessionPlayback }) => alertIfRefused(sessionPlayback.previous()),
      own.previous,
    ),
    seek: inSession(
      ({ sessionPlayback }, positionMs: number) => alertIfRefused(sessionPlayback.seek(positionMs)),
      own.seek,
    ),
    jump: inSession(
      ({ sessionPlayback }, itemId: QueueItemId) => alertIfRefused(sessionPlayback.jump(itemId)),
      own.jump,
    ),
    // A session's queue has no shuffle, repeat, or autoplay; the person's own keeps theirs.
    setShuffle: inSession(async (_act, _on: boolean) => {}, own.setShuffle),
    cycleRepeat: inSession(async () => {}, own.cycleRepeat),
    setAutoplay: inSession(async (_act, _on: boolean) => {}, own.setAutoplay),
    playNext: inSession(
      ({ view }, trackIds: ReadonlyArray<TrackId>) => addToSession(platform, view, trackIds, true),
      own.playNext,
    ),
    playLater: inSession(
      ({ view }, trackIds: ReadonlyArray<TrackId>) => addToSession(platform, view, trackIds, false),
      own.playLater,
    ),
    removeFromQueue: inSession(async (_act, itemId: QueueItemId) => {
      await platform.core.together.remove({ domain: MUSIC, entryId: asEntryId(itemId) });
    }, own.removeFromQueue),
    moveInQueue: inSession(async ({ view, shown }, itemId: QueueItemId, toIndex: number) => {
      const args = moveArgs(
        shown.map((key) => ({ itemId: key })),
        itemId,
        toIndex,
      );

      if (args === null) return;

      // Right after the song playing is the front of the session's queue, which never holds it.
      const after = args.afterItemId;
      const front = after === undefined || after === playingKey(view.sessionId, view.entryId);

      await platform.core.together.reorder(
        front
          ? { domain: MUSIC, entryId: asEntryId(itemId) }
          : { domain: MUSIC, entryId: asEntryId(itemId), afterEntryId: asEntryId(after) },
      );
    }, own.moveInQueue),
    // Clearing takes out only the person's own queue; a session's is taken out an entry at a time.
    clearQueue: inSession(async () => {}, own.clearQueue),
  };
};

/**
 * Queue changes that reject with their failure, for a sheet that keeps a refusal on screen: the
 * session's while one plays.
 */
const inSessionCommands = (
  platform: PlatformSdk,
  latest: { readonly current: SessionAct | null },
  own: PlayerCommands,
): PlayerCommands => ({
  addToQueue: async (trackIds, next) => {
    const act = latest.current;

    if (act === null) {
      await own.addToQueue(trackIds, next);

      return;
    }

    await addToSession(platform, act.view, trackIds, next);
  },
  clearQueue: async () => {
    if (latest.current === null) await own.clearQueue();
  },
});

function PositionTicker({
  read,
  durationMs,
  children,
}: {
  readonly read: () => number;
  readonly durationMs: number;
  readonly children: ReactNode;
}) {
  const [positionMs, setPositionMs] = useState(() => Math.round(read()));

  useEffect(() => {
    const timer = setInterval(() => {
      setPositionMs(Math.round(read()));
    }, POSITION_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [read]);

  const position = useMemo(() => ({ positionMs, durationMs }), [positionMs, durationMs]);

  return <PositionContext value={position}>{children}</PositionContext>;
}

/** Follows the synced settings (D36): quality and volume for this device, gapless for the person. */
const useSettings = (platform: PlatformSdk, controller: PlaybackController): void => {
  const settings = useReadSettled(platform.core.settings.get, {});
  const view = settings === undefined || settings instanceof Error ? null : settings;
  const gapless = view?.user.gapless;
  const quality = view?.device?.streamQuality;
  const volume = view?.device?.volume;

  useEffect(() => {
    if (gapless === undefined) return;

    controller.applySettings({
      quality: quality === undefined ? loadQuality() : phoneQuality(quality),
      volume: volume ?? 1,
      gapless,
    });
  }, [controller, gapless, quality, volume]);
};

/** Sends one command of the hand-back; a new queue answers the entry it opened on. */
const sendStep = async (platform: PlatformSdk, step: HandBackStep): Promise<string | null> => {
  if (step.kind === "play") {
    const { current } = await platform.music.queue.play({
      trackIds: step.trackIds.map(asTrackId),
      index: step.index,
    });

    return current;
  }

  if (step.kind === "jump") await platform.music.queue.jump({ itemId: asQueueItemId(step.itemId) });
  else if (step.kind === "shuffle") await platform.music.queue.shuffle({ on: step.on });
  else await platform.music.queue.repeat({ mode: step.mode });

  return null;
};

/**
 * Hands this phone's own queue back once the server answers again: the plays it made go to
 * history; a queue edited here replaces the core's, or else the core moves to the entry this phone
 * played; and shuffle and repeat changed here go too. After a new queue left unanswered when the
 * phone went its own way, the whole queue goes back: Convex runs that queue first, as it runs one
 * client's mutations in order, and the hand-back then puts back what the phone played. It waits
 * while a song plays, so the song is not cut off, and goes back at the next pause or stop.
 * Commands go to the core from then on, after the hand-back; the player keeps the phone's queue
 * until the core confirms it (`handOver`). A hand-back the core leaves unanswered gives commands
 * back to the phone's queue and is tried again later; a new queue in it counts as unanswered.
 */
const useHandBack = (
  platform: PlatformSdk,
  phone: Phone,
  online: boolean,
  audible: boolean,
  setMode: (mode: "server" | "local") => void,
): void => {
  const { controller, local, mode, unanswered, handing } = phone;
  const queue = useSyncExternalStore(local.subscribe, local.getSnapshot);
  const plays = queue.plays;
  const sending = useRef(false);
  const [retry, setRetry] = useState(0);
  const [again, setAgain] = useState(0);
  const againTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(againTimer.current);
    },
    [],
  );

  // One batch at a time, so a play recorded meanwhile is not sent twice; the batch's removal
  // starts the next.
  useEffect(() => {
    if (!online || plays.length === 0 || sending.current) return undefined;
    const sent = plays.slice(0, OFFLINE_PLAYS_MAX);
    let timer: ReturnType<typeof setTimeout> | undefined;
    sending.current = true;

    const send = async (): Promise<void> => {
      await platform.music.play.reportOffline({
        plays: sent.map((play) => ({ trackId: asTrackId(play.trackId), playedAt: play.playedAt })),
        sentAt: Date.now(),
      });
      sending.current = false;
      local.update((held) => ({
        ...held,
        plays: held.plays.filter((play) => !sent.includes(play)),
      }));
    };

    void send().catch(() => {
      sending.current = false;
      timer = setTimeout(() => {
        setRetry((count) => count + 1);
      }, OFFLINE_PLAYS_RETRY_MS);
    });

    return () => {
      clearTimeout(timer);
    };
  }, [platform, local, online, plays, retry]);

  useEffect(() => {
    if (!online || audible || mode.current !== "local") return;
    const held = local.getSnapshot();
    const steps = handBack(held, unanswered.size > 0);
    const token = Symbol("hand-back");
    unanswered.clear();
    mode.current = "server";
    handing.current = token;

    const newQueues: Array<Promise<unknown>> = [];

    void handOver({
      steps,
      send: (step) => {
        const sent = sendStep(platform, step);

        if (step.kind === "play") newQueues.push(sent);

        return sent;
      },
      playing: held.state.current,
      stands: () => handing.current === token,
      adopt: (fromItemId, toItemId) => {
        controller.adoptEntry(fromItemId, toItemId);
      },
      follow: () => {
        handing.current = null;
        setMode("server");
      },
      deadlineMs: HAND_BACK_DEADLINE_MS,
      release: () => {
        handing.current = null;
        mode.current = "local";

        for (const sent of newQueues) holdUnanswered({ mode, unanswered }, sent);
        clearTimeout(againTimer.current);
        againTimer.current = setTimeout(() => {
          setAgain((count) => count + 1);
        }, HAND_BACK_RETRY_MS);
      },
    });
  }, [platform, controller, local, mode, unanswered, handing, online, audible, setMode, again]);
};

const activeOf = (connect: ConnectView): MoveTarget | null =>
  connect.here ? HERE : (connect.remote?.id ?? null);

const useDevicesView = (
  platform: PlatformSdk,
  controller: PlaybackController,
  connect: ConnectView,
  latest: { readonly current: Latest },
): DevicesView => {
  const [transfer, dispatch] = useReducer(nextTransfer, idleTransfer);
  const active = activeOf(connect);
  const shown = useRef(transfer);
  const moves = useRef(0);

  useLayoutEffect(() => {
    shown.current = transfer;
  }, [transfer]);

  if (transfer.state !== "idle" && transferArrived(transfer, connect)) {
    dispatch({ type: "arrived", id: transfer.move.id });
  }

  const pendingId = transfer.state === "pending" ? transfer.move.id : null;

  useEffect(() => {
    if (pendingId === null) return undefined;

    const timer = setTimeout(() => {
      dispatch({ type: "timeout", id: pendingId });
    }, TRANSFER_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [pendingId]);

  const actions = useMemo(() => {
    const move = async (to: MoveTarget): Promise<void> => {
      const { connect: view, track } = latest.current;
      const from = activeOf(view);
      const last = shown.current;

      if (to === HERE && view.remote === null && track === null) return;

      // A device that left the list keeps the name the last move showed it under.
      const endOf = (target: MoveTarget): MoveEnd => ({
        target,
        name:
          view.devices.find((device) => device.id === target)?.name ??
          (last.state === "idle"
            ? undefined
            : [last.move.from, last.move.to].find((end) => end.target === target)?.name) ??
          "",
      });

      moves.current += 1;
      const id = moves.current;

      if (from === to) {
        // Trying a move again that the core took but its device never answered: wait again.
        if (last.state !== "failed" || !last.landed || last.move.to.target !== to) return;
        const waiting = { ...last.move, id };

        if (transferArrived({ state: "pending", move: waiting, landed: true }, view)) return;
        dispatch({ type: "start", move: waiting });
        dispatch({ type: "landed", id });

        return;
      }

      dispatch({ type: "start", move: { id, from: endOf(from ?? HERE), to: endOf(to) } });

      const landed = await (to === HERE
        ? moveHere(platform, controller, view, track)
        : moveTo(platform, controller, view, to, track));

      dispatch(landed ? { type: "landed", id } : { type: "refused", id, message: REFUSED_MESSAGE });
    };

    return {
      moveTo: (to: MoveTarget) => {
        void move(to);
      },
      dismissTransfer: () => {
        dispatch({ type: "dismiss" });
      },
      playOn: (deviceId: string, item: MusicItem) =>
        playOn(platform, controller, latest.current.connect, deviceId, item),
    };
  }, [platform, controller, latest]);

  return useMemo(
    () => ({ devices: connect.devices, active, transfer, ...actions }),
    [connect.devices, active, transfer, actions],
  );
};

/** Whose player this is: the signed-in person, or offline the one who last signed in here. */
const usePlayerPerson = (mediaUrl: string): string | null => {
  const phase = useSessionPhase();

  if (phase.kind === "ready" || phase.kind === "needsLibrary" || phase.kind === "scanning") {
    return phase.me.userId;
  }

  return lastPerson({ own: appKeychains().own, server: mediaUrl })?.userId ?? null;
};

/**
 * Provides the player hooks. Mount it inside the platform provider of a signed-in person, or of
 * the person whose downloads the app opened offline. It plays the person's queue on the core on
 * this phone, and this phone's own queue of downloaded songs while the server is out of reach.
 * While it plays the queue on the core, the phone is a Connect device (ADR 0018): it reports what
 * it plays, applies what the person's other devices ask of it, and, while nothing plays here,
 * follows and controls another of their devices that does.
 */
export function PlayerProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const copies = useLocalCopies();
  const reach = useServerReach();
  const probeReach = useProbeReach();
  const probe = useRef(probeReach);
  const goLocal = useRef(() => {});
  const [mode, setMode] = useState<"server" | "local">("server");
  const person = usePlayerPerson(mediaUrl);

  useLayoutEffect(() => {
    probe.current = probeReach;
  }, [probeReach]);

  // State rather than a memo: React may drop a memo, which would build a second player.
  const [phone] = useState(() =>
    createPhone({
      platform,
      mediaUrl,
      copies,
      probe,
      goLocal,
      playsKey: person === null ? null : offlinePlaysKey(mediaUrl, person),
    }),
  );

  const { controller, local } = phone;
  const serverQueue = useServerQueue(platform);
  const localQueue = useSyncExternalStore(local.subscribe, local.getSnapshot);

  const [presence] = useState(
    () => new SessionPresence(() => platform.core.together.heartbeat({ domain: MUSIC })),
  );

  const [sessionPlayback] = useState(
    () =>
      new SessionPlayback({
        controller,
        commands: sessionCommands(platform),
        serverTime: presence,
        describe: describeFailure,
      }),
  );

  const sessionData = useSessionData(platform, pagedStore);
  const following = useSyncExternalStore(sessionPlayback.subscribe, sessionPlayback.getSnapshot);
  const [starting, setStarting] = useState(false);
  /** The person started the session from this phone's song: it goes on without a gap. */
  const startedHere = useRef(false);

  const snapshot: ControllerSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );

  const online = reach === "online";

  useLayoutEffect(() => {
    goLocal.current = () => {
      if (phone.mode.current === "local") return;

      // Lost again before the core confirmed the hand-back: the player still holds the phone's
      // queue, which the core's last answer would only take back to before the outage.
      if (phone.handing.current !== null) {
        phone.handing.current = null;
        phone.mode.current = "local";

        return;
      }

      local.update((held) => ({
        ...seedLocal(
          serverQueue,
          (id) => trackOfCopy(copies, id),
          controller.getSnapshot().current,
        ),
        plays: held.plays,
      }));
      phone.mode.current = "local";
      setMode("local");
    };
  }, [phone, controller, local, serverQueue, copies]);

  useEffect(() => controller.start(), [controller]);

  useEffect(() => sessionPlayback.start(), [sessionPlayback]);

  useEffect(() => {
    if (!online) goLocal.current();
  }, [online]);

  useSettings(platform, controller);

  const sessionView = sessionData.view;

  const beatFor =
    sessionView?.state === "joined" || sessionView?.state === "pending"
      ? sessionView.sessionId
      : null;

  // While the app runs, which iOS allows in the background only while it plays, so a host
  // listening there stays present (ADR 0017).
  useEffect(() => {
    presence.keep(online ? beatFor : null);
  }, [presence, beatFor, online]);

  useEffect(
    () => () => {
      presence.keep(null);
    },
    [presence],
  );

  // A session plays only from the server: this phone's own queue of copies plays without one.
  const follow = useMemo(
    () => (mode === "local" || starting ? null : followOf(sessionData)),
    [mode, starting, sessionData],
  );

  // Before the queue below: leaving a session first gives the player back to the person's queue.
  useEffect(() => {
    sessionPlayback.update(follow, startedHere.current);

    if (follow !== null) startedHere.current = false;
  }, [sessionPlayback, follow]);

  const localView = useMemo(() => playingView(localQueue), [localQueue]);
  const queue = mode === "local" ? localView : serverQueue;

  // The core's queue waits while the person's session is read, so a session never shows their
  // own song first; this phone's own queue never waits.
  useEffect(() => {
    if (queue === null || follow !== null) return;

    if (mode === "server" && sessionView === undefined) return;

    controller.sync(queue);
  }, [controller, queue, follow, mode, sessionView]);

  const entries = queue?.entries ?? [];
  const found = entries.findIndex((entry) => entry.itemId === snapshot.current);
  const entry: QueueEntry<Track> | null = found === -1 ? null : (entries[found] ?? null);
  const wantsPlay = snapshot.engineStatus === "loading";
  const playing = isPlaying(snapshot, wantsPlay);

  useHandBack(platform, phone, online, playing, setMode);
  useReachWhileAudible(playing);

  const output = useAudioOutput();

  const connected = useConnect(platform, controller, snapshot, {
    locks: undefined,
    onCore: mode === "server",
    output,
  });

  const inSession = follow === null ? null : sessionView?.state === "joined" ? sessionView : null;

  // In a Jam this phone plays the Jam, which controls it rather than Connect (ADR 0017, D35): it
  // follows no other device and offers none to move to, as the web's player in a Jam.
  const connect = useMemo(
    (): ConnectView =>
      inSession === null ? connected : { ...connected, remote: null, devices: [] },
    [connected, inSession],
  );

  const followedDevice = connect.remote;
  const remotePlayback = followedDevice?.playback ?? null;

  const remote = useMemo(
    (): RemoteDevice | null =>
      followedDevice === null ? null : { id: followedDevice.id, name: followedDevice.name },
    [followedDevice],
  );

  const art = useMemo(
    () =>
      (track: Track): string | null =>
        copies.find(track.id)?.artUri ?? resolveMediaUrl(mediaUrl, track.artUrl),
    [copies, mediaUrl],
  );

  const latestSong = useMemo(
    () => (entry === null ? null : nowPlayingOf(entry, art)),
    [entry, art],
  );

  const [nowPlaying, setNowPlaying] = useState(latestSong);

  if (!sameSong(nowPlaying, latestSong)) setNowPlaying(latestSong);

  const items = useMemo(() => entries.map((queued) => queueItemOf(queued, art)), [entries, art]);

  const status = statusOf(
    queue === null ? null : { hasCurrent: entry !== null },
    snapshot,
    remotePlayback,
  );

  const sessionSongs = useMemo(
    () =>
      inSession === null ? null : sessionSongsOf(sessionData, inSession, snapshot.current, art),
    [inSession, sessionData, snapshot, art],
  );

  const sessionSong = useMemo(
    () =>
      sessionSongs?.current === null || sessionSongs === null
        ? null
        : nowPlayingOf(sessionSongs.current, art),
    [sessionSongs, art],
  );

  const player = useMemo((): PlayerView => {
    if (sessionSongs !== null && inSession !== null) {
      return {
        // A hidden song plays nothing here, but the Jam plays it on: its controls show the Jam's.
        status: sessionSongs.hidden
          ? inSession.clock.status
          : statusOf({ hasCurrent: sessionSongs.current !== null }, snapshot, null),
        remote: null,
        nowPlaying: sessionSong,
        queue: sessionSongs.rows,
        index: sessionSongs.index,
        shuffle: false,
        repeat: "off",
        autoplay: false,
        volume: snapshot.volume,
        error: snapshot.error,
        quality: snapshot.quality,
      };
    }

    return {
      status,
      remote,
      nowPlaying,
      queue: items,
      index: Math.max(0, found),
      shuffle: queue?.shuffle ?? false,
      repeat: queue?.repeat ?? "off",
      autoplay: queue?.autoplay ?? true,
      volume: snapshot.volume,
      error: snapshot.error,
      quality: snapshot.quality,
    };
  }, [
    status,
    remote,
    nowPlaying,
    items,
    found,
    queue,
    snapshot,
    sessionSongs,
    sessionSong,
    inSession,
  ]);

  const shownSong = sessionSongs === null ? nowPlaying : sessionSong;
  const hiddenSong = sessionSongs?.hidden === true;

  const current = useMemo(
    (): NowPlayingView => ({
      nowPlaying: shownSong,
      status: player.status,
      remote: player.remote,
      hidden: hiddenSong,
    }),
    [shownSong, player.status, player.remote, hiddenSong],
  );

  const track = entry?.track ?? null;
  const shownPlaying = remotePlayback === null ? playing : remotePlayback.playing;
  const latest = useRef<Latest>({ queue: serverQueue, shownPlaying, connect, track });

  useLayoutEffect(() => {
    latest.current = { queue: serverQueue, shownPlaying, connect, track };
  }, [serverQueue, shownPlaying, connect, track]);

  const commands = useMemo(
    () => createCommands(platform, phone, copies),
    [platform, phone, copies],
  );

  const latestSession = useRef<SessionAct | null>(null);

  useLayoutEffect(() => {
    latestSession.current =
      inSession === null || sessionSongs === null
        ? null
        : {
            view: inSession,
            sessionPlayback,
            shown: sessionSongs.rows.map((row) => row.itemId),
          };
  }, [inSession, sessionPlayback, sessionSongs]);

  const actions = useMemo(
    () =>
      inSessionActions(platform, latestSession, createActions(platform, phone, commands, latest)),
    [platform, phone, commands],
  );

  const readPosition = useMemo(
    () => () => {
      const { connect: view, track: playingTrack } = latest.current;
      const followed = view.remote === null ? null : view.playbackOf(view.remote.id);

      if (followed === null) return controller.positionMs();

      return devicePosition(followed, view.serverNow(), playingTrack?.durationMs ?? 0);
    },
    [controller],
  );

  const devices = useDevicesView(platform, controller, connect, latest);

  const queueCommands = useMemo(
    () => inSessionCommands(platform, latestSession, commands),
    [platform, commands],
  );

  const start = useCallback(async (): Promise<string> => {
    const own = latest.current.queue;

    const playingEntry = own?.entries.find(
      (queued) => queued.itemId === controller.getSnapshot().current,
    );

    if (own === null || playingEntry === undefined) throw new Error("Play a song to start a Jam");

    const at = own.entries.indexOf(playingEntry);

    setStarting(true);

    try {
      const started = await startSession(
        {
          trackId: playingEntry.track.id,
          // What the person hears and sees: the device the player follows, when it follows one.
          positionNow: readPosition,
          playing: latest.current.shownPlaying,
          upcoming: own.entries.slice(at + 1).map((queued) => queued.track.id),
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
  }, [platform, controller, readPosition]);

  const musicSession = useMemo(
    (): MusicSession => ({ ...sessionData, following: following.follower, starting, start }),
    [sessionData, following, starting, start],
  );

  return (
    <PositionReaderContext value={readPosition}>
      <ActionsContext value={actions}>
        <CommandsContext value={queueCommands}>
          <DevicesContext value={devices}>
            <PlayerContext value={player}>
              <NowPlayingContext value={current}>
                <SongContext value={shownSong}>
                  <OwnSessionContext value={mode === "local"}>
                    <MusicSessionProvider value={musicSession}>
                      <PositionTicker read={readPosition} durationMs={shownSong?.durationMs ?? 0}>
                        {children}
                      </PositionTicker>
                    </MusicSessionProvider>
                  </OwnSessionContext>
                </SongContext>
              </NowPlayingContext>
            </PlayerContext>
          </DevicesContext>
        </CommandsContext>
      </ActionsContext>
    </PositionReaderContext>
  );
}
