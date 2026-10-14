/**
 * The imperative shell of the player: owns the audio engine, this browser's device identity, and
 * the conversation with the Convex playback session. `PlayerProvider` creates one per mount and
 * forwards session snapshots to `sync`; everything that decides what the engine does lives in the
 * pure `planEngine`.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type { PlaybackState, StreamProfile, Track } from "@music/commands/models";
import type { MusicClient } from "@music/sdk/client";
import { errorMessage } from "@music/sdk/errors";
import { Effect, Exit, Fiber } from "effect";

import type { DeviceDescription } from "./device-identity";
import type {
  EngineErrorReason,
  EngineEvent,
  EngineKind,
  EngineSource,
  PlayerEngine,
} from "./engine";
import { EngineCommand, followingIndex, planEngine, sessionView } from "./engine-plan";
import type { SessionView } from "./engine-plan";
import { livePosition } from "./live-position";
import { mediaBaseUrl, probeMediaHealth, waitForMedia } from "./media-health";
import { setMediaSessionHandlers, showNowPlaying } from "./media-session";
import { chooseEngine, chooseGaplessProfile, chooseStreamProfile } from "./stream-quality";
import type { MseSupport, StreamQuality } from "./stream-quality";

/** Heartbeat cadence; the server shows a device online for a while after each one. */
const HEARTBEAT_MS = 30_000;

/** How often the active device reports its position while playing. */
const REPORT_MS = 15_000;

/** Start buffering the next song this long before the current one ends. */
const PRELOAD_LEAD_MS = 20_000;

/** Shown when the browser refused to start audio without a tap (usually after a handoff). */
const AUTOPLAY_BLOCKED_MESSAGE = "Tap play to start here";

const MEDIA_OFFLINE_MESSAGE = "Can't reach the media server. Retrying…";

/** What the engine is doing, as the UI sees it. */
type EngineStatus = "idle" | "loading" | "playing" | "paused" | "buffering" | "error";

/** Local player state that the session does not hold. Replaced, never mutated. */
export interface ControllerSnapshot {
  readonly engineStatus: EngineStatus;
  readonly error: string | null;
  readonly mediaOnline: boolean;
  readonly quality: StreamQuality;
  readonly autoplayBlocked: boolean;
  /** A play or pause sent to the server and not yet confirmed by a new session snapshot. */
  readonly pendingPlaying: boolean | null;
  /** A volume sent to the server and not yet confirmed by a new session snapshot. */
  readonly pendingVolume: number | null;
  /** The engine that plays (or will play) the audio here. */
  readonly engine: EngineKind;
}

/** Builds the audio engines; the controller switches between them as quality and support allow. */
export interface EngineFactory {
  /** What the gapless MSE engine can play here, or null when it cannot run (HTML audio only). */
  readonly mse: MseSupport | null;
  readonly create: (kind: EngineKind) => PlayerEngine;
}

/** What the controller needs from its host besides the server and the engine. */
export interface ControllerEnvironment {
  readonly deviceId: DeviceId;
  readonly device: DeviceDescription;
  /** Answers `audio.canPlayType(mimeType) !== ""`. */
  readonly canPlay: (mimeType: string) => boolean;
  /** Milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** The saved quality setting. */
  readonly quality: StreamQuality;
  /** Persists a changed quality setting. */
  readonly saveQuality: (quality: StreamQuality) => void;
}

/** The queue entry the engine holds. */
interface LoadedEntry {
  readonly track: Track;
  readonly index: number;
  /** The profile requested for this entry; null until its stream URL arrives. */
  readonly profile: StreamProfile | null;
  readonly url: string | null;
}

interface PreloadedEntry {
  readonly track: Track;
  readonly index: number;
  readonly source: EngineSource;
  readonly profile: StreamProfile;
}

interface ResolvedSource {
  readonly source: EngineSource;
  readonly profile: StreamProfile;
}

/**
 * Plays the user's playback session on this browser when it is the active device, mirrors it
 * when it is not, and hands playback between devices.
 */
