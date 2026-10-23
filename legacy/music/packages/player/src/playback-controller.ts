/**
 * The imperative shell of the player: owns the audio engine, this browser's device identity, and
 * the conversation with the playback session through a `SessionPort`. `PlayerProvider` creates one
 * per mount and forwards session snapshots to `sync`; everything that decides what the engine
 * does lives in the pure `planEngine`, and where a song's bytes come from in the `SourceResolver`.
 */
import type { DeviceId, TrackId } from "@music/commands/ids";
import type { PlaybackState, QueueEntry, StreamProfile, Track } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { Effect, Exit, Fiber, Result } from "effect";

import type { DeviceDescription } from "./device-identity";
import type { EngineErrorReason, EngineEvent, EngineKind, PlayerEngine } from "./engine";
import {
  EngineCommand,
  FOLLOW_DRIFT_MS,
  followingIndex,
  planEngine,
  sessionView,
} from "./engine-plan";
import { clockOffset, withClockSample } from "./clock-offset";
import type { SessionView } from "./engine-plan";
import { livePosition } from "./live-position";
import { isStreamRefused, mediaBaseUrl, probeMediaHealth, waitForMedia } from "./media-health";
import type { MediaSessionHandlers } from "./media-session";
import type { SessionPort } from "./session-router";
import { SourcePlan } from "./source-resolver";
import type { ResolvedSource, SourceResolver, StreamRefused } from "./source-resolver";
import { chooseEngine, chooseGaplessProfile, chooseStreamProfile } from "./stream-quality";
import type { MseSupport, StreamQuality } from "./stream-quality";

/** Heartbeat cadence; the server shows a device online for a while after each one. */
const HEARTBEAT_MS = 30_000;

/** How often the active device reports its position while playing. */
const REPORT_MS = 15_000;

/** How often a device listening along to a Jam checks that it is still in step with the host. */
const FOLLOW_CHECK_MS = 2000;

/** After seeking back in step, how long to let playback settle before checking drift again. */
const FOLLOW_SETTLE_MS = 6000;

/** Start buffering the next song this long before the current one ends. */
const PRELOAD_LEAD_MS = 20_000;

/** Shown when the browser refused to start audio without a tap (usually after a handoff). */
const AUTOPLAY_BLOCKED_MESSAGE = "Tap play to start here";

const MEDIA_OFFLINE_MESSAGE = "Can't reach the media server. Retrying…";

/** Shown when the media server refuses a stream URL even right after it was signed. */
const STREAM_REFUSED_MESSAGE = "The media server refused this song's stream";

const UNREACHABLE_MESSAGE = "This song isn't downloaded";

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

/**
 * The system's now-playing surface: the lock screen, notifications, and hardware media keys. The
 * web routes it through the Media Session API (`media-session.ts`).
 */
export interface NowPlayingControls {
  /** Routes system media controls to `handlers`, or detaches them when `handlers` is null. */
  readonly setHandlers: (handlers: MediaSessionHandlers | null) => void;
  /** Shows `track` at `positionMs`, or clears the surface when nothing plays here. */
  readonly show: (track: Track | null, playing: boolean, positionMs: number) => void;
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
  readonly nowPlaying: NowPlayingControls;
  /** Calls `listener` each time the app returns to the foreground. Returns the unsubscribe function. */
  readonly onForeground: (listener: () => void) => () => void;
}

/** The queue entry the engine holds. */
interface LoadedEntry {
  readonly track: QueueEntry;
  readonly index: number;
  readonly origin: ResolvedSource["origin"] | null;
  /** The profile requested for this entry; null until its source resolves. */
  readonly profile: StreamProfile | null;
  readonly url: string | null;
  /** See `ResolvedSource.renewAt`; null without a URL. */
  readonly renewAt: number | null;
}

interface PreloadedEntry extends ResolvedSource {
  readonly track: QueueEntry;
  readonly index: number;
}

const isLocal = (plan: SourcePlan): boolean =>
  SourcePlan.$is("Ready")(plan) && plan.resolved.origin === "local";

