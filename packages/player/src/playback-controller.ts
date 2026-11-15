import type { MusicStreamProfile } from "@media/contracts/music-playback";
import { Effect, Exit, Fiber, Result } from "effect";

import type { EngineErrorReason, EngineEvent, EngineKind, PlayerEngine } from "./engine";
import { messageOf } from "./failure";
import { livePosition } from "./live-position";
import type { PositionSnapshot } from "./live-position";
import { isStreamRefused, mediaBaseUrl, probeMediaHealth, waitForMedia } from "./media-health";
import type { MediaSessionHandlers, NowPlayingTrack } from "./media-session";
import { followingIndex, nextIndex, previousIndex } from "./queue-order";
import type { RepeatMode } from "./queue-order";
import { SourceUnreachable } from "./source-resolver";
import type {
  PlayableTrack,
  ResolvedSource,
  SourceReach,
  SourceResolver,
  StreamRefused,
} from "./source-resolver";
import { chooseEngine, chooseGaplessProfile, chooseStreamProfile } from "./stream-quality";
import type { MseSupport, StreamQuality } from "./stream-quality";

/** Save where playback stands this often while it plays, for the next page load. */
const RESUME_SAVE_MS = 15_000;

/** Ask for the following song's ticket this far before the playing one ends. */
const PRELOAD_LEAD_MS = 20_000;

/** How long a jump sent from here may go unconfirmed before the server's entry stands again. */
const JUMP_GRACE_MS = 10_000;

/** A Connect request's position this close to where the song is leaves it there (ADR 0018). */
const STEER_TOLERANCE_MS = 250;

const AUTOPLAY_BLOCKED_MESSAGE = "Tap play to start here";

const MEDIA_OFFLINE_MESSAGE = "Can't reach the media server. Retrying…";

const STREAM_REFUSED_MESSAGE = "The media server refused this song's stream";

/** A song as the player plays and shows it. */
export interface Track extends PlayableTrack, NowPlayingTrack {
  /** The codec the scanner recorded, such as `FLAC`. */
  readonly codec: string;
  readonly lossless: boolean;
}

/** One entry of the queue: its own id, which commands address it by, and its song. */
export interface QueueEntry<T extends Track = Track> {
  readonly itemId: string;
  /** Added by autoplay when the queue ran out, not by the listener. */
  readonly autoplay: boolean;
  readonly track: T;
}

/** The listener's queue as the core keeps it (`music.queue.get` and every `music.queue.list` page). */
export interface QueueState<T extends Track = Track> {
  /** Every entry the listener may play, in play order. */
  readonly entries: ReadonlyArray<QueueEntry<T>>;
  /**
   * Whether `entries` is the queue's whole listing at the revision of this state, every page in
   * and read at that revision (`queueStateOf`). False while the pages load again, as after a new
   * queue, or while they hold another revision, as a page whose subscription retries keeps its
   * last answer; `entries` may then lack `current`. A whole listing lacks `current` only when the
   * core leaves that entry out, as it does an entry whose song the listener may no longer play.
   */
  readonly complete: boolean;
  /** The entry playing; null for an empty queue. */
  readonly current: string | null;
  readonly shuffle: boolean;
  readonly repeat: RepeatMode;
  readonly autoplay: boolean;
}

/** What the engine is doing, as the UI sees it. */
export type EngineStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

/** Local player state the core does not hold. Replaced, never mutated. */
export interface ControllerSnapshot {
  readonly engineStatus: EngineStatus;
  readonly error: string | null;
  readonly mediaOnline: boolean;
  readonly quality: StreamQuality;
  readonly autoplayBlocked: boolean;
  /** The engine that plays (or will play) the audio here. */
  readonly engine: EngineKind;
  readonly volume: number;
  /**
   * The entry this player plays: the core's, or one this player moved to and the core has not
   * confirmed yet. Null for an empty queue.
   */
  readonly current: string | null;
  /**
   * How many times the position jumped here by a seek, so Connect's reports can tell a jump from
   * playback moving on (ADR 0018).
   */
  readonly seeks: number;
}

/** What this device plays, as Connect hears it (ADR 0018). */
export interface PlayingHere {
  readonly trackId: string;
  readonly itemId: string;
  /** Whether it plays, or means to once its song loads; false while paused. */
  readonly playing: boolean;
  readonly positionMs: number;
}

/** Where and how a new queue starts: from `positionMs` into its first song, playing or paused. */
export interface StartAt {
  readonly positionMs: number;
  readonly playing: boolean;
}

/** The core's current queue entry as this device knows it: a Connect move lands on it (ADR 0018). */
export type QueueCurrent =
  /** The queue has not arrived yet, or its listing is not whole and does not hold it yet. */
  | { readonly kind: "unknown" }
  | { readonly kind: "empty" }
  /** The whole listing leaves it out: its song is one the listener may not play. */
  | { readonly kind: "hidden" }
  | { readonly kind: "entry"; readonly itemId: string; readonly trackId: string };

/** Builds the audio engines; the controller switches between them as quality and support allow. */
export interface EngineFactory {
  /** What the gapless MSE engine can play here, or null when it cannot run (HTML audio only). */
  readonly mse: MseSupport | null;
  readonly create: (kind: EngineKind) => PlayerEngine;
}

/**
 * The system's now-playing surface: the lock screen, notifications, and hardware media keys. The
 * web routes it through the Media Session API (`media-session.ts`).
 */
export interface NowPlayingControls {
  /** Routes system media controls to `handlers`, or detaches them when `handlers` is null. */
  readonly setHandlers: (handlers: MediaSessionHandlers | null) => void;
  /** Shows `track` at `positionMs`, or clears the surface when nothing plays here. */
  readonly show: (track: NowPlayingTrack | null, playing: boolean, positionMs: number) => void;
}

/** The core's music commands the player sends. Each rejects with the SDK's tagged errors. */
export interface MusicCommands {
  /** `music.queue.play`: replaces the queue and answers the entry that plays. */
  readonly play: (
    trackIds: ReadonlyArray<string>,
    index: number | undefined,
  ) => Promise<{ readonly current: string }>;
  /**
   * `music.tracks.get`: a song's details, so a new queue's first song starts as soon as its ticket
   * answers, before the queue that holds it arrives.
   */
  readonly track: (trackId: string) => Promise<Track>;
  /** `music.queue.jump`: makes an entry the one playing. */
  readonly jump: (itemId: string) => Promise<void>;
  /** `music.play.report`: records a start that is playing in the listener's history. */
  readonly report: (trackId: string, playbackId: string) => Promise<void>;
}

/** Where playback stood when the page last saved it. */
export interface ResumePoint {
  readonly itemId: string;
  readonly positionMs: number;
}

/** The synced settings the player follows (D36): per person, and per device. */
export interface PlayerSettings {
  readonly quality: StreamQuality;
  readonly volume: number;
  /** Off plays through HTML audio, which leaves a short gap between songs. */
  readonly gapless: boolean;
}

/** What the controller needs from its host besides the core and the engine. */
export interface ControllerEnvironment {
  /** Answers `audio.canPlayType(mimeType) !== ""`. */
  readonly canPlay: (mimeType: string) => boolean;
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
  /**
   * Milliseconds on a clock that never jumps or runs backwards (`performance.now()`), to move the
   * position on between the engine's reports.
   */
  readonly monotonicNow: () => number;
  readonly settings: PlayerSettings;
  /** Saves a changed quality setting on this device. */
  readonly saveQuality: (quality: StreamQuality) => void;
  /** Saves a changed volume on this device. */
  readonly saveVolume: (volume: number) => void;
  readonly nowPlaying: NowPlayingControls;
  /** Where this device keeps its place in the playing song across page loads. */
  readonly resume: {
    readonly load: () => ResumePoint | null;
    readonly save: (point: ResumePoint | null) => void;
  };
}