export class PlaybackController {
  readonly deviceId: DeviceId;
  readonly #client: MusicClient;
  readonly #engines: EngineFactory;
  #engine: PlayerEngine;
  readonly #env: ControllerEnvironment;
  readonly #listeners = new Set<() => void>();
  #snapshot: ControllerSnapshot;

  /** The latest session snapshot from the server. */
  #state: PlaybackState | null = null;
  /** The session view the engine was last brought in line with; null forces a resync. */
  #view: SessionView | null = null;
  #loaded: LoadedEntry | null = null;
  #preloaded: PreloadedEntry | null = null;
  #preloading = false;
  /** Bumped by every load and unload so stale async work drops its result. */
  #generation = 0;
  #positionMs = 0;
  #reportedMs: number | null = null;
  /** Tracks whose original stream failed to play; they fall back to AAC 320. */
  readonly #transcode = new Set<TrackId>();
  /** The MSE engine failed to play a song; HTML audio plays for the rest of the session. */
  #mseFailed = false;
  /** The volume last given to the engine, reapplied when the engine is replaced. */
  #volume = 1;
  /** A session snapshot paused the engine; that pause is already on the server. */
  #sessionPaused = false;
  #unsubscribeEngine: (() => void) | null = null;
  /** The first heartbeat, and whether it registered this device. */
  #registered: Promise<boolean> = Promise.resolve(false);
  #healthFiber: Fiber.Fiber<void, unknown> | null = null;
  #stop: (() => void) | null = null;