/**
 * Plays the user's playback session on this browser when it is the active device, mirrors it
 * when it is not, and hands playback between devices.
 */
export class PlaybackController {
  readonly deviceId: DeviceId;
  readonly #session: SessionPort;
  readonly #sources: SourceResolver;
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
  /** Clock samples for listening along; see `clock-offset.ts`. */
  #clockSamples: ReadonlyArray<number> = [];
  #lastFollowSeekAt = 0;
  /** Tracks whose original stream failed to play; they fall back to AAC 320. */
  readonly #transcode = new Set<TrackId>();
  /** The MSE engine failed to play a song; HTML audio plays for the rest of the session. */
  #mseFailed = false;
  /**
   * The track whose refused stream URL was last signed again; cleared once audio plays. A fresh
   * URL that is refused too is an error, not another renewal.
   */
  #renewed: TrackId | null = null;
  /** The volume last given to the engine, reapplied when the engine is replaced. */
  #volume = 1;
  /** A session snapshot paused the engine; that pause is already on the server. */
  #sessionPaused = false;
  #unsubscribeEngine: (() => void) | null = null;
  /** The first heartbeat, and whether it registered this device. */
  #registered: Promise<boolean> = Promise.resolve(false);
  #healthFiber: Fiber.Fiber<void, unknown> | null = null;
  #stop: (() => void) | null = null;