/** The queue entry the engine holds. */
interface LoadedEntry {
  readonly entry: QueueEntry;
  /** The profile requested for this entry; null until its source resolves. */
  readonly profile: MusicStreamProfile | null;
  readonly url: string | null;
  /** See `ResolvedSource.renewAt`; null until its source resolves. */
  readonly renewAt: number | null;
  /** The start its ticket came from; null until its source resolves. */
  readonly playbackId: string | null;
  /** See `ResolvedSource.origin`; null until its source resolves. */
  readonly origin: ResolvedSource["origin"] | null;
  /** Whether its start is recorded in history. */
  readonly reported: boolean;
}

interface PreloadedEntry extends ResolvedSource {
  readonly entry: QueueEntry;
}

/** The preload the player calls for at one moment: the entry that plays next and its stream. */
interface PreloadRequest {
  /** The load it follows. A reload, or another song, starts a new one. */
  readonly generation: number;
  readonly entry: QueueEntry;
  readonly engine: EngineKind;
  readonly profile: MusicStreamProfile;
}

/** Whether two preload requests ask for the same stream after the same load. */
const samePreload = (a: PreloadRequest, b: PreloadRequest): boolean =>
  a.generation === b.generation &&
  a.entry.itemId === b.entry.itemId &&
  a.engine === b.engine &&
  a.profile === b.profile;

/** A move to another entry sent from here, which the core has not confirmed yet. */
interface PendingJump {
  readonly itemId: string;
  readonly sentAt: number;
}

/** What a load of a song gets: its source, or why nothing can play it. */
type Requested = Result.Result<ResolvedSource, StreamRefused | SourceUnreachable>;

/**
 * The song a new queue opens on, started while `music.queue.play` writes the queue: its details,
 * then its source. `started` is null when either failed; the queue's own entry then loads it as
 * before.
 */
interface EarlyStart {
  /** The song guessed: the one at the index the play named. */
  readonly trackId: string;
  /** The entry `music.queue.play` answered; null until it answers. */
  readonly itemId: string | null;
  readonly started: Promise<{ readonly track: Track; readonly source: Requested } | null>;
}

/**
 * Plays the listener's queue on this device. The core holds the queue and the entry playing
 * (`music.queue.*`); this device holds whether it plays and where in the song, as old music's
 * player did for the device that played (D62). Connect moves playback here and away, and plays,
 * pauses, or seeks it, through `playCurrentAt`, `playTracksAt`, `steer`, and `release`
 * (`connect-player.ts`, ADR 0018).
 *
 * Every request that waits on the network carries what it was made for, and its answer, a
 * failure included, applies only while that still holds: a ticket its load's generation, a
 * preload the entry and stream it asked for, a jump its own pending move, and a history report
 * its start. A new queue's answer plays its entry as the listener's newest choice says, not as
 * when the queue was sent, unless Connect let go of this device meanwhile; an entry the new queue
 * loaded before the answer plays or pauses as that choice says too. The media server's
 * recovery loads whatever entry is current once it answers. The engine's own events follow the
 * same rule: they belong to the load that gave the engine its source, and a later load, or an
 * unload, makes them stale until that load hands the engine its new source.
 */
export class PlaybackController {
  readonly #commands: MusicCommands;
  readonly #sources: SourceResolver;
  readonly #engines: EngineFactory;
  #engine: PlayerEngine;
  readonly #env: ControllerEnvironment;
  readonly #listeners = new Set<() => void>();
  /** What runs as the listener acts here, before the action: {@link onListenerAction}. */
  readonly #listenerActions = new Set<() => void>();
  #snapshot: ControllerSnapshot;

  #queue: QueueState | null = null;
  #pendingJump: PendingJump | null = null;
  /** The last move sent from here, even once the core's sync no longer waits for it. */
  #latestMove: PendingJump | null = null;
  #wantPlaying = false;
  /**
   * Whether the listener last chose to play, here or through Connect. `#wantPlaying` also follows
   * what the player does by itself, as stopping at the end of the queue; a new queue starts as the
   * listener chose.
   */
  #chosen = false;
  #gapless: boolean;
  #resumeAt: ResumePoint | null;
  #loaded: LoadedEntry | null = null;
  #preloaded: PreloadedEntry | null = null;
  /** The preload request in flight, if any. */
  #preloading: PreloadRequest | null = null;
  /** The new queue's first song, started ahead; the next load of that song takes it. */
  #early: EarlyStart | null = null;
  #generation = 0;
  /** The load whose source the engine plays; its events count only while it is `#generation`. */
  #engineGeneration = 0;
  #sample: PositionSnapshot = { positionMs: 0, updatedAt: 0, playing: false };
  readonly #transcode = new Set<string>();
  #mseFailed = false;
  #renewed: string | null = null;
  /**
   * Entries skipped one after another because nothing could play them, since a song last played
   * here or the listener last asked for one.
   */
  readonly #skipped = new Set<string>();
  #loading = false;
  /** Counts `release` calls, so a play whose queue answers after one does not start here. */
  #releases = 0;
  #unsubscribeEngine: (() => void) | null = null;
  #healthFiber: Fiber.Fiber<void, unknown> | null = null;
  #stop: (() => void) | null = null;

