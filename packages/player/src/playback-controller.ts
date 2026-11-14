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
import type {
  PlayableTrack,
  ResolvedSource,
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
  /** Every entry, in play order. */
  readonly entries: ReadonlyArray<QueueEntry<T>>;
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
}

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
  /** Whether its start is recorded in history. */
  readonly reported: boolean;
}

interface PreloadedEntry extends ResolvedSource {
  readonly entry: QueueEntry;
}

/** A move to another entry sent from here, which the core has not confirmed yet. */
interface PendingJump {
  readonly itemId: string;
  readonly sentAt: number;
}

/**
 * Plays the listener's queue on this device. The core holds the queue and the entry playing
 * (`music.queue.*`); this device holds whether it plays and where in the song, as old music's
 * player did for the device that played (D62). Moving playback between devices returns with
 * Connect.
 */
export class PlaybackController {
  readonly #commands: MusicCommands;
  readonly #sources: SourceResolver;
  readonly #engines: EngineFactory;
  #engine: PlayerEngine;
  readonly #env: ControllerEnvironment;
  readonly #listeners = new Set<() => void>();
  #snapshot: ControllerSnapshot;

  #queue: QueueState | null = null;
  #pendingJump: PendingJump | null = null;
  #wantPlaying = false;
  #gapless: boolean;
  #resumeAt: ResumePoint | null;
  #loaded: LoadedEntry | null = null;
  #preloaded: PreloadedEntry | null = null;
  #preloading = false;
  #generation = 0;
  #sample: PositionSnapshot = { positionMs: 0, updatedAt: 0, playing: false };
  readonly #transcode = new Set<string>();
  #mseFailed = false;
  #renewed: string | null = null;
  #loading = false;
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
    };
  }

  /** The current local state. Stable between changes, for `useSyncExternalStore`. */
  getSnapshot = (): ControllerSnapshot => this.#snapshot;

  /** Calls `listener` after every local state change. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

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
      this.#engine.preload(null);
      this.#preloaded = null;
    }
  }

  /**
   * The live position in milliseconds, fresh on every call, so an animation frame can read it: the
   * engine's last report advanced by the time since while it plays, held while paused or buffering.
   */
  positionMs(): number {
    return this.#livePositionMs();
  }

  /** Replaces the queue with `trackIds` and plays the one at `index` here. */
  async playTracks(trackIds: ReadonlyArray<string>, index?: number): Promise<void> {
    this.#unlockOutput();
    this.#wantPlaying = true;
    this.#update({ error: null });

    try {
      const { current } = await this.#commands.play(trackIds, index);

      this.#moveTo(current, true);
    } catch (error) {
      this.#update({ error: messageOf(error) });
    }
  }

  /** Plays or pauses. The engine reacts at once, inside the tap, which satisfies autoplay rules. */
  async togglePlay(): Promise<void> {
    const entry = this.#currentEntry();

    if (entry === null) return;

    if (this.#loaded === null || this.#loaded.entry.itemId !== entry.itemId) {
      this.#unlockOutput();
      this.#wantPlaying = true;
      this.#update({ autoplayBlocked: false, error: null });
      await this.#load(entry, this.#resumePositionFor(entry), true);

      return;
    }

    const playing = this.#isAudible();
    this.#wantPlaying = !playing;
    this.#update({ autoplayBlocked: false, error: null });

    if (playing) {
      this.#engine.pause();
      this.#saveResume();
    } else if (!this.#reloadIfExpired(this.#livePositionMs(), true)) {
      await this.#engine.play();
    }
  }

  /** Plays the next entry, wrapping when repeat is all; at the end of the queue it does nothing. */
  async next(): Promise<void> {
    const queue = this.#queue;
    const at = this.#currentIndex();

    if (queue === null || at === null) return;

    const index = nextIndex(at, queue.entries.length, queue.repeat);
    const entry = index === null ? undefined : queue.entries[index];

    if (entry !== undefined) await this.#jumpTo(entry.itemId, this.#keepsPlaying());
  }

  /** Starts the song again once it played a little, else plays the entry before. */
  async previous(): Promise<void> {
    const queue = this.#queue;
    const at = this.#currentIndex();

    if (queue === null || at === null) return;

    const index = previousIndex(this.#livePositionMs(), at, queue.entries.length, queue.repeat);
    const entry = queue.entries[index];

    if (index === at || entry === undefined) {
      this.seek(0);

      return;
    }

    await this.#jumpTo(entry.itemId, this.#keepsPlaying());
  }

  /** Plays the queue entry `itemId`. */
  async jump(itemId: string): Promise<void> {
    this.#unlockOutput();
    await this.#jumpTo(itemId, true);
  }

  /** Seeks the engine at once. */
  seek(positionMs: number): void {
    const target = Math.max(0, Math.round(positionMs));
    const loaded = this.#loaded;

    if (loaded === null) {
      const entry = this.#currentEntry();

      if (entry !== null) this.#resumeAt = { itemId: entry.itemId, positionMs: target };
      this.#stamp(target, false);

      return;
    }

    if (this.#loading) {
      this.#unload();
      void this.#load(loaded.entry, target, this.#wantPlaying);
    } else if (!this.#reloadIfExpired(target, this.#isAudible())) this.#engine.seek(target);
    this.#setPosition(target);
    this.#showNowPlaying();
    this.#saveResume();
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
    this.#stopHealthProbe();
    this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
    const entry = this.#currentEntry();

    if (entry !== null) void this.#load(entry, this.#livePositionMs(), this.#wantPlaying);
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
    this.#engine.preload(null);
    this.#preloaded = null;
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

    if (this.#wantPlaying) {
      void this.#load(entry, 0, true);

      return;
    }

    if (this.#loaded !== null) {
      this.#unload();
      this.#update({ engineStatus: "idle", error: null, autoplayBlocked: false });
    }

    // Shows where this device left the song, paused, until it plays.
    if (this.#resumeAt?.itemId === entry.itemId) this.#stamp(this.#resumeAt.positionMs, false);
  }

  /** Loads the entry this player moved to once the queue that holds it arrives. */
  #loadPending(): void {
    const entry = this.#currentEntry();

    if (entry === null) return;

    if (this.#loaded?.entry.itemId === entry.itemId) {
      this.#refreshLoaded();

      return;
    }

    if (this.#loaded === null && this.#wantPlaying) void this.#load(entry, 0, true);
  }

  /** Keeps the loaded entry's song details current, such as a like, without reloading it. */
  #refreshLoaded(): void {
    const loaded = this.#loaded;
    const entry = loaded === null ? null : this.#entryOf(loaded.entry.itemId);

    if (loaded !== null && entry !== null) this.#loaded = { ...loaded, entry };
  }

  /** Moves to `itemId` here at once and tells the core, which confirms it with the next sync. */
  async #jumpTo(itemId: string, play: boolean): Promise<void> {
    this.#moveTo(itemId, play);

    try {
      await this.#commands.jump(itemId);
    } catch (error) {
      this.#pendingJump = null;
      this.#update({ error: messageOf(error) });

      if (this.#queue !== null) this.sync(this.#queue);
    }
  }

  #moveTo(itemId: string, play: boolean): void {
    this.#pendingJump = { itemId, sentAt: this.#env.now() };
    this.#wantPlaying = play;
    this.#resumeAt = null;
    this.#update({ current: itemId, error: null });
    const entry = this.#entryOf(itemId);

    if (entry === null) {
      // The queue that holds it has not arrived yet; `sync` loads it once it does.
      this.#unload();

      return;
    }

    if (this.#loaded?.entry.itemId === itemId && !play) return;
    void this.#load(entry, 0, play);
  }

  #keepsPlaying(): boolean {
    return this.#wantPlaying || this.#isAudible();
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
      next.current === current.current;

    if (unchanged) return;
    this.#snapshot = next;

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
    this.#preloading = false;
    this.#stamp(0, false);
  }

  #isExpired(renewAt: number | null): boolean {
    return renewAt !== null && this.#env.now() >= renewAt;
  }

  #reloadIfExpired(positionMs: number, autoplay: boolean): boolean {
    const loaded = this.#loaded;

    if (loaded === null || !this.#isExpired(loaded.renewAt)) return false;
    void this.#load(loaded.entry, positionMs, autoplay);

    return true;
  }

  async #load(entry: QueueEntry, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    this.#loading = true;
    const generation = this.#generation;
    const { track } = entry;

    try {
      const plannedAt = this.#env.now();

      const preloaded =
        this.#preloaded?.entry.itemId === entry.itemId && !this.#isExpired(this.#preloaded.renewAt)
          ? this.#preloaded
          : null;

      this.#loaded = {
        entry,
        profile: null,
        url: null,
        renewAt: null,
        playbackId: null,
        reported: false,
      };
      this.#preloaded = null;
      this.#stamp(startMs, false);

      if (!this.#snapshot.mediaOnline) return;
      const engine = this.#wantedEngine();
      this.#update({ engineStatus: "loading", error: null, autoplayBlocked: false });
      this.#useEngine(engine);

      const resolved =
        preloaded !== null && engine === this.#snapshot.engine
          ? preloaded
          : await this.#resolve(track, this.#profileFor(track, engine));

      if (generation !== this.#generation || resolved === null) return;

      this.#loaded = {
        entry,
        profile: resolved.profile,
        url: resolved.source.url,
        renewAt: resolved.renewAt,
        playbackId: resolved.playbackId,
        reported: false,
      };

      const elapsed = autoplay ? this.#env.now() - plannedAt : 0;
      const start = Math.min(startMs + elapsed, Math.max(0, track.durationMs - 1000));
      this.#setPosition(start);
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

  #profileFor(track: Track, engine: EngineKind): MusicStreamProfile {
    const support = this.#engines.mse;

    if (engine === "mse" && support !== null) {
      return chooseGaplessProfile(this.#snapshot.quality, track.lossless, support);
    }

    return this.#transcode.has(track.id)
      ? "aac-320"
      : chooseStreamProfile(this.#snapshot.quality, track.codec, this.#env.canPlay);
  }

  async #resolve(track: Track, profile: MusicStreamProfile): Promise<ResolvedSource | null> {
    const resolved: Result.Result<ResolvedSource, StreamRefused> = await this.#sources.resolve(
      track,
      profile,
    );

    if (Result.isSuccess(resolved)) return resolved.success;
    this.#update({ engineStatus: "error", error: resolved.failure.message });

    return null;
  }

  /** Records the loaded entry's start in history once it plays, once per start. */
  #reportPlay(): void {
    const loaded = this.#loaded;

    if (loaded === null || loaded.reported || loaded.playbackId === null) return;

    this.#loaded = { ...loaded, reported: true };
    void this.capture(this.#commands.report(loaded.entry.track.id, loaded.playbackId));
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

  async #preloadFollowing(): Promise<void> {
    const loaded = this.#loaded;

    if (loaded === null || this.#preloaded !== null || this.#preloading || this.#loading) return;

    if (loaded.entry.track.durationMs - this.#livePositionMs() > PRELOAD_LEAD_MS) return;

    if (this.#wantedEngine() !== this.#snapshot.engine || !this.#snapshot.mediaOnline) return;

    const entry = this.#followingEntry();

    if (entry === null) return;

    const generation = this.#generation;
    this.#preloading = true;

    const resolved = await this.#sources.resolve(
      entry.track,
      this.#profileFor(entry.track, this.#snapshot.engine),
    );

    this.#preloading = false;

    if (generation !== this.#generation || Result.isFailure(resolved)) return;
    this.#engine.preload(resolved.success.source);
    this.#preloaded = { entry, ...resolved.success };
  }

  #dropStalePreload(): void {
    const preloaded = this.#preloaded;

    if (preloaded === null) return;
    const following = this.#followingEntry();

    if (following?.itemId === preloaded.entry.itemId) {
      this.#preloaded = { ...preloaded, entry: following };

      return;
    }

    this.#engine.preload(null);
    this.#preloaded = null;
  }

  #onEngineEvent = (event: EngineEvent): void => {
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

        if (playing) this.#renewed = null;
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
      reported: false,
    };

    this.#preloaded = null;
    this.#setPosition(0);
    this.#pendingJump = { itemId: preloaded.entry.itemId, sentAt: this.#env.now() };
    this.#update({ current: preloaded.entry.itemId });
    this.#showNowPlaying();
    this.#reportPlay();
    void this.#confirmJump(preloaded.entry.itemId);
  }

  async #confirmJump(itemId: string): Promise<void> {
    try {
      await this.#commands.jump(itemId);
    } catch (error) {
      this.#pendingJump = null;
      this.#update({ error: messageOf(error) });
    }
  }

  #onEnded(): void {
    const loaded = this.#loaded;

    if (loaded !== null && this.#queue?.repeat === "one") {
      // A new start, so history records the song again, as old music counted a repeat.
      void this.#load(loaded.entry, 0, true);

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
      void this.#load(loaded.entry, this.#livePositionMs(), this.#wantPlaying);

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
      void this.#load(loaded.entry, this.#livePositionMs(), this.#wantPlaying);

      return;
    }

    if (loaded.profile === "original" && !this.#transcode.has(loaded.entry.track.id)) {
      this.#transcode.add(loaded.entry.track.id);
      void this.#load(loaded.entry, this.#livePositionMs(), this.#wantPlaying);

      return;
    }

    this.#update({ engineStatus: "error", error: message });
  }

  #goOffline(baseUrl: string): void {
    const loaded = this.#loaded;
    const positionMs = this.#livePositionMs();

    this.#unload();
    this.#update({ mediaOnline: false, engineStatus: "error", error: MEDIA_OFFLINE_MESSAGE });
    this.#stopHealthProbe();

    this.#healthFiber = Effect.runFork(
      waitForMedia(baseUrl).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#healthFiber = null;
            this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
            const entry = loaded === null ? null : this.#entryOf(loaded.entry.itemId);

            if (entry !== null) void this.#load(entry, positionMs, this.#wantPlaying);
          }),
        ),
      ),
    );
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