  /**
   * @param session - Where commands go: the server, or this device's own session while offline.
   * @param sources - Where each song's bytes come from.
   */
  constructor(
    session: SessionPort,
    sources: SourceResolver,
    engines: EngineFactory,
    env: ControllerEnvironment,
  ) {
    this.deviceId = env.deviceId;
    this.#session = session;
    this.#sources = sources;
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

    const follow = setInterval(() => {
      this.#keepInStep();
    }, FOLLOW_CHECK_MS);

    const stopForeground = this.#env.onForeground(() => {
      void this.#heartbeat();
    });

    this.#env.nowPlaying.setHandlers({
      play: () => {
        if (!this.#isAudible()) void this.togglePlay();
      },
      pause: () => {
        if (this.#isAudible()) void this.togglePlay();
      },
      next: () => {
        void this.capture(this.#session.run("playback.next", {}));
      },
      previous: () => {
        void this.capture(this.#session.run("playback.previous", {}));
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
      clearInterval(follow);
      stopForeground();
      this.#env.nowPlaying.setHandlers(null);
      this.#env.nowPlaying.show(null, false, 0);
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
    // Each new host report while listening along is a sample of this clock against the server's.
    // The first snapshot is not: the host may have reported long before this device asked, and
    // that wait would read as a clock offset, putting this device behind until the next report.
    if (
      state.following &&
      this.#state?.following === true &&
      state.updatedAt !== this.#state.updatedAt
    ) {
      this.#clockSamples = withClockSample(this.#clockSamples, this.#env.now() - state.updatedAt);
    }

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
      this.#serverNow(state),
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
      this.#session.run(
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

      if (!state.playing) await this.capture(this.#session.run("playback.resume", {}));

      return;
    }

    const playing = view.active
      ? this.#isAudible()
      : (this.#snapshot.pendingPlaying ?? view.playing);

    if (view.active && this.#loaded !== null) {
      if (playing) this.#engine.pause();
      else if (!this.#reloadIfExpired(this.#positionMs, true)) void this.#engine.play();
    }

    this.#update({ pendingPlaying: !playing, autoplayBlocked: false, error: null });

    try {
      await this.#session.run(playing ? "playback.pause" : "playback.resume", {});
    } catch (error) {
      // Refused, as for someone in a Jam who may not steer it: no new snapshot will come, so put
      // this device back the way the session is, or a follower would stay silent.
      this.#restoreToSession();
      this.#update({ error: error instanceof Error ? errorMessage(error) : String(error) });
    }
  }

  /** Undoes an optimistic play or pause: the engine and the shown state follow the session. */
  #restoreToSession(): void {
    const view = this.#view;

    this.#update({ pendingPlaying: null });

    if (view?.active !== true || this.#loaded === null) return;

    if (view.playing && !this.#isAudible()) void this.#engine.play();
    else if (!view.playing && this.#isAudible()) this.#engine.pause();
  }

  /** Seeks the engine at once (when playing here) and the session. */
  async seek(positionMs: number): Promise<void> {
    const target = Math.max(0, Math.round(positionMs));

    if (this.#view?.active === true && this.#loaded !== null) {
      if (!this.#reloadIfExpired(target, this.#isAudible())) this.#engine.seek(target);
      this.#positionMs = target;
      this.#showNowPlaying();
    }

    await this.capture(this.#session.run("playback.seek", { positionMs: target }));
  }

  /** Sets the volume here at once (when playing here) and in the session. */
  async setVolume(volume: number): Promise<void> {
    const value = Math.min(1, Math.max(0, volume));

    if (this.#view?.active === true) this.#setEngineVolume(value);
    this.#update({ pendingVolume: value });
    await this.capture(this.#session.run("playback.volume", { volume: value }));
  }

  /**
   * Loads the current song again from the session's position after a failure, as the media
   * health check does once the service answers again. A song that still fails shows its error.
   */
  retry(): void {
    if (this.#snapshot.engineStatus !== "error") return;
    this.#stopHealthProbe();
    this.#update({ mediaOnline: true, engineStatus: "idle", error: null });
    this.#view = null;

    if (this.#state !== null) this.sync(this.#state);
  }

  /** Moves playback to this browser. */
  async playHere(): Promise<boolean> {
    this.#unlockOutput();
    await this.#ensureRegistered();

    return this.attempt(this.#session.run("playback.transfer", { deviceId: this.deviceId }));
  }

  /**
   * Moves playback to another of the user's devices. Resolves whether the move landed; a failure
   * becomes the player `error`.
   */
  async transferTo(deviceId: DeviceId): Promise<boolean> {
    return this.attempt(this.#session.run("playback.transfer", { deviceId }));
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
      this.#update({ error: error instanceof Error ? errorMessage(error) : String(error) });

      return false;
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

  /**
   * Sends a heartbeat. Resolves whether it landed; a failed one is superseded by the next. None
   * goes out while this device plays its own session: the server can't hear it, and heartbeats
   * would pile up until it can.
   */
  async #heartbeat(): Promise<boolean> {
    const { name, kind } = this.#env.device;

    if (this.#session.mode() === "local") return false;

    try {
      await this.#session.run("devices.heartbeat", { deviceId: this.deviceId, name, kind });

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
    if (this.#session.mode() === "local" || (await this.#registered)) return;
    this.#registered = this.#heartbeat();
    await this.#registered;
  }

  /**
   * Listening along to a Jam: seeks back in step when the engine drifted more than
   * `FOLLOW_DRIFT_MS` from the host's position, worked out from the host's last report.
   */
  #keepInStep(): void {
    const state = this.#state;
    const view = this.#view;
    const now = this.#env.now();

    if (state === null || view?.following !== true || !view.playing) return;

    if (this.#snapshot.engineStatus !== "playing" || this.#loaded?.track.id !== view.track?.id) {
      return;
    }

    // A seek takes a moment to land; checking again at once would chase its own tail.
    if (now - this.#lastFollowSeekAt < FOLLOW_SETTLE_MS) return;
    const durationMs = view.track?.durationMs ?? 0;
    const target = livePosition(state, this.#serverNow(state), durationMs);

    // At the very end the host has likely moved on already; the next snapshot brings the song.
    if (target >= durationMs - FOLLOW_DRIFT_MS) return;

    if (Math.abs(target - this.#positionMs) <= FOLLOW_DRIFT_MS) return;
    this.#engine.seek(target);
    this.#positionMs = target;
    this.#lastFollowSeekAt = now;
  }

  /**
   * The time to work out the session's live position with: this device's clock, put on the
   * server's while listening along (where positions are the host's, stamped by the server).
   */
  #serverNow(state: PlaybackState): number {
    return this.#env.now() - (state.following ? clockOffset(this.#clockSamples) : 0);
  }

  async #report(playing: boolean): Promise<void> {
    const loaded = this.#loaded;

    // Listening along, the host's device reports; this one only follows.
    if (this.#view?.active !== true || this.#view.following || loaded === null) return;
    const positionMs = Math.max(0, Math.round(this.#positionMs));
    this.#reportedMs = positionMs;

    await this.#quietly(
      this.#session.run("playback.report", {
        deviceId: this.deviceId,
        index: loaded.index,
        trackId: loaded.track.id,
        itemId: loaded.track.itemId,
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
      AdoptIndex: ({ index, track }) => {
        if (this.#loaded !== null) this.#loaded = { ...this.#loaded, index, track };
      },
      Play: () => {
        if (!this.#reloadIfExpired(this.#positionMs, true)) void this.#engine.play();
      },
      Pause: () => {
        // An engine that is already silent emits no `paused` to consume the mark.
        this.#sessionPaused = this.#isAudible();
        this.#engine.pause();
      },
      Seek: ({ positionMs }) => {
        if (!this.#reloadIfExpired(positionMs, this.#isAudible())) this.#engine.seek(positionMs);
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

  /** True when a stream URL to renew at `renewAt` should not be used any more. */
  #isExpired(renewAt: number | null): boolean {
    return renewAt !== null && this.#env.now() >= renewAt;
  }

  /**
   * Loads the current song again with a freshly signed URL, at `positionMs`, when its URL has
   * expired (after a long pause): playing or seeking on would send requests it no longer
   * covers. Returns whether it did; the caller then leaves the engine alone.
   */
  #reloadIfExpired(positionMs: number, autoplay: boolean): boolean {
    const loaded = this.#loaded;

    if (loaded === null || !this.#isExpired(loaded.renewAt)) return false;
    void this.#load(loaded.track, loaded.index, positionMs, autoplay);

    return true;
  }

  async #load(track: QueueEntry, index: number, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const plannedAt = this.#env.now();

    const preloaded =
      this.#preloaded?.track.id === track.id && !this.#isExpired(this.#preloaded.renewAt)
        ? this.#preloaded
        : null;

    this.#loaded = { track, index, origin: null, profile: null, url: null, renewAt: null };
    this.#preloaded = null;
    this.#positionMs = startMs;
    this.#reportedMs = null;
    const engine = this.#wantedEngine();

    // A preloaded URL was signed for the other engine's profile.
    const plan =
      preloaded !== null && engine === this.#snapshot.engine
        ? SourcePlan.Ready({ resolved: preloaded })
        : this.#sources.resolve(track, this.#profileFor(track, engine));

    if (SourcePlan.$is("Unreachable")(plan)) {
      this.#skipUnreachable();

      return;
    }

    if (!this.#snapshot.mediaOnline && !isLocal(plan)) return;
    this.#update({ engineStatus: "loading", error: null, autoplayBlocked: false });
    this.#useEngine(engine);
    const resolved = SourcePlan.$is("Ready")(plan) ? plan.resolved : await this.#sign(plan.sign);

    if (generation !== this.#generation || resolved === null) return;

    this.#loaded = {
      track,
      index,
      origin: resolved.origin,
      profile: resolved.profile,
      url: resolved.source.url,
      renewAt: resolved.renewAt,
    };

    // The stream URL took a moment to arrive; a playing session moved on meanwhile.
    const elapsed = autoplay ? this.#env.now() - plannedAt : 0;
    const start = Math.min(startMs + elapsed, Math.max(0, track.durationMs - 1000));
    this.#positionMs = start;
    await this.#engine.load(resolved.source, start, autoplay);
  }

  /** Lets go of the song before, so a play can't resume it, and moves on to one that can play. */
  #skipUnreachable(): void {
    this.#engine.unload();
    this.#update({ engineStatus: "error", error: UNREACHABLE_MESSAGE, autoplayBlocked: false });
    void this.capture(this.#session.run("playback.next", {}));
  }

  /** The stream profile `engine` plays for `track`. */
  #profileFor(track: Track, engine: EngineKind): StreamProfile {
    const support = this.#engines.mse;

    if (engine === "mse" && support !== null) {
      return chooseGaplessProfile(this.#snapshot.quality, track.lossless, support);
    }

    return this.#transcode.has(track.id)
      ? "aac-320"
      : chooseStreamProfile(this.#snapshot.quality, track.codec, this.#env.canPlay);
  }

  async #sign(
    sign: () => Promise<Result.Result<ResolvedSource, StreamRefused>>,
  ): Promise<ResolvedSource | null> {
    const signed = await sign();

    if (Result.isSuccess(signed)) return signed.success;
    this.#update({ engineStatus: "error", error: signed.failure.message });

    return null;
  }

  /** Buffers the following entry once the current one is close to its end. */
  async #preloadFollowing(): Promise<void> {
    const state = this.#state;
    const loaded = this.#loaded;

    if (state === null || loaded === null || this.#preloaded !== null || this.#preloading) return;

    if (this.#view?.active !== true) return;

    if (loaded.track.durationMs - this.#positionMs > PRELOAD_LEAD_MS) return;

    // A quality change switches engines at the next song, which then loads instead of preloading.
    if (this.#wantedEngine() !== this.#snapshot.engine) return;

    const index = followingIndex(loaded.index, state.queue.length, state.repeat);
    const track = index === null ? undefined : state.queue[index];

    if (index === null || track === undefined) return;
    const plan = this.#sources.resolve(track, this.#profileFor(track, this.#snapshot.engine));

    if (SourcePlan.$is("Unreachable")(plan)) return;

    if (!this.#snapshot.mediaOnline && !isLocal(plan)) return;
    const generation = this.#generation;
    this.#preloading = true;
    const resolved = SourcePlan.$is("Ready")(plan) ? plan.resolved : await this.#sign(plan.sign);
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
        this.#renewed = null;
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
      origin: preloaded.origin,
      profile: preloaded.profile,
      url: preloaded.source.url,
      renewAt: preloaded.renewAt,
    };

    this.#preloaded = null;
    this.#positionMs = 0;
    this.#showNowPlaying();
    void this.#report(true);
  }

  #onEnded(): void {
    // Listening along, the host's device moves the queue on; this one follows when it does.
    if (this.#view?.following === true) {
      this.#update({ engineStatus: "paused" });

      return;
    }

    if (this.#state?.repeat === "one") {
      this.#engine.seek(0);
      void this.#engine.play();

      return;
    }

    // The engine stopped at the end of the song, and engines don't report that stop as a pause.
    // Mark it, or the periodic report would tell the server this device is still playing and
    // restart the last song after `playback.next` stopped at the end of the queue.
    this.#update({ engineStatus: "paused" });
    void this.capture(this.#session.run("playback.next", {}));
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

    if (loaded?.origin === "local") {
      this.#sources.discard(loaded.track.id);
      void this.#load(loaded.track, loaded.index, this.#positionMs, this.#view?.playing ?? false);

      return;
    }

    const url = loaded?.url ?? null;
    const baseUrl = url === null ? null : mediaBaseUrl(url);

    if (loaded === null || baseUrl === null) {
      this.#update({ engineStatus: "error", error: message });

      return;
    }

    const generation = this.#generation;

    // A stream URL that expired (or that the media service refuses) is signed again; the format
    // is not to blame. The HTML engine cannot see a refusal of an original file, which it would
    // take for a format to transcode, so it is asked about here. Asking about a transcoded
    // profile could start a transcode, and the gapless engine reports refusals itself.
    const refused =
      reason === "expired" ||
      this.#isExpired(loaded.renewAt) ||
      (url !== null &&
        loaded.profile === "original" &&
        reason !== "network" &&
        (await Effect.runPromise(isStreamRefused(url))));

    if (generation !== this.#generation) return;

    if (refused) {
      if (this.#renewed === loaded.track.id) {
        this.#update({ engineStatus: "error", error: STREAM_REFUSED_MESSAGE });

        return;
      }

      this.#renewed = loaded.track.id;
      void this.#load(loaded.track, loaded.index, this.#positionMs, this.#view?.playing ?? false);

      return;
    }

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

    this.#env.nowPlaying.show(track, this.#isAudible(), this.#positionMs);
  }
}