  constructor(
    commands: MusicCommands,
    sources: SourceResolver,
    engines: EngineFactory,
    env: ControllerEnvironment,
  ) {
    this.#commands = commands;
    this.#sources = sources;
    this.#engines = engines;
    this.#env = env;
    this.#gapless = env.settings.gapless;
    this.#resumeAt = env.resume.load();
    const engine = this.#engineFor(env.settings.quality);
    this.#engine = engines.create(engine);
    this.#engine.setVolume(env.settings.volume);

    this.#snapshot = {
      engineStatus: "idle",
      error: null,
      mediaOnline: true,
      quality: env.settings.quality,
      autoplayBlocked: false,
      engine,
      volume: env.settings.volume,
      current: null,
      seeks: 0,
    };
  }

  /** The current local state. Stable between changes, for `useSyncExternalStore`. */
  getSnapshot = (): ControllerSnapshot => this.#snapshot;

  /**
   * Calls `listener` after every local state change, and after every {@link sync}, which may change
   * the queue alone. Returns the unsubscribe function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Calls `callback` synchronously at the start of every action the listener takes here, before
   * it changes anything: {@link togglePlay}, {@link next}, {@link previous}, {@link seek},
   * {@link jump}, and {@link playTracks}, whether a screen, a shortcut, or the system media
   * controls asked. A play or pause that a native player applied itself, from the lock screen,
   * headphones, or CarPlay, calls it too, once the engine reports it (a `system` event).
   * Connect makes the requests seen so far moot there (ADR 0018). What Connect itself applies,
   * through `steer`, `playTracksAt`, `playCurrentAt`, and `release`, never calls it. Returns the
   * function that stops calling it.
   */
  onListenerAction(callback: () => void): () => void {
    this.#listenerActions.add(callback);

    return () => {
      this.#listenerActions.delete(callback);
    };
  }

  /**
   * Starts engine events, media keys, and saving the place in the song. Returns the function that
   * stops all of it and releases the audio.
   */
  start(): () => void {
    this.#stop?.();
    this.#unsubscribeEngine = this.#engine.subscribe(this.#onEngineEvent);

    const saves = setInterval(() => {
      if (this.#snapshot.engineStatus === "playing") this.#saveResume();
    }, RESUME_SAVE_MS);

    this.#env.nowPlaying.setHandlers({
      play: () => {
        if (!this.#isAudible()) void this.togglePlay();
      },
      pause: () => {
        if (this.#isAudible()) void this.togglePlay();
      },
      next: () => {
        void this.next();
      },
      previous: () => {
        void this.previous();
      },
      seekTo: (positionMs) => {
        this.seek(positionMs);
      },
    });

    const stop = (): void => {
      this.#saveResume();
      this.#unsubscribeEngine?.();
      this.#unsubscribeEngine = null;
      clearInterval(saves);
      this.#env.nowPlaying.setHandlers(null);
      this.#env.nowPlaying.show(null, false, 0);
      this.#stopHealthProbe();
      this.#unload();
      this.#stop = null;
    };

    this.#stop = stop;

    return stop;
  }

  /** Brings the player in line with the core's queue after it changed. */
  sync(queue: QueueState): void {
    this.#queue = queue;
    const pending = this.#pendingJump;

    if (pending !== null) {
      const confirmed = queue.current === pending.itemId;
      const stale = this.#env.now() - pending.sentAt > JUMP_GRACE_MS;

      if (confirmed || stale) this.#pendingJump = null;
    }

    if (this.#pendingJump === null) this.#follow(queue.current);
    else this.#loadPending();

    this.#dropStalePreload();
    this.#showNowPlaying();
    this.#notify();
  }

  /** Follows the settings after they changed on the server or on another device. */
  applySettings(settings: PlayerSettings): void {
    if (settings.volume !== this.#snapshot.volume) {
      this.#engine.setVolume(settings.volume);
      this.#update({ volume: settings.volume });
    }

    if (settings.quality !== this.#snapshot.quality) this.#takeQuality(settings.quality);

    if (settings.gapless !== this.#gapless) {
      this.#gapless = settings.gapless;
      this.#dropPreload();
    }
  }

  /**
   * The live position in milliseconds, fresh on every call, so an animation frame can read it: the
   * engine's last report advanced by the time since while it plays, held while paused or buffering.
   */
  positionMs(): number {
    return this.#livePositionMs();
  }

  /**
   * Replaces the queue with `trackIds` and plays the one at `index` here. That song's ticket is
   * asked for while the core writes the queue, so it plays once the queue's answer and its ticket
   * are both in, without waiting for the new queue to arrive. A song this device holds a copy of
   * waits for the new queue to name it, as the core may open the queue on another. A queue command
   * that fails plays nothing. A pause chosen while the queue is written holds: the new queue starts
   * paused.
   */
  async playTracks(trackIds: ReadonlyArray<string>, index?: number): Promise<void> {
    this.#listenerActed();
    await this.#replaceQueue(trackIds, index, () => null);
  }

  /**
   * Replaces the queue with `trackIds` and starts its first song here, as a Connect load of a song
   * or an album asks (ADR 0018), the way {@link playTracks} plays a list. Answers the entry the new
   * queue plays here, or null when none does: the queue command failed, or Connect let go of this
   * device while the queue was written.
   *
   * @param startAt - Where the first song starts and whether it plays, asked as the queue is sent
   *   and again once it answers: the load's newest ask, or null once a newer request or the
   *   listener replaced the load, when the queue starts as the listener last chose.
   */
  playTracksAt(
    trackIds: ReadonlyArray<string>,
    startAt: () => StartAt | null,
  ): Promise<string | null> {
    return this.#replaceQueue(trackIds, 0, startAt);
  }

  async #replaceQueue(
    trackIds: ReadonlyArray<string>,
    index: number | undefined,
    startAt: () => StartAt | null,
  ): Promise<string | null> {
    this.#unlockOutput();
    this.#skipped.clear();
    this.#choose(startAt()?.playing ?? true);
    this.#update({ error: null });
    const picked = trackIds[index ?? 0];
    const early = picked === undefined ? null : this.#startEarly(picked);

    this.#early = early;
    const releases = this.#releases;

    try {
      const { current } = await this.#commands.play(trackIds, index);

      // Connect moved playback to another device meanwhile; the queue is its now.
      if (this.#releases !== releases) return null;

      const answered =
        early !== null && this.#early === early ? { ...early, itemId: current } : null;

      if (answered !== null) this.#early = answered;
      const at = startAt();

      if (at !== null) this.#choose(at.playing);
      this.#moveTo(current, this.#chosen, answered, at?.positionMs ?? 0);

      return current;
    } catch (error) {
      if (this.#early === early) this.#early = null;
      this.#update({ error: messageOf(error) });

      return null;
    }
  }

  /**
   * Primes the output for playback that starts after an await, such as a play button that loads
   * an album before {@link playTracks}. Call it synchronously in the tap, before any await: iOS
   * Safari lets audio start later only once it was started inside a gesture.
   */
  primeOutput(): void {
    this.#unlockOutput();
  }

  /** Plays or pauses. The engine reacts at once, inside the tap, which satisfies autoplay rules. */
  async togglePlay(): Promise<void> {
    this.#listenerActed();
    const entry = this.#currentEntry();

    if (entry === null) {
      // A song here the queue does not hold yet, as a new queue's first while that queue is on its
      // way, plays or pauses as tapped.
      const here = this.playingHere();

      if (here === null) return;

      if (!here.playing) this.#unlockOutput();
      this.steer(!here.playing, here.positionMs);

      return;
    }

    this.#skipped.clear();

    if (this.#needsSource(entry)) {
      this.#unlockOutput();
      this.#choose(true);
      this.#update({ autoplayBlocked: false, error: null });
      await this.#load(entry, this.#startPositionFor(entry));

      return;
    }

    const playing = this.#isAudible();
    this.#choose(!playing);
    this.#update({ autoplayBlocked: false, error: null });

    if (playing) {
      this.#engine.pause();
      this.#saveResume();
    } else if (!this.#reloadIfExpired(this.#livePositionMs())) {
      await this.#engine.play();
    }
  }

  /** Plays the next entry, wrapping when repeat is all; at the end of the queue it does nothing. */
  async next(): Promise<void> {
    this.#listenerActed();
    const queue = this.#queue;
    const at = this.#currentIndex();

    this.#skipped.clear();

    if (queue === null || at === null) return;

    const index = nextIndex(at, queue.entries.length, queue.repeat);
    const entry = index === null ? undefined : queue.entries[index];

    if (entry !== undefined) await this.#jumpTo(entry.itemId, this.#keepsPlaying());
  }

  /** Starts the song again once it played a little, else plays the entry before. */
  async previous(): Promise<void> {
    this.#listenerActed();
    const queue = this.#queue;
    const at = this.#currentIndex();

    this.#skipped.clear();

    if (queue === null || at === null) return;

    const index = previousIndex(this.#livePositionMs(), at, queue.entries.length, queue.repeat);
    const entry = queue.entries[index];

    if (index === at || entry === undefined) {
      this.#seek(0);

      return;
    }

    await this.#jumpTo(entry.itemId, this.#keepsPlaying());
  }

  /** Plays the queue entry `itemId`. */
  async jump(itemId: string): Promise<void> {
    this.#listenerActed();
    this.#unlockOutput();
    this.#skipped.clear();
    this.#choose(true);
    await this.#jumpTo(itemId, true);
  }

  /** Seeks the engine at once. */
  seek(positionMs: number): void {
    this.#listenerActed();
    this.#seek(positionMs);
  }

  #seek(positionMs: number): void {
    const target = Math.max(0, Math.round(positionMs));
    const loaded = this.#loaded;

    if (loaded === null) {
      const itemId = this.#currentEntry()?.itemId ?? this.#arriving()?.itemId ?? null;

      if (itemId !== null) this.#resumeAt = { itemId, positionMs: target };
      this.#stamp(target, false);

      return;
    }

    if (this.#loading) {
      this.#unload();
      void this.#load(loaded.entry, target);
    } else if (!this.#reloadIfExpired(target)) this.#engine.seek(target);
    this.#setPosition(target);
    this.#update({ seeks: this.#snapshot.seeks + 1 });
    this.#showNowPlaying();
    this.#saveResume();
  }

  /**
   * What this device plays for Connect's reports (ADR 0018): the song loaded here, or a new queue's
   * first song still on its way here once the queue answered, whether it plays, and where. Null
   * while no song is loaded or on its way here, as before the first play or after {@link release}.
   */
  playingHere(): PlayingHere | null {
    const loaded = this.#loaded;

    if (loaded !== null) {
      return {
        trackId: loaded.entry.track.id,
        itemId: loaded.entry.itemId,
        playing: this.#isAudible(),
        positionMs: Math.round(this.#livePositionMs()),
      };
    }

    const arriving = this.#arriving();

    if (arriving === null) return null;

    return {
      ...arriving,
      playing: this.#wantPlaying,
      positionMs: this.#resumeAt?.itemId === arriving.itemId ? this.#resumeAt.positionMs : 0,
    };
  }

  /**
   * Plays or pauses the song loaded here at `positionMs`, as a Connect request asks (ADR 0018), and
   * answers whether a song was loaded or on its way here to apply it to. A position within a
   * quarter second of where the song is stays, so a request never makes the sound jump for nothing.
   * A song whose source failed loads again from `positionMs` when asked to play. A new queue's
   * first song still on its way here starts as asked.
   */
  steer(playing: boolean, positionMs: number): boolean {
    const loaded = this.#loaded;
    const target = Math.max(0, Math.round(positionMs));

    if (loaded === null) return this.#steerArriving(playing, target);

    this.#skipped.clear();
    this.#choose(playing);
    this.#steerLoaded(loaded, target);

    return true;
  }

  /**
   * The core's current queue entry and its song, as far as the queue this device holds tells:
   * unknown before the queue arrives, or while its listing is not whole and lacks it, as while
   * pages load again after a new queue or hold another revision, and hidden once the whole listing
   * leaves it out. A Connect load of a song waits on it to tell a move, which plays that entry,
   * from a song that replaces the queue (ADR 0018).
   */
  queueCurrent(): QueueCurrent {
    const queue = this.#queue;

    if (queue === null) return { kind: "unknown" };

    if (queue.current === null) return { kind: "empty" };
    const entry = this.#entryOf(queue.current);

    if (entry !== null) return { kind: "entry", itemId: entry.itemId, trackId: entry.track.id };

    return queue.complete ? { kind: "hidden" } : { kind: "unknown" };
  }

  /**
   * Plays the core's current queue entry here from `positionMs`, playing or paused, when it holds
   * `trackId`, as when Connect moves playback onto this device (ADR 0018); the queue stays as it
   * is. Answers false, changing nothing, when the current entry holds another song or none.
   */
  playCurrentAt(trackId: string, positionMs: number, playing: boolean): boolean {
    const entry = this.#entryOf(this.#queue?.current ?? null);

    if (entry === null || entry.track.id !== trackId) return false;

    this.#skipped.clear();
    this.#early = null;
    this.#pendingJump = null;
    this.#choose(playing);
    this.#resumeAt = null;
    this.#update({ current: entry.itemId, error: null, autoplayBlocked: false });
    void this.#load(entry, Math.max(0, Math.round(positionMs)));

    return true;
  }

  /**
   * Stops playing here and lets go of the song, as when Connect moves playback to another device,
   * or another of the listener's devices plays while this one is paused (ADR 0018). The queue
   * stays, and this device keeps its place in the song, paused, as after a stop.
   */
  release(): void {
    this.#releases += 1;
    this.#choose(false);
    const here = this.playingHere();

    this.#early = null;

    if (here === null) return;

    this.#saveResume();
    this.#unload();
    this.#resumeAt = { itemId: here.itemId, positionMs: here.positionMs };
    this.#stamp(here.positionMs, false);
    this.#update({ engineStatus: "idle", error: null, autoplayBlocked: false });
    this.#showNowPlaying();
  }

  /**
   * Gives the entry loaded here, `fromItemId`, the id `toItemId` the core now holds it under, as
   * when a phone's own queue goes back to the core as a new one. The song stays where it is,
   * playing or paused, when the queue that names `toItemId` arrives, instead of loading again from
   * the start; an entry that turns out to hold another song loads that song, as any wrong guess.
   */
  adoptEntry(fromItemId: string, toItemId: string): void {
    const loaded = this.#loaded;

    if (loaded?.entry.itemId !== fromItemId) return;
    this.#loaded = { ...loaded, entry: { ...loaded.entry, itemId: toItemId } };

    if (this.#snapshot.current === fromItemId) this.#update({ current: toItemId });
  }

  /** Sets the volume here at once and saves it on this device. */
  setVolume(volume: number): void {
    const value = Math.min(1, Math.max(0, volume));

    this.#engine.setVolume(value);
    this.#update({ volume: value });
    this.#env.saveVolume(value);
  }

  /** Saves the quality setting. It applies from the next song so the current one never skips. */
  setQuality(quality: StreamQuality): void {
    if (quality === this.#snapshot.quality) return;
    this.#env.saveQuality(quality);
    this.#takeQuality(quality);
  }

  /**
   * Loads the current song again from where it was after a failure, as the media health check
   * does once the server answers again. A song that still fails shows its error.
   */
  retry(): void {
    if (this.#snapshot.engineStatus !== "error") return;
    this.#skipped.clear();
    this.#stopHealthProbe();
    this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
    void this.#loadCurrent();
  }

  /**
   * Awaits a core call. A failure becomes the player `error` instead of a rejection, so UI
   * handlers can fire and forget.
   */
  async capture(call: Promise<unknown>): Promise<void> {
    await this.attempt(call);
  }

  /**
   * Like {@link capture}, for callers that act on the outcome: resolves `true` once the call
   * landed, or `false` after a failure, which still becomes the player `error`.
   */
  async attempt(call: Promise<unknown>): Promise<boolean> {
    try {
      await call;

      return true;
    } catch (error) {
      this.#update({ error: messageOf(error) });

      return false;
    }
  }

  #takeQuality(quality: StreamQuality): void {
    this.#update({ quality });
    this.#dropPreload();
  }

  /** Follows the core's entry: a move made elsewhere loads it, playing if this device played. */
  #follow(current: string | null): void {
    if (current === null) {
      this.#wantPlaying = false;
      this.#unload();
      this.#update({ current: null, engineStatus: "idle", error: null, autoplayBlocked: false });

      return;
    }

    this.#update({ current });
    const entry = this.#currentEntry();

    if (entry === null) return;

    if (this.#loaded?.entry.itemId === entry.itemId) {
      this.#refreshLoaded();

      return;
    }

    // A device that holds a song, paused included, takes the new entry, as old music's active device
    // did, so Connect still finds it playing the queue and a remote's play reaches it (ADR 0018).
    if (this.#wantPlaying || this.#loaded !== null) {
      // From the start, unless this device holds a place in it, as in the song that stopped when
      // the media server went away.
      void this.#load(entry, this.#resumePositionFor(entry));

      return;
    }

    // Shows where this device left the song, paused, until it plays, and any other from its start.
    this.#stamp(this.#resumeAt?.itemId === entry.itemId ? this.#resumeAt.positionMs : 0, false);
  }

  /** Loads the entry this player moved to once the queue that holds it arrives. */
  #loadPending(): void {
    const entry = this.#currentEntry();

    if (entry === null) return;

    if (this.#loaded?.entry.itemId === entry.itemId) {
      this.#refreshLoaded();

      return;
    }

    if (this.#loaded === null && this.#wantPlaying) {
      void this.#load(entry, this.#resumePositionFor(entry));
    }
  }

  /**
   * Keeps the loaded entry's song details current, such as a like, without reloading it. An entry
   * that holds another song than the one loaded for it loads that song: the guess a new queue's
   * first song starts from (`#startEarly`) was wrong, as when the core skipped a missing file.
   */
  #refreshLoaded(): void {
    const loaded = this.#loaded;
    const entry = loaded === null ? null : this.#entryOf(loaded.entry.itemId);

    if (loaded === null || entry === null) return;

    if (entry.track.id === loaded.entry.track.id) this.#loaded = { ...loaded, entry };
    else void this.#load(entry, 0);
  }

  /** Moves to `itemId` here at once and tells the core, which confirms it with the next sync. */
  async #jumpTo(itemId: string, play: boolean): Promise<void> {
    const pending = this.#moveTo(itemId, play);

    try {
      await this.#commands.jump(itemId);
    } catch (error) {
      // A later move replaced this one, so this failure no longer describes what plays here.
      if (this.#latestMove !== pending) return;
      this.#pendingJump = null;
      this.#update({ error: messageOf(error) });

      if (this.#queue !== null) this.sync(this.#queue);
    }
  }

  /**
   * Moves to `itemId` here at once, from `startMs` into it. Returns the pending move, which the
   * core's sync confirms. `early` is the song started ahead for a new queue whose first entry
   * `itemId` is.
   */
  #moveTo(
    itemId: string,
    play: boolean,
    early: EarlyStart | null = null,
    startMs = 0,
  ): PendingJump {
    const pending = this.#sendMove(itemId);

    this.#wantPlaying = play;
    // Every load of `itemId` below, or by `sync` once its queue arrives, starts here.
    this.#resumeAt = startMs > 0 ? { itemId, positionMs: startMs } : null;
    this.#update({ current: itemId, error: null });
    const entry = this.#entryOf(itemId);
    const loaded = this.#loaded;

    if (entry === null) {
      // The queue that holds it has not arrived yet; `sync` loads it once it does, unless the
      // song started ahead gets there first.
      this.#unload();

      if (early !== null) void this.#loadEarly(itemId, early);
    } else if (loaded?.entry.itemId !== itemId || play) {
      void this.#load(entry, this.#resumePositionFor(entry));
    } else {
      // Loaded already, as when a new queue arrived and loaded its first song before its write
      // answered: the song stays loaded, and moves to `startMs` and pauses as this move asks.
      this.#steerLoaded(loaded, this.#resumePositionFor(entry));
    }

    return pending;
  }

  /**
   * Asks for `trackId`'s details and then its ticket, while the core writes the queue that opens
   * on it. `music.play.start` does not need the queue, so the song can play as soon as both answer.
   */
  #startEarly(trackId: string): EarlyStart {
    const started = this.#commands.track(trackId).then(
      async (track) => ({
        track,
        source: await this.#sources.resolve(
          track,
          this.#profileFor(track, this.#wantedEngine()),
          this.#reach(),
        ),
      }),
      () => null,
    );

    return { trackId, itemId: null, started };
  }

  /**
   * Loads the new queue's first entry `itemId` with the song started ahead, once it answers,
   * unless the listener moved on or the queue that holds it arrived and loaded it meanwhile.
   *
   * The core opens a new queue on the song at the index asked for unless it can't play that song
   * (its file went missing), and then on the next one it can. A stream's ticket shows the server
   * plays the guessed song, so the entry holds it. A copy on this device shows nothing of the
   * kind, so a song started from one waits for the queue to name the entry's song.
   */
  async #loadEarly(itemId: string, early: EarlyStart): Promise<void> {
    const started = await early.started;

    if (
      started === null ||
      Result.isFailure(started.source) ||
      started.source.success.origin !== "stream" ||
      this.#early !== early ||
      this.#snapshot.current !== itemId ||
      this.#loaded !== null
    ) {
      return;
    }

    const entry: QueueEntry = { itemId, autoplay: false, track: started.track };

    await this.#load(entry, this.#resumePositionFor(entry));
  }

  /**
   * The source started ahead for the new queue's first entry, taken once by that entry's load,
   * its refusal included. Null when it was started for another entry, the entry holds another song
   * than the one guessed, its details failed, it is in another profile than `profile`, or it is
   * due for renewal: the load then asks for a source itself.
   */
  async #takeEarly(entry: QueueEntry, profile: MusicStreamProfile): Promise<Requested | null> {
    const early = this.#early;

    if (early === null || early.itemId !== entry.itemId) return null;
    this.#early = null;

    if (early.trackId !== entry.track.id) return null;
    const started = await early.started;

    if (started === null) return null;
    const { source } = started;

    if (Result.isFailure(source)) return source;

    return source.success.profile === profile && !this.#isExpired(source.success.renewAt)
      ? source
      : null;
  }

  /** Records a move to `itemId` made here, which the core has not confirmed yet. */
  #sendMove(itemId: string): PendingJump {
    const move: PendingJump = { itemId, sentAt: this.#env.now() };

    this.#pendingJump = move;
    this.#latestMove = move;

    return move;
  }

  #keepsPlaying(): boolean {
    return this.#wantPlaying || this.#isAudible();
  }

  /**
   * The entry this player is on while its song, a new queue's first, is still on its way here: the
   * queue answered, and the song started ahead has not loaded yet (`#loadEarly`). Connect counts it
   * as the song here, so a request that names it waits for it instead of missing it.
   */
  #arriving(): { readonly itemId: string; readonly trackId: string } | null {
    const early = this.#early;

    if (this.#loaded !== null || early === null || early.itemId !== this.#snapshot.current) {
      return null;
    }

    return early.itemId === null ? null : { itemId: early.itemId, trackId: early.trackId };
  }

  #steerArriving(playing: boolean, target: number): boolean {
    const arriving = this.#arriving();

    if (arriving === null) return false;

    this.#skipped.clear();
    this.#choose(playing);
    const entry = this.#entryOf(arriving.itemId);

    if (playing && entry !== null) {
      this.#update({ autoplayBlocked: false, error: null });
      void this.#load(entry, target);
    } else {
      this.#resumeAt = { itemId: arriving.itemId, positionMs: target };
      this.#stamp(target, false);
    }

    return true;
  }

  /**
   * Moves the song loaded here to `target` unless it is within a quarter second of it, then plays
   * or pauses it as `#wantPlaying` says, so the engine ends doing what the controller means to. A
   * song whose source failed loads again from `target` when it is to play.
   */
  #steerLoaded(loaded: LoadedEntry, target: number): void {
    const playing = this.#wantPlaying;

    if (this.#needsSource(loaded.entry)) {
      if (playing) {
        this.#update({ autoplayBlocked: false, error: null });
        void this.#load(loaded.entry, target);
      } else this.#stamp(target, false);

      return;
    }

    if (Math.abs(this.#livePositionMs() - target) > STEER_TOLERANCE_MS) this.#seek(target);

    // A load under way plays or pauses as `#wantPlaying` says once its source lands.
    if (this.#loading) return;
    const audible = this.#isAudible();

    if (playing && !audible) {
      this.#update({ autoplayBlocked: false, error: null });

      if (!this.#reloadIfExpired(this.#livePositionMs())) void this.#engine.play();
    } else if (!playing && audible) {
      this.#engine.pause();
      this.#saveResume();
    }
  }

  #choose(playing: boolean): void {
    this.#chosen = playing;
    this.#wantPlaying = playing;
  }

  #entryOf(itemId: string | null): QueueEntry | null {
    if (itemId === null) return null;

    return this.#queue?.entries.find((entry) => entry.itemId === itemId) ?? null;
  }

  #currentEntry(): QueueEntry | null {
    return this.#entryOf(this.#snapshot.current);
  }

  #currentIndex(): number | null {
    const current = this.#snapshot.current;
    const index = this.#queue?.entries.findIndex((entry) => entry.itemId === current) ?? -1;

    return index === -1 ? null : index;
  }

  #resumePositionFor(entry: QueueEntry): number {
    const resume = this.#resumeAt;

    this.#resumeAt = null;

    return resume?.itemId === entry.itemId ? resume.positionMs : 0;
  }

  /** Where `entry` starts when it loads: where the player holds it, else where this device left it. */
  #startPositionFor(entry: QueueEntry): number {
    return this.#loaded?.entry.itemId === entry.itemId
      ? this.#livePositionMs()
      : this.#resumePositionFor(entry);
  }

  /**
   * Whether `entry` has nothing to play here: another entry is loaded, or its ticket failed or
   * never came, as while the media server was away, and no load is under way.
   */
  #needsSource(entry: QueueEntry): boolean {
    const loaded = this.#loaded;

    return (
      loaded === null ||
      loaded.entry.itemId !== entry.itemId ||
      (loaded.url === null && !this.#loading)
    );
  }

  /** Loads the current entry from where the player holds it. */
  async #loadCurrent(): Promise<void> {
    const entry = this.#currentEntry();

    if (entry !== null) await this.#load(entry, this.#startPositionFor(entry));
  }

  #saveResume(): void {
    const loaded = this.#loaded;

    if (loaded === null) return;

    this.#env.resume.save({
      itemId: loaded.entry.itemId,
      positionMs: Math.round(this.#livePositionMs()),
    });
  }

  /**
   * Runs synchronously at the start of the tap handlers that start playback here, before any
   * await: it switches to the engine that will play and primes its audio element, so the `play()`
   * that follows the core's answer is allowed on iOS Safari. Output already playing needs nothing.
   */
  #unlockOutput(): void {
    if (this.#isAudible()) return;
    this.#useEngine(this.#wantedEngine());
    this.#engine.unlock?.();
  }

  #listenerActed(): void {
    for (const callback of this.#listenerActions) callback();
  }

  #update(patch: Partial<ControllerSnapshot>): void {
    const current = this.#snapshot;
    const next = { ...current, ...patch };

    const unchanged =
      next.engineStatus === current.engineStatus &&
      next.error === current.error &&
      next.mediaOnline === current.mediaOnline &&
      next.quality === current.quality &&
      next.autoplayBlocked === current.autoplayBlocked &&
      next.engine === current.engine &&
      next.volume === current.volume &&
      next.current === current.current &&
      next.seeks === current.seeks;

    if (unchanged) return;
    this.#snapshot = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #livePositionMs(): number {
    return livePosition(
      this.#sample,
      this.#env.monotonicNow(),
      this.#loaded?.entry.track.durationMs ?? 0,
    );
  }

  #stamp(positionMs: number, playing: boolean): void {
    this.#sample = { positionMs, updatedAt: this.#env.monotonicNow(), playing };
  }

  #setPosition(positionMs: number): void {
    this.#stamp(positionMs, this.#sample.playing);
  }

  #setMoving(playing: boolean): void {
    this.#stamp(this.#livePositionMs(), playing);
  }

  #isAudible(): boolean {
    const status = this.#snapshot.engineStatus;

    if (this.#snapshot.autoplayBlocked) return false;

    if (status === "loading") return this.#wantPlaying;

    return status === "playing" || status === "buffering";
  }

  #engineFor(quality: StreamQuality): EngineKind {
    return this.#gapless ? chooseEngine(quality, this.#engines.mse, this.#mseFailed) : "html";
  }

  #wantedEngine(): EngineKind {
    return this.#engineFor(this.#snapshot.quality);
  }

  #useEngine(kind: EngineKind): void {
    if (kind === this.#snapshot.engine) return;
    this.#engine.unload();
    const listening = this.#unsubscribeEngine !== null;
    this.#unsubscribeEngine?.();
    this.#engine = this.#engines.create(kind);
    this.#unsubscribeEngine = listening ? this.#engine.subscribe(this.#onEngineEvent) : null;
    this.#engine.setVolume(this.#snapshot.volume);
    this.#preloaded = null;
    this.#update({ engine: kind });
  }

  #unload(): void {
    this.#generation += 1;
    this.#loading = false;
    this.#engine.unload();
    this.#loaded = null;
    this.#preloaded = null;
    this.#preloading = null;
    this.#stamp(0, false);
  }

  /** Drops the preload here and in the engine. */
  #dropPreload(): void {
    this.#engine.preload(null);
    this.#preloaded = null;
  }

  /**
   * The preloaded source when it is `entry`'s and its ticket still holds; the engine then plays it
   * from its preload. Any other preload stays only while it still follows `entry`, as through a
   * reload of the same song, and is otherwise dropped here and in the engine, which keeps a
   * preload across loads until told otherwise. Runs once `entry` is the loaded one.
   */
  #takePreload(entry: QueueEntry): ResolvedSource | null {
    const preloaded = this.#preloaded;

    if (preloaded?.entry.itemId !== entry.itemId) {
      this.#dropStalePreload();

      return null;
    }

    this.#preloaded = null;

    if (!this.#isExpired(preloaded.renewAt)) return preloaded;
    this.#engine.preload(null);

    return null;
  }

  #isExpired(renewAt: number | null): boolean {
    return renewAt !== null && this.#env.now() >= renewAt;
  }

  #reloadIfExpired(positionMs: number): boolean {
    const loaded = this.#loaded;

    if (loaded === null || !this.#isExpired(loaded.renewAt)) return false;
    void this.#load(loaded.entry, positionMs);

    return true;
  }

  async #load(entry: QueueEntry, startMs: number): Promise<void> {
    this.#generation += 1;
    this.#loading = true;
    const generation = this.#generation;
    const { track } = entry;

    try {
      this.#loaded = {
        entry,
        profile: null,
        url: null,
        renewAt: null,
        playbackId: null,
        origin: null,
        reported: false,
      };
      this.#stamp(startMs, false);
      // While the media server is away only a copy on this device plays, as old music's player
      // allowed: the song waits for the server otherwise.
      const reach = this.#reach();
      const engine = this.#wantedEngine();
      this.#update({ engineStatus: "loading", error: null, autoplayBlocked: false });
      // A switch drops the preload with the engine that held it.
      this.#useEngine(engine);

      const profile = this.#profileFor(track, engine);
      const preloaded = this.#takePreload(entry);
      const ahead = preloaded === null ? await this.#takeEarly(entry, profile) : null;

      if (generation !== this.#generation) return;

      const requested: Requested =
        preloaded === null
          ? (ahead ?? (await this.#sources.resolve(track, profile, reach)))
          : Result.succeed(preloaded);

      // A ticket that answers after the listener moved on, a failure included, is not this song's.
      if (generation !== this.#generation) return;

      if (
        reach === "device" &&
        (Result.isFailure(requested) || requested.success.origin !== "local")
      ) {
        // A copy that played meanwhile stops, so it does not play under this song's name.
        this.#engine.unload();
        this.#stamp(startMs, false);
        this.#update({ engineStatus: "error", error: MEDIA_OFFLINE_MESSAGE });

        // A skip already under way goes on to the next song with a copy; a song the listener
        // asked for waits for the server.
        if (this.#skipped.size > 0) this.#skipUnreachable(entry);

        return;
      }

      if (Result.isFailure(requested)) {
        // The song before stops too, so nothing plays under the name of a song that did not start.
        this.#engine.unload();
        this.#stamp(startMs, false);
        this.#update({ engineStatus: "error", error: requested.failure.message });

        if (requested.failure instanceof SourceUnreachable) this.#skipUnreachable(entry);

        return;
      }

      const resolved = requested.success;

      this.#loaded = {
        entry,
        profile: resolved.profile,
        url: resolved.source.url,
        renewAt: resolved.renewAt,
        playbackId: resolved.playbackId,
        origin: resolved.origin,
        reported: false,
      };

      // The song starts where the listener left it, however long its ticket took: no clock is
      // shared with another player that kept time meanwhile.
      const start = Math.min(startMs, Math.max(0, track.durationMs - 1000));
      this.#setPosition(start);
      this.#engineGeneration = generation;
      await this.#engine.load(resolved.source, start, this.#wantPlaying);

      if (
        generation !== this.#generation ||
        (this.#snapshot.engineStatus !== "playing" && this.#snapshot.engineStatus !== "paused")
      )
        return;

      if (
        !this.#snapshot.autoplayBlocked &&
        this.#engine.samplePlayback().playing !== this.#wantPlaying
      ) {
        if (this.#wantPlaying) await this.#engine.play();
        else this.#engine.pause();
      }
    } finally {
      if (generation === this.#generation) this.#loading = false;
    }

    if (generation === this.#generation && this.#snapshot.engineStatus === "playing") {
      this.#reportPlay();
    }
  }

  /**
   * Moves on from `entry`, which nothing can play now, to the entry after it, as old music's player
   * skipped a song it could not reach. The error stays on screen when no entry follows, or when the
   * one that follows was skipped too since a song last played, so a queue nothing can play stops.
   * A queue that no longer holds `entry`, as a phone's own queue of copies holds no song it can't
   * play, already moved on: the move to `entry` the core never confirmed ends, and the player
   * follows that queue's entry.
   */
  #skipUnreachable(entry: QueueEntry): void {
    this.#skipped.add(entry.itemId);
    const queue = this.#queue;
    const at = queue?.entries.findIndex((queued) => queued.itemId === entry.itemId) ?? -1;

    if (queue === null) return;

    if (at === -1) {
      if (this.#pendingJump?.itemId !== entry.itemId) return;
      this.#pendingJump = null;
      this.#follow(queue.current);

      return;
    }

    const index = nextIndex(at, queue.entries.length, queue.repeat);
    const following = index === null ? undefined : queue.entries[index];

    if (following === undefined || this.#skipped.has(following.itemId)) return;
    void this.#jumpTo(following.itemId, this.#wantPlaying);
  }

  /**
   * Stops `loaded`'s damaged copy while the media server is away and skips to the next song with a
   * copy, without asking the server for a stream.
   */
  #skipDamagedCopy(loaded: LoadedEntry): void {
    const positionMs = this.#livePositionMs();

    this.#generation += 1;
    this.#loading = false;
    this.#engine.unload();
    this.#loaded = { ...loaded, url: null, origin: null, playbackId: null, renewAt: null };
    this.#stamp(positionMs, false);
    this.#update({ engineStatus: "error", error: MEDIA_OFFLINE_MESSAGE });
    this.#skipUnreachable(loaded.entry);
  }

  #profileFor(track: Track, engine: EngineKind): MusicStreamProfile {
    const support = this.#engines.mse;

    if (engine === "mse" && support !== null) {
      return chooseGaplessProfile(this.#snapshot.quality, track.lossless, support);
    }

    return this.#transcode.has(track.id)
      ? "aac-320"
      : chooseStreamProfile(this.#snapshot.quality, track.codec, this.#env.canPlay);
  }

  /**
   * Records the loaded entry's start in history once it plays, once per start. A failure shows
   * only while that start is still the one loaded.
   */
  #reportPlay(): void {
    const loaded = this.#loaded;

    if (loaded === null || loaded.reported || loaded.playbackId === null) return;

    this.#loaded = { ...loaded, reported: true };
    void this.#report(loaded.entry.track.id, loaded.playbackId);
  }

  async #report(trackId: string, playbackId: string): Promise<void> {
    try {
      await this.#commands.report(trackId, playbackId);
    } catch (error) {
      if (this.#loaded?.playbackId === playbackId) this.#update({ error: messageOf(error) });
    }
  }

  #followingEntry(): QueueEntry | null {
    const queue = this.#queue;
    const loaded = this.#loaded;

    if (queue === null || loaded === null) return null;

    const at = queue.entries.findIndex((entry) => entry.itemId === loaded.entry.itemId);

    if (at === -1) return null;

    const index = followingIndex(at, queue.entries.length, queue.repeat);

    return index === null ? null : (queue.entries[index] ?? null);
  }

  /**
   * The preload the player calls for now: the entry that plays next by itself, in the profile the
   * engine playing asks for. Null when nothing should load ahead.
   */
  #preloadRequest(): PreloadRequest | null {
    const engine = this.#snapshot.engine;

    if (this.#wantedEngine() !== engine) return null;
    const entry = this.#followingEntry();

    if (entry === null) return null;

    return {
      generation: this.#generation,
      entry,
      engine,
      profile: this.#profileFor(entry.track, engine),
    };
  }

  async #preloadFollowing(): Promise<void> {
    const loaded = this.#loaded;

    if (loaded === null || this.#preloaded !== null || this.#preloading !== null || this.#loading) {
      return;
    }

    if (loaded.entry.track.durationMs - this.#livePositionMs() > PRELOAD_LEAD_MS) return;
    const request = this.#preloadRequest();

    if (request === null) return;
    this.#preloading = request;
    const reach = this.#reach();
    const resolved = await this.#sources.resolve(request.entry.track, request.profile, reach);

    if (this.#preloading === request) this.#preloading = null;

    // Repeat one, a reordered queue, another song or another quality since the request each call
    // for another preload, or none.
    const wanted = this.#preloadRequest();

    if (Result.isFailure(resolved) || wanted === null || !samePreload(request, wanted)) return;

    // A stream answered just before the media server went away won't play.
    if (reach !== this.#reach() || (reach === "device" && resolved.success.origin !== "local")) {
      return;
    }

    this.#engine.preload(resolved.success.source);
    this.#preloaded = { entry: wanted.entry, ...resolved.success };
  }

  #dropStalePreload(): void {
    const preloaded = this.#preloaded;

    if (preloaded === null) return;
    const following = this.#followingEntry();

    if (following?.itemId === preloaded.entry.itemId) {
      this.#preloaded = { ...preloaded, entry: following };

      return;
    }

    this.#dropPreload();
  }

  #onEngineEvent = (event: EngineEvent): void => {
    // The person's own choice, made outside the app. It holds for whatever plays here next too, so
    // it counts even while another song's ticket is out.
    if (event.type === "system") {
      this.#systemAction(event.playing);

      return;
    }

    // The outgoing source still sounds while the next one's ticket is out, and its position, its
    // failure, and its end describe a song the player has moved on from.
    if (this.#engineGeneration !== this.#generation) return;

    switch (event.type) {
      case "time": {
        this.#setPosition(this.#engine.samplePlayback().positionMs);
        void this.#preloadFollowing();
        break;
      }

      case "playing":
      case "paused": {
        const { playing } = this.#engine.samplePlayback();
        this.#setMoving(playing);

        if (playing) {
          this.#renewed = null;
          this.#skipped.clear();
        }

        this.#update(
          playing
            ? { engineStatus: "playing", error: null, autoplayBlocked: false }
            : { engineStatus: "paused" },
        );
        this.#showNowPlaying();

        if (playing && !this.#loading) this.#reportPlay();
        break;
      }

      case "waiting": {
        this.#setMoving(false);
        this.#update({ engineStatus: "buffering" });
        break;
      }

      case "advanced": {
        this.#onAdvanced();
        break;
      }

      case "ended": {
        this.#setMoving(false);
        this.#onEnded();
        break;
      }

      case "error": {
        this.#setMoving(false);
        this.#update({ engineStatus: "error" });
        void this.#onError(event.reason, event.message);
        break;
      }
    }
  };

  /**
   * The person played or paused this device from the system's controls, which act on the native
   * player itself: the lock screen, Control Center, headphones, or CarPlay. iOS pausing it for
   * them, as when headphones are unplugged, counts too. It is a listener action, as a tap here is
   * (ADR 0018): the Connect requests seen so far are moot, and the player means to play or pause
   * from now on, a song still loading included.
   */
  #systemAction(playing: boolean): void {
    this.#listenerActed();
    this.#skipped.clear();
    this.#choose(playing);
    this.#update({ autoplayBlocked: false, error: null });

    if (!playing) this.#saveResume();
    // Connect reads whether a song still loading means to play (`playingHere`).
    this.#notify();
  }

  /** The engine moved to the preloaded song without a gap: it plays now, so the core follows. */
  #onAdvanced(): void {
    const preloaded = this.#preloaded;

    if (preloaded === null) return;

    this.#loaded = {
      entry: preloaded.entry,
      profile: preloaded.profile,
      url: preloaded.source.url,
      renewAt: preloaded.renewAt,
      playbackId: preloaded.playbackId,
      origin: preloaded.origin,
      reported: false,
    };

    this.#preloaded = null;
    this.#setPosition(0);
    const pending = this.#sendMove(preloaded.entry.itemId);
    this.#update({ current: preloaded.entry.itemId });
    this.#showNowPlaying();
    this.#reportPlay();
    void this.#confirmJump(pending);
  }

  async #confirmJump(pending: PendingJump): Promise<void> {
    try {
      await this.#commands.jump(pending.itemId);
    } catch (error) {
      if (this.#latestMove !== pending) return;
      this.#pendingJump = null;
      this.#update({ error: messageOf(error) });
    }
  }

  #onEnded(): void {
    const loaded = this.#loaded;

    if (loaded !== null && this.#queue?.repeat === "one") {
      // A new start, so history records the song again, as old music counted a repeat.
      void this.#load(loaded.entry, 0);

      return;
    }

    const following = this.#followingEntry();

    if (following === null) {
      this.#wantPlaying = false;
      this.#update({ engineStatus: "paused" });
      this.#engine.seek(0);
      this.#setPosition(0);
      this.#resumeAt = null;
      this.#env.resume.save(null);
      this.#showNowPlaying();

      return;
    }

    void this.#jumpTo(following.itemId, true);
  }

  async #onError(reason: EngineErrorReason, message: string): Promise<void> {
    if (reason === "autoplay-blocked") {
      this.#wantPlaying = false;
      this.#update({
        engineStatus: "paused",
        autoplayBlocked: true,
        error: AUTOPLAY_BLOCKED_MESSAGE,
      });

      return;
    }

    const loaded = this.#loaded;
    const url = loaded?.url ?? null;

    if (loaded?.origin === "local" && url !== null) {
      // A copy on this device that fails to play is damaged: it stops being offered, and the song
      // loads again from the server, or is skipped while the server can't be reached, as old
      // music's player recovered.
      this.#sources.discard(loaded.entry.track.id, url);

      if (this.#reach() === "device") {
        this.#skipDamagedCopy(loaded);

        return;
      }

      void this.#load(loaded.entry, this.#livePositionMs());

      return;
    }

    const baseUrl = url === null ? null : mediaBaseUrl(url);

    if (loaded === null || baseUrl === null) {
      this.#update({ engineStatus: "error", error: message });

      return;
    }

    const generation = this.#generation;

    const refused =
      reason === "expired" ||
      this.#isExpired(loaded.renewAt) ||
      (url !== null &&
        loaded.profile === "original" &&
        reason !== "network" &&
        (await Effect.runPromise(isStreamRefused(url))));

    if (generation !== this.#generation) return;

    if (refused) {
      if (this.#renewed === loaded.entry.itemId) {
        this.#update({ engineStatus: "error", error: STREAM_REFUSED_MESSAGE });

        return;
      }

      this.#renewed = loaded.entry.itemId;
      void this.#load(loaded.entry, this.#livePositionMs());

      return;
    }

    const health = await Effect.runPromiseExit(probeMediaHealth(baseUrl));

    if (generation !== this.#generation) return;

    if (Exit.isFailure(health)) {
      this.#goOffline(baseUrl);

      return;
    }

    if (this.#snapshot.engine === "mse" && reason !== "network") {
      this.#mseFailed = true;
      void this.#load(loaded.entry, this.#livePositionMs());

      return;
    }

    if (loaded.profile === "original" && !this.#transcode.has(loaded.entry.track.id)) {
      this.#transcode.add(loaded.entry.track.id);
      void this.#load(loaded.entry, this.#livePositionMs());

      return;
    }

    this.#update({ engineStatus: "error", error: message });
  }

  /**
   * Stops playback while the media server is away, and loads the current entry once it answers:
   * the song that stopped, from where it stopped, unless the listener moved on meanwhile.
   */
  #goOffline(baseUrl: string): void {
    const loaded = this.#loaded;
    const positionMs = this.#livePositionMs();

    this.#saveResume();
    this.#unload();

    if (loaded !== null) {
      this.#resumeAt = { itemId: loaded.entry.itemId, positionMs };
      this.#stamp(positionMs, false);
    }

    this.#update({ mediaOnline: false, engineStatus: "error", error: MEDIA_OFFLINE_MESSAGE });
    this.#stopHealthProbe();

    this.#healthFiber = Effect.runFork(
      waitForMedia(baseUrl).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#healthFiber = null;

            // A copy on this device that plays meanwhile goes on.
            if (this.#loaded?.origin === "local") {
              this.#update({ mediaOnline: true });

              return;
            }

            this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
            void this.#loadCurrent();
          }),
        ),
      ),
    );
  }

  /** Where sources may come from now: only this device while the media server is away. */
  #reach(): SourceReach {
    return this.#snapshot.mediaOnline ? "any" : "device";
  }

  #stopHealthProbe(): void {
    if (this.#healthFiber === null) return;
    Effect.runFork(Fiber.interrupt(this.#healthFiber));
    this.#healthFiber = null;
  }

  #showNowPlaying(): void {
    const track = this.#loaded?.entry.track ?? null;

    this.#env.nowPlaying.show(track, this.#isAudible(), this.#livePositionMs());
  }
}