  constructor(client: MusicClient, engines: EngineFactory, env: ControllerEnvironment) {
    this.deviceId = env.deviceId;
    this.#client = client;
    this.#engines = engines;
    this.#env = env;
    const engine = chooseEngine(env.quality, engines.mse, false);
    this.#engine = engines.create(engine);

    this.#snapshot = {
      engineStatus: "idle",
      error: null,
      mediaOnline: true,
      quality: env.quality,
      autoplayBlocked: false,
      pendingPlaying: null,
      pendingVolume: null,
      engine,
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
   * Starts heartbeats, periodic reports, engine events, and media keys. Returns the function that
   * stops all of it and releases the audio.
   */
  start(): () => void {
    this.#stop?.();
    this.#unsubscribeEngine = this.#engine.subscribe(this.#onEngineEvent);
    this.#registered = this.#heartbeat();

    const heartbeats = setInterval(() => {
      void this.#heartbeat();
    }, HEARTBEAT_MS);

    const reports = setInterval(() => {
      if (this.#snapshot.engineStatus === "playing") void this.#report(true);
    }, REPORT_MS);

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") void this.#heartbeat();
    };

    document.addEventListener("visibilitychange", onVisibility);

    setMediaSessionHandlers({
      play: () => {
        if (!this.#isAudible()) void this.togglePlay();
      },
      pause: () => {
        if (this.#isAudible()) void this.togglePlay();
      },
      next: () => {
        void this.capture(this.#client.run("playback.next", {}));
      },
      previous: () => {
        void this.capture(this.#client.run("playback.previous", {}));
      },
      seekTo: (positionMs) => {
        void this.seek(positionMs);
      },
    });

    const stop = (): void => {
      this.#unsubscribeEngine?.();
      this.#unsubscribeEngine = null;
      clearInterval(heartbeats);
      clearInterval(reports);
      document.removeEventListener("visibilitychange", onVisibility);
      setMediaSessionHandlers(null);
      showNowPlaying(null, false, 0);
      this.#stopHealthProbe();
      this.#unload();
      this.#view = null;
      this.#stop = null;
    };

    this.#stop = stop;

    return stop;
  }

  /** Brings the engine in line with a new session snapshot. */
  sync(state: PlaybackState): void {
    this.#state = state;
    const view = sessionView(state, this.deviceId);

    const commands = planEngine(
      this.#view,
      view,
      {
        trackId: this.#loaded?.track.id ?? null,
        positionMs: this.#positionMs,
        reportedMs: this.#reportedMs,
      },
      this.#env.now(),
    );

    this.#view = view;

    for (const command of commands) this.#runCommand(command);

    this.#dropStalePreload();
    this.#showNowPlaying();
    this.#update({ pendingPlaying: null, pendingVolume: null });
  }

  /**
   * The live position in milliseconds: the engine's when this browser plays, else the session's
   * last report advanced by the time since.
   */
  positionMs(): number {
    if (this.#view?.active === true && this.#loaded !== null) return this.#positionMs;

    const state = this.#state;

    if (state === null) return 0;

    return livePosition(state, this.#env.now(), state.queue[state.index]?.durationMs ?? 0);
  }

  /** Replaces the queue and plays it on this browser. */
  async playTracks(trackIds: ReadonlyArray<TrackId>, index?: number): Promise<void> {
    this.#unlockOutput();
    await this.#ensureRegistered();

    await this.capture(
      this.#client.run(
        "playback.play",
        index === undefined
          ? { trackIds, deviceId: this.deviceId }
          : { trackIds, index, deviceId: this.deviceId },
      ),
    );
  }

  /**
   * Plays or pauses. On the active device the engine reacts at once (inside the tap, which also
   * satisfies autoplay rules) and the server confirms afterwards.
   */
  async togglePlay(): Promise<void> {
    const state = this.#state;
    const view = this.#view;

    if (state === null || view === null) return;

    if (state.activeDevice === null) {
      await this.playHere();

      if (!state.playing) await this.capture(this.#client.run("playback.resume", {}));

      return;
    }

    const playing = view.active
      ? this.#isAudible()
      : (this.#snapshot.pendingPlaying ?? view.playing);

    if (view.active && this.#loaded !== null) {
      if (playing) this.#engine.pause();
      else void this.#engine.play();
    }

    this.#update({ pendingPlaying: !playing, autoplayBlocked: false, error: null });
    await this.capture(this.#client.run(playing ? "playback.pause" : "playback.resume", {}));
  }

  /** Seeks the engine at once (when playing here) and the session. */
  async seek(positionMs: number): Promise<void> {
    const target = Math.max(0, Math.round(positionMs));

    if (this.#view?.active === true && this.#loaded !== null) {
      this.#engine.seek(target);
      this.#positionMs = target;
      this.#showNowPlaying();
    }

    await this.capture(this.#client.run("playback.seek", { positionMs: target }));
  }

  /** Sets the volume here at once (when playing here) and in the session. */
  async setVolume(volume: number): Promise<void> {
    const value = Math.min(1, Math.max(0, volume));

    if (this.#view?.active === true) this.#setEngineVolume(value);
    this.#update({ pendingVolume: value });
    await this.capture(this.#client.run("playback.volume", { volume: value }));
  }

  /** Moves playback to this browser. */
  async playHere(): Promise<void> {
    this.#unlockOutput();
    await this.#ensureRegistered();
    await this.capture(this.#client.run("playback.transfer", { deviceId: this.deviceId }));
  }

  /** Moves playback to another of the user's devices. */
  async transferTo(deviceId: DeviceId): Promise<void> {
    await this.capture(this.#client.run("playback.transfer", { deviceId }));
  }

  /** Saves the quality setting. It applies from the next song so the current one never skips. */
  setQuality(quality: StreamQuality): void {
    if (quality === this.#snapshot.quality) return;
    this.#env.saveQuality(quality);
    this.#update({ quality });
    this.#engine.preload(null);
    this.#preloaded = null;
  }

  /**
   * Runs synchronously at the start of the tap handlers that move playback to this browser, before
   * any await: it switches to the engine that will play and primes its audio element, so the
   * `play()` that follows the session update is allowed on iOS Safari. Output that already plays
   * here needs nothing.
   */
  #unlockOutput(): void {
    if (this.#view?.active === true) return;
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
      next.pendingPlaying === current.pendingPlaying &&
      next.pendingVolume === current.pendingVolume &&
      next.engine === current.engine;

    if (unchanged) return;
    this.#snapshot = next;

    for (const listener of this.#listeners) listener();
  }

  /**
   * Awaits a server call. A failure becomes the player `error` instead of a rejection, so UI
   * handlers can fire and forget.
   */
  async capture(call: Promise<unknown>): Promise<void> {
    try {
      await call;
    } catch (error) {
      this.#update({ error: error instanceof Error ? errorMessage(error) : String(error) });
    }
  }

  /**
   * Awaits a background call whose failure the user cannot act on. Heartbeats and reports repeat
   * on their own timers, so a failed one is simply superseded by the next.
   */
  async #quietly(call: Promise<unknown>): Promise<void> {
    try {
      await call;
    } catch {
      // Superseded by the next heartbeat or report.
    }
  }

  /** Sends a heartbeat. Resolves whether it landed; a failed one is superseded by the next. */
  async #heartbeat(): Promise<boolean> {
    const { name, kind } = this.#env.device;

    try {
      await this.#client.run("devices.heartbeat", { deviceId: this.deviceId, name, kind });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for the first heartbeat, and sends another when it failed: the server refuses to play
   * on a device it has never heard from.
   */
  async #ensureRegistered(): Promise<void> {
    if (await this.#registered) return;
    this.#registered = this.#heartbeat();
    await this.#registered;
  }

  async #report(playing: boolean): Promise<void> {
    const loaded = this.#loaded;

    if (this.#view?.active !== true || loaded === null) return;
    const positionMs = Math.max(0, Math.round(this.#positionMs));
    this.#reportedMs = positionMs;

    await this.#quietly(
      this.#client.run("playback.report", {
        deviceId: this.deviceId,
        index: loaded.index,
        trackId: loaded.track.id,
        positionMs,
        playing,
      }),
    );
  }

  #isAudible(): boolean {
    const status = this.#snapshot.engineStatus;

    if (this.#snapshot.autoplayBlocked) return false;

    if (status === "loading") return this.#view?.playing ?? false;

    return status === "playing" || status === "buffering";
  }

  #runCommand(command: EngineCommand): void {
    EngineCommand.$match(command, {
      Unload: () => {
        this.#unload();
        this.#update({ engineStatus: "idle", error: null, autoplayBlocked: false });
      },
      Load: ({ track, index, startMs, autoplay }) => {
        void this.#load(track, index, startMs, autoplay);
      },
      AdoptIndex: ({ index }) => {
        if (this.#loaded !== null) this.#loaded = { ...this.#loaded, index };
      },
      Play: () => {
        void this.#engine.play();
      },
      Pause: () => {
        // An engine that is already silent emits no `paused` to consume the mark.
        this.#sessionPaused = this.#isAudible();
        this.#engine.pause();
      },
      Seek: ({ positionMs }) => {
        this.#engine.seek(positionMs);
        this.#positionMs = positionMs;
      },
      SetVolume: ({ volume }) => {
        this.#setEngineVolume(volume);
      },
    });
  }

  #setEngineVolume(volume: number): void {
    this.#volume = volume;
    this.#engine.setVolume(volume);
  }

  /** The engine the current quality and browser support call for. */
  #wantedEngine(): EngineKind {
    return chooseEngine(this.#snapshot.quality, this.#engines.mse, this.#mseFailed);
  }

  /** Replaces the engine when `kind` differs from the one in use. */
  #useEngine(kind: EngineKind): void {
    if (kind === this.#snapshot.engine) return;
    this.#engine.unload();
    const listening = this.#unsubscribeEngine !== null;
    this.#unsubscribeEngine?.();
    this.#engine = this.#engines.create(kind);
    this.#unsubscribeEngine = listening ? this.#engine.subscribe(this.#onEngineEvent) : null;
    this.#engine.setVolume(this.#volume);
    this.#preloaded = null;
    this.#update({ engine: kind });
  }

  #unload(): void {
    this.#generation += 1;
    this.#engine.unload();
    this.#loaded = null;
    this.#preloaded = null;
    this.#preloading = false;
    this.#positionMs = 0;
    this.#reportedMs = null;
  }

  async #load(track: Track, index: number, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const plannedAt = this.#env.now();
    const preloaded = this.#preloaded?.track.id === track.id ? this.#preloaded : null;
    this.#loaded = { track, index, profile: null, url: null };
    this.#preloaded = null;
    this.#positionMs = startMs;
    this.#reportedMs = null;

    if (!this.#snapshot.mediaOnline) return;
    this.#update({ engineStatus: "loading", error: null, autoplayBlocked: false });
    const engine = this.#wantedEngine();
    // A preloaded URL was signed for the other engine's profile.
    const reusable = preloaded !== null && engine === this.#snapshot.engine ? preloaded : null;
    this.#useEngine(engine);
    const resolved = reusable ?? (await this.#resolveSource(track));

    if (generation !== this.#generation || resolved === null) return;
    this.#loaded = { track, index, profile: resolved.profile, url: resolved.source.url };

    // The stream URL took a moment to arrive; a playing session moved on meanwhile.
    const elapsed = autoplay ? this.#env.now() - plannedAt : 0;
    const start = Math.min(startMs + elapsed, Math.max(0, track.durationMs - 1000));
    this.#positionMs = start;
    await this.#engine.load(resolved.source, start, autoplay);
  }

  /** The stream profile the engine in use plays for `track`. */
  #profileFor(track: Track): StreamProfile {
    const support = this.#engines.mse;

    if (this.#snapshot.engine === "mse" && support !== null) {
      return chooseGaplessProfile(this.#snapshot.quality, track.lossless, support);
    }

    return this.#transcode.has(track.id)
      ? "aac-320"
      : chooseStreamProfile(this.#snapshot.quality, track.codec, this.#env.canPlay);
  }

  /** Picks the profile and asks the server for a signed stream URL. */
  async #resolveSource(track: Track): Promise<ResolvedSource | null> {
    const profile = this.#profileFor(track);

    try {
      const stream = await this.#client.read("stream.url", { trackId: track.id, profile });

      return {
        profile,
        source: { key: `${track.id}:${profile}`, url: stream.url, durationMs: track.durationMs },
      };
    } catch (error) {
      this.#update({
        engineStatus: "error",
        error: error instanceof Error ? errorMessage(error) : String(error),
      });

      return null;
    }
  }

  /** Buffers the following entry once the current one is close to its end. */
  async #preloadFollowing(): Promise<void> {
    const state = this.#state;
    const loaded = this.#loaded;

    if (state === null || loaded === null || this.#preloaded !== null || this.#preloading) return;

    if (this.#view?.active !== true || !this.#snapshot.mediaOnline) return;

    if (loaded.track.durationMs - this.#positionMs > PRELOAD_LEAD_MS) return;

    // A quality change switches engines at the next song, which then loads instead of preloading.
    if (this.#wantedEngine() !== this.#snapshot.engine) return;

    const index = followingIndex(loaded.index, state.queue.length, state.repeat);
    const track = index === null ? undefined : state.queue[index];

    if (index === null || track === undefined) return;
    const generation = this.#generation;
    this.#preloading = true;
    const resolved = await this.#resolveSource(track);
    this.#preloading = false;

    if (generation !== this.#generation || resolved === null) return;
    this.#engine.preload(resolved.source);
    this.#preloaded = { track, index, ...resolved };
  }

  /** Forgets a preloaded entry that no longer follows the current one (queue or repeat changed). */
  #dropStalePreload(): void {
    const state = this.#state;
    const loaded = this.#loaded;
    const preloaded = this.#preloaded;

    if (state === null || loaded === null || preloaded === null) return;
    const index = followingIndex(loaded.index, state.queue.length, state.repeat);

    if (index === preloaded.index && state.queue[index]?.id === preloaded.track.id) return;
    this.#engine.preload(null);
    this.#preloaded = null;
  }

  #onEngineEvent = (event: EngineEvent): void => {
    switch (event.type) {
      case "time": {
        this.#positionMs = event.positionMs;
        void this.#preloadFollowing();
        break;
      }

      case "playing": {
        this.#sessionPaused = false;
        this.#update({ engineStatus: "playing", error: null, autoplayBlocked: false });
        this.#showNowPlaying();
        void this.#report(true);
        break;
      }

      case "paused": {
        const ordered = this.#sessionPaused;
        this.#sessionPaused = false;
        this.#update({ engineStatus: "paused" });
        this.#showNowPlaying();

        // A pause the session ordered is already on the server. Reporting it back could land
        // after a Play pressed meanwhile and overwrite it, when the snapshot that ordered the
        // pause was stale.
        if (!ordered) void this.#report(false);
        break;
      }

      case "waiting": {
        this.#update({ engineStatus: "buffering" });
        break;
      }

      case "advanced": {
        this.#onAdvanced();
        break;
      }

      case "ended": {
        this.#onEnded();
        break;
      }

      case "error": {
        void this.#onError(event.reason, event.message);
        break;
      }
    }
  };

  #onAdvanced(): void {
    const preloaded = this.#preloaded;

    if (preloaded === null) return;

    this.#loaded = {
      track: preloaded.track,
      index: preloaded.index,
      profile: preloaded.profile,
      url: preloaded.source.url,
    };

    this.#preloaded = null;
    this.#positionMs = 0;
    this.#showNowPlaying();
    void this.#report(true);
  }

  #onEnded(): void {
    if (this.#state?.repeat === "one") {
      this.#engine.seek(0);
      void this.#engine.play();

      return;
    }

    // The engine stopped at the end of the song, and engines don't report that stop as a pause.
    // Mark it, or the periodic report would tell the server this device is still playing and
    // restart the last song after `playback.next` stopped at the end of the queue.
    this.#update({ engineStatus: "paused" });
    void this.capture(this.#client.run("playback.next", {}));
  }

  async #onError(reason: EngineErrorReason, message: string): Promise<void> {
    if (reason === "autoplay-blocked") {
      this.#update({
        engineStatus: "paused",
        autoplayBlocked: true,
        error: AUTOPLAY_BLOCKED_MESSAGE,
      });

      await this.#report(false);

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
    const health = await Effect.runPromiseExit(probeMediaHealth(baseUrl));

    if (generation !== this.#generation) return;

    if (Exit.isFailure(health)) {
      this.#goOffline(baseUrl);

      return;
    }

    // The service is up, so the gapless engine could not play this stream: use HTML audio.
    if (this.#snapshot.engine === "mse" && reason !== "network") {
      this.#mseFailed = true;
      void this.#load(loaded.track, loaded.index, this.#positionMs, this.#view?.playing ?? false);

      return;
    }

    // The service is up, so the browser could not play the original file: transcode instead.
    if (loaded.profile === "original" && !this.#transcode.has(loaded.track.id)) {
      this.#transcode.add(loaded.track.id);
      void this.#load(loaded.track, loaded.index, this.#positionMs, this.#view?.playing ?? false);

      return;
    }

    this.#update({ engineStatus: "error", error: message });
  }

  /** Marks the media service offline and resyncs once its health check answers again. */
  #goOffline(baseUrl: string): void {
    this.#unload();
    this.#update({ mediaOnline: false, engineStatus: "error", error: MEDIA_OFFLINE_MESSAGE });
    this.#stopHealthProbe();

    this.#healthFiber = Effect.runFork(
      waitForMedia(baseUrl).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.#healthFiber = null;
            this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
            this.#view = null;

            if (this.#state !== null) this.sync(this.#state);
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
    const active = this.#view?.active === true;
    const track = active ? (this.#loaded?.track ?? null) : null;

    showNowPlaying(track, this.#isAudible(), this.#positionMs);
  }
}
