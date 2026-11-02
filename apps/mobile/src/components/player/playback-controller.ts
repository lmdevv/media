import type { PlayerObservation } from "@movies/contracts/diagnostics";
import type { ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";
import { Milliseconds } from "@movies/contracts/units";
import type { Movies } from "@movies/sdk/effect";
import { Playback, PlayerDiagnostics } from "@movies/sdk/effect";
import type { useMoviesRuntime } from "@movies/sdk/react";
import { Data, Effect, Exit, Option, Result, Scope, Struct } from "effect";
import { createVideoPlayer } from "expo-video";
import type { VideoMetadata, VideoPlayer } from "expo-video";

import { IOS_CAPABILITIES } from "@/lib/player/capabilities";
import {
  bufferedAheadSeconds,
  playerErrorObservation,
  recoveryObservation,
} from "@/lib/player/diagnostics";
import {
  MAX_RECOVERIES,
  PlaybackStep,
  PlaybackStop,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterPlayerError,
  withoutFailedPath,
  isUnhonoured,
} from "@/lib/player/policy";
import { lowerQuality, qualityCap } from "@/lib/player/quality";
import type { QualityChoice } from "@/lib/player/quality";
import { StallVerdict, checked, watching } from "@/lib/player/stall-watchdog";
import type { StallWatch } from "@/lib/player/stall-watchdog";
import { clampSubtitleDelay } from "@/lib/player/subtitle-delay";
import { NATIVE_SEEKER, VideoPort, withinBuffer } from "@/lib/player/video-port";
import type { StreamSeeker } from "@/lib/player/video-port";

type Runtime = ReturnType<typeof useMoviesRuntime>;

/** Where the player stands. */
export type PlayerPhase = Data.TaggedEnum<{
  /** Negotiating and loading a stream, until its first frame (F08). */
  Preparing: {};
  /** The stream showed its first frame; buffering and pausing are the port's business. */
  Playing: {};
  /** Playback cannot go on without the viewer (F09, F13). */
  Stopped: { readonly stop: PlaybackStop };
}>;

/** Constructors and matchers for `PlayerPhase`. */
export const PlayerPhase = Data.taggedEnum<PlayerPhase>();

/** Everything the player screen reads besides the port's own state. */
export interface PlayerSnapshot {
  readonly phase: PlayerPhase;
  readonly playback: Playback.Playback | null;
  /** The native player of the stream playing, for the video view. */
  readonly video: VideoPlayer | null;
  /** The audio track playing, as an ffmpeg stream index. */
  readonly audioStreamIndex: number | null;
  /** The subtitle track shown, or null for none. */
  readonly subtitleId: string | null;
  /** How much later than their file says text subtitles show, in milliseconds. */
  readonly subtitleDelayMs: number;
  readonly quality: QualityChoice;
  readonly rate: number;
  /**
   * Playback stood still while meant to play and the player started its stream again, until the
   * new stream has played on.
   */
  readonly recovering: boolean;
}

interface SubtitleDelay {
  readonly trackId: string;
  readonly ms: number;
}

const RENEW_BEFORE_MS = 5 * 60 * 1000;

const RETIRE_AFTER_MS = 1_000;

const TIME_UPDATE_SECONDS = 0.25;

const STALL_CHECK_MS = 1_000;

const STALLED_REASON = "Playback stood still while meant to play";

const monotonicNow = (): number => performance.now();

const STOPPED = PlaybackStop.Interrupted({ message: STOPPED_MESSAGE });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runSdk = async <A, E>(
  runtime: Runtime,
  effect: Effect.Effect<A, E, Movies.Services>,
): Promise<Result.Result<A, E> | null> => {
  const exit = await runtime.runPromiseExit(Effect.result(effect));

  return Exit.isSuccess(exit) ? exit.value : null;
};

const inGeneration = (
  playback: Playback.Playback,
  moved: { readonly generation: number; readonly playlistUrl: string },
): Playback.Playback => ({
  started: playback.started,
  stream: Struct.evolve(playback.stream, {
    url: () => moved.playlistUrl,
    generation: () => moved.generation,
  }),
});

/** What the controller needs from the screen. */
export interface PlayerControllerOptions {
  /**
   * Start a new playback session at `positionMs`: the old one ended elsewhere. `intentAt` is the
   * play intent its startup counts from: the viewer's latest, unless the old session played since.
   */
  readonly onNewSession: (positionMs: number, intentAt: number | null) => void;
  /** The quality to start at, from App Settings' Streaming Quality. */
  readonly quality: QualityChoice;
  /**
   * When the viewer asked to play, in milliseconds since the epoch; startup stages count from it.
   * None for a session the player started on its own after one played.
   */
  readonly intentAt: number | null;
}

/** Plays one session's streams. Create it, `start` it with the session, and `dispose` it. */
export class PlayerController {
  /** The player as the SDK's progress reporter sees it. */
  readonly port = new VideoPort();
  readonly #runtime: Runtime;
  readonly #options: PlayerControllerOptions;
  #capabilities: ClientCapabilities = IOS_CAPABILITIES;
  #original: Playback.Playback | null = null;
  #playback: Playback.Playback | null = null;
  #video: VideoPlayer | null = null;
  #diagnostics: {
    readonly recorder: PlayerDiagnostics.Recorder;
    readonly scope: Scope.Closeable;
  } | null = null;
  readonly #videoSubscriptions = new Map<VideoPlayer, { remove(): void }>();
  #generation = 0;
  #negotiation = 0;
  #recoveries = 0;
  #renewTimer: ReturnType<typeof setTimeout> | undefined;
  #stallTimer: ReturnType<typeof setInterval> | undefined;
  #stallWatch: StallWatch = watching(0, monotonicNow());
  #burnIn: string | null = null;
  #delay: SubtitleDelay | null = null;
  #volume = 1;
  #seeks = 0;
  #generationStart = 0;
  #reloadedAfterError = false;
  #frameShown = false;
  #metadata: VideoMetadata = {};
  #disposed = false;
  #snapshot: PlayerSnapshot = {
    phase: PlayerPhase.Preparing(),
    playback: null,
    video: null,
    audioStreamIndex: null,
    subtitleId: null,
    subtitleDelayMs: 0,
    quality: "auto",
    rate: 1,
    recovering: false,
  };
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribePort: () => void;

  constructor(runtime: Runtime, options: PlayerControllerOptions) {
    this.#runtime = runtime;
    this.#options = options;
    this.#snapshot = { ...this.#snapshot, quality: options.quality };
    this.#unsubscribePort = this.port.subscribe((event) => {
      if (event === "playing") {
        this.#recoveries = 0;
        this.#reloadedAfterError = false;
      }
    });
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): PlayerSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(change: Partial<PlayerSnapshot>): void {
    if (this.#disposed) return;

    const next = { ...this.#snapshot, ...change };
    const delay = this.#delay;

    this.#snapshot = {
      ...next,
      subtitleDelayMs: delay !== null && delay.trackId === next.subtitleId ? delay.ms : 0,
    };

    for (const listener of this.#listeners) listener();
  }

  /**
   * Plays the session `usePlaybackSession` started, whose stream starts at the saved progress
   * unless the viewer asked to start over. It plays at once; there is no resume prompt. A
   * `streamed` session (not a kept download) reports what AVPlayer sees to the media service.
   */
  start(playback: Playback.Playback, streamed: boolean): void {
    if (this.#original !== null || this.#disposed) return;
    this.#original = playback;

    if (streamed) this.#diagnose();

    this.#update({ phase: PlayerPhase.Preparing() });
    this.#load(playback, playback.stream.startSeconds * 1000);
    void this.port.play();
    this.#watchForStalls();
  }

  /**
   * Starts the stream again where it stood when playback stands still while meant to play, and
   * stops with Retry when that does not help. AVPlayer raises no error when its stream vanishes.
   */
  #watchForStalls(): void {
    this.#stallWatch = watching(this.port.positionMs(), monotonicNow());
    clearInterval(this.#stallTimer);
    this.#stallTimer = setInterval(() => {
      this.#checkStall();
    }, STALL_CHECK_MS);
  }

  #checkStall(): void {
    const [watch, verdict] = checked(this.#stallWatch, {
      atMs: monotonicNow(),
      positionMs: this.port.positionMs(),
      intended:
        this.#playback !== null &&
        this.port.wantsToPlay() &&
        !this.port.getState().ended &&
        !PlayerPhase.$is("Stopped")(this.#snapshot.phase),
      loading: this.port.settling(),
    });

    this.#stallWatch = watch;

    StallVerdict.$match(verdict, {
      Wait: () => {
        if (watch.attempts === 0 && this.#snapshot.recovering) this.#update({ recovering: false });
      },
      Recover: () => {
        this.#update({ recovering: true });
        void this.#follow(
          PlaybackStep.Renegotiate({ afterMs: 0 }),
          this.port.positionMs(),
          STALLED_REASON,
        );
      },
      GiveUp: () => {
        this.#stop(STOPPED);
      },
    });
  }

  #diagnose(): void {
    const scope = Scope.makeUnsafe();

    const started = this.#runtime.runSyncExit(
      Scope.provide(scope)(
        PlayerDiagnostics.reportDiagnostics(this.port, {
          platform: "ios",
          playback: () => Option.fromNullishOr(this.#playback),
          bufferedAheadSeconds: () =>
            this.#video === null ? 0 : bufferedAheadSeconds(this.#video),
          frames: () => Option.none(),
        }),
      ),
    );

    if (Exit.isSuccess(started)) {
      this.#diagnostics = { recorder: started.value, scope };

      if (this.#options.intentAt !== null) started.value.intent(this.#options.intentAt);
      started.value.reached("negotiated");
    }
  }

  #observe(observation: PlayerObservation): void {
    this.#diagnostics?.recorder.record(observation);
  }

  #closeDiagnostics(): void {
    const diagnostics = this.#diagnostics;

    this.#diagnostics = null;

    if (diagnostics !== null) {
      diagnostics.recorder.close();
      void this.#runtime.runPromiseExit(Scope.close(diagnostics.scope, Exit.void));
    }
  }

  /** Names what plays on the lock screen and in Control Center, from the next stream on. */
  setMetadata(metadata: VideoMetadata): void {
    this.#metadata = metadata;
  }

  /** Moves playback to `positionMs`, as the viewer asked. */
  seek(positionMs: number): void {
    this.#seeks += 1;
    this.port.seek(positionMs);
  }

  #load(playback: Playback.Playback, positionMs: number): void {
    const generation = ++this.#generation;
    const { stream } = playback;

    const video = createVideoPlayer({
      uri: stream.url,
      contentType: stream.mode === "direct" ? "auto" : "hls",
      metadata: this.#metadata,
    });

    // Set while the source loads, so AVPlayer applies it before asking for any media.
    video.currentTime = positionMs / 1000;
    video.timeUpdateEventInterval = TIME_UPDATE_SECONDS;
    video.volume = this.#volume;
    video.playbackRate = this.#snapshot.rate;
    video.staysActiveInBackground = true;
    video.showNowPlayingNotification = true;
    video.allowsExternalPlayback = true;

    const statusChanges = video.addListener("statusChange", ({ status, error }) => {
      if (generation !== this.#generation) return;

      if (status === "error") this.#onPlayerError(error?.message);
    });

    const sourceLoads = video.addListener("sourceLoad", () => {
      if (generation === this.#generation && stream.mode !== "direct") {
        this.#diagnostics?.recorder.reached("manifestLoaded");
      }
    });

    this.#videoSubscriptions.set(video, {
      remove: () => {
        statusChanges.remove();
        sourceLoads.remove();
      },
    });

    this.#retire(this.#video);
    this.#video = video;
    this.#playback = playback;
    this.#generationStart = positionMs / 1000;
    this.port.attach(video, {
      positionMs,
      durationMs:
        playback.started.file.probe.durationMs > 0 ? playback.started.file.probe.durationMs : null,
      seeker: stream.mode === "direct" ? NATIVE_SEEKER : this.#hlsSeeker(),
    });
    this.#update({ video, playback, audioStreamIndex: stream.audio?.streamIndex ?? null });
    this.#observe(PlayerDiagnostics.attached(playback, "avplayer"));
    this.#scheduleRenewal(stream);
  }

  #retire(video: VideoPlayer | null): void {
    if (video === null) return;

    this.#videoSubscriptions.get(video)?.remove();
    this.#videoSubscriptions.delete(video);
    video.pause();
    setTimeout(() => {
      video.release();
    }, RETIRE_AFTER_MS);
  }

  /**
   * The video view showed the stream's first frame: Preparing gives way to the video. AVPlayer's
   * ready state comes too early for that, before a transcode has produced a picture.
   */
  showedFrame(): void {
    this.#frameShown = true;
    this.#diagnostics?.recorder.reached("firstFrame");

    if (PlayerPhase.$is("Preparing")(this.#snapshot.phase)) {
      this.#update({ phase: PlayerPhase.Playing() });
    }
  }

  #onPlayerError(message: string | undefined): void {
    const playback = this.#playback;

    if (playback === null) return;

    const observed = playerErrorObservation(message);
    const step = afterPlayerError(playback.stream, this.#reloadedAfterError);

    this.#observe(observed);

    if (PlaybackStep.$is("ReloadPlaylist")(step)) this.#reloadedAfterError = true;
    void this.#follow(step, this.port.positionMs(), message ?? "AVPlayer failed");
  }

  #hlsSeeker(): StreamSeeker {
    return {
      reaches: (positionMs) => {
        const video = this.#video;

        return (
          video !== null &&
          withinBuffer(
            video.currentTime,
            video.bufferedPosition,
            this.#generationStart,
            positionMs / 1000,
          )
        );
      },
      move: async (positionMs, signal) => {
        const playback = this.#playback;

        if (playback === null) return;

        const ticket = this.#negotiation;

        const moved = await runSdk(
          this.#runtime,
          Playback.seekStream(playback, Milliseconds.make(positionMs)),
        );

        if (
          signal.aborted ||
          this.#isDisposed() ||
          playback !== this.#playback ||
          ticket !== this.#negotiation
        ) {
          return;
        }

        if (moved === null) {
          return this.#follow(
            PlaybackStep.Renegotiate({ afterMs: 0 }),
            positionMs,
            "The seek could not reach the media service",
          );
        }

        if (Result.isFailure(moved)) {
          return this.#follow(
            afterPlaybackFailure(moved.failure),
            positionMs,
            moved.failure.message,
          );
        }

        this.#moveTo(playback, moved.success, positionMs);
      },
    };
  }

  #moveTo(
    playback: Playback.Playback,
    moved: Option.Option<{ readonly generation: number; readonly playlistUrl: string }>,
    positionMs: number,
  ): void {
    if (Option.isNone(moved) || moved.value.generation === playback.stream.generation) {
      this.#generationStart = positionMs / 1000;

      if (this.#video !== null) this.#video.currentTime = positionMs / 1000;

      return;
    }

    this.#load(inGeneration(playback, moved.value), positionMs);
  }

  async #follow(step: PlaybackStep, positionMs: number, reason: string): Promise<void> {
    if (this.#disposed) return;

    const recovery = recoveryObservation(step, reason);

    if (Option.isSome(recovery)) this.#observe(recovery.value);

    if (PlaybackStep.$is("Stop")(step)) return this.#stop(step.stop);

    this.#recoveries += 1;

    if (this.#recoveries > MAX_RECOVERIES) return this.#stop(STOPPED);

    const playback = this.#playback;

    if (playback === null || PlaybackStep.$is("NewSession")(step)) {
      this.#options.onNewSession(
        positionMs,
        Option.getOrNull(
          Option.flatMap(Option.fromNullishOr(this.#diagnostics), ({ recorder }) =>
            recorder.intentAt(),
          ),
        ),
      );

      return;
    }

    return PlaybackStep.$match(step, {
      Stop: () => Promise.resolve(),
      NewSession: () => Promise.resolve(),
      ReloadPlaylist: () => this.#reloadPlaylist(playback, positionMs),
      TryAnotherWay: () => {
        const narrower = withoutFailedPath(this.#capabilities, playback.stream);

        if (narrower === null) {
          this.#stop(PlaybackStop.Unsupported());

          return Promise.resolve();
        }

        this.#capabilities = narrower;

        return this.#renegotiate(positionMs);
      },
      Renegotiate: async ({ afterMs }) => {
        await sleep(afterMs);

        return this.#renegotiate(positionMs);
      },
    });
  }

  async #reloadPlaylist(playback: Playback.Playback, positionMs: number): Promise<void> {
    const ticket = this.#negotiation;

    const moved = await runSdk(
      this.#runtime,
      Playback.seekStream(playback, Milliseconds.make(positionMs)),
    );

    if (this.#isDisposed() || playback !== this.#playback || ticket !== this.#negotiation) return;

    if (moved !== null && Result.isSuccess(moved)) {
      // A reload after an error needs a fresh player even in the same generation.
      const next = Option.getOrNull(moved.success);

      this.#load(next === null ? playback : inGeneration(playback, next), positionMs);

      return;
    }

    return this.#renegotiate(positionMs);
  }

  #stop(stop: PlaybackStop): void {
    this.#negotiation += 1;
    clearTimeout(this.#renewTimer);
    this.port.pause();
    this.#update({ phase: PlayerPhase.Stopped({ stop }), recovering: false });
  }

  #choices(): Playback.StreamChoices {
    return {
      quality: Option.fromNullishOr(qualityCap(this.#snapshot.quality)),
      burnInSubtitle: Option.fromNullishOr(this.#burnIn),
    };
  }

  async #renegotiate(positionMs: number, revert?: () => void): Promise<void> {
    const playback = this.#playback;

    if (playback === null || this.#disposed) return;

    const ticket = ++this.#negotiation;
    const seeks = this.#seeks;

    const renewed = await runSdk(
      this.#runtime,
      Playback.renegotiate(
        playback,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#snapshot.audioStreamIndex),
        this.#choices(),
      ),
    );

    if (this.#isDisposed() || ticket !== this.#negotiation) {
      if (renewed !== null && Result.isSuccess(renewed)) this.#stopUnused(renewed.success);

      return;
    }

    if (seeks !== this.#seeks) {
      if (renewed !== null && Result.isSuccess(renewed)) this.#stopUnused(renewed.success);

      return this.#renegotiate(this.port.positionMs(), revert);
    }

    if (renewed === null) return this.#stop(STOPPED);

    if (Result.isFailure(renewed) && isUnhonoured(renewed.failure)) {
      if (revert !== undefined) {
        revert();

        return;
      }

      if (this.#dropChoices()) return this.#renegotiate(positionMs);
    }

    if (Result.isFailure(renewed)) {
      return this.#follow(
        afterPlaybackFailure(renewed.failure),
        positionMs,
        renewed.failure.message,
      );
    }

    this.#diagnostics?.recorder.tokenRenewed(playback, renewed.success);
    this.#diagnostics?.recorder.reached("negotiated");
    this.#load(renewed.success, positionMs);
  }

  #stopUnused(playback: Playback.Playback): void {
    void runSdk(this.#runtime, Playback.stop(playback));
  }

  #dropChoices(): boolean {
    if (this.#snapshot.quality === "auto" && this.#burnIn === null) return false;

    const shown = this.#burnIn === null ? this.#snapshot.subtitleId : null;

    this.#burnIn = null;
    this.#update({ quality: "auto", subtitleId: shown });

    return true;
  }

  #scheduleRenewal(stream: NegotiateResponse): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      void this.#renegotiate(this.port.positionMs());
    }, due);
  }

  /** Switches to another audio track by renegotiating with it. */
  selectAudio(streamIndex: number): void {
    const before = this.#snapshot.audioStreamIndex;

    if (streamIndex === before) return;

    this.#update({ audioStreamIndex: streamIndex });
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#update({ audioStreamIndex: before });
    });
  }

  /**
   * Shows subtitle track `id`, or none. A picture subtitle needs a stream with it burned in, and
   * leaving one goes back to a stream without it: both renegotiate. Text tracks switch in place.
   */
  selectSubtitle(id: string | null): void {
    const track = this.#playback?.stream.subtitles.find((candidate) => candidate.id === id);
    const burnIn = track?.kind === "bitmap" ? track.id : null;
    const before = { subtitleId: this.#snapshot.subtitleId, burnIn: this.#burnIn };

    if (id !== null && burnIn === null && id !== this.#delay?.trackId) this.#delay = null;
    this.#update({ subtitleId: id });

    if (burnIn === this.#burnIn) return;

    this.#burnIn = burnIn;
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#burnIn = before.burnIn;
      this.#update({ subtitleId: before.subtitleId });
    });
  }

  /** Shows the text subtitles `delayMs` later than their file says (earlier when negative). */
  setSubtitleDelay(delayMs: number): void {
    const { subtitleId } = this.#snapshot;

    if (subtitleId === null || this.#burnIn !== null) return;

    this.#delay = { trackId: subtitleId, ms: clampSubtitleDelay(delayMs) };
    this.#update({});
  }

  /** Plays at `quality` from here on, renegotiating when it changes. */
  selectQuality(quality: QualityChoice): void {
    const before = this.#snapshot.quality;

    if (quality === before) return;

    this.#update({ quality });
    void this.#renegotiate(this.port.positionMs(), () => {
      this.#update({ quality: before });
    });
  }

  /** Plays at `rate` times normal speed. */
  setRate(rate: number): void {
    this.port.setPlaybackRate(rate);
    this.#update({ rate });
  }

  /** Sets the app's own volume, from 0 to 1, for this and every later stream. */
  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));

    if (this.#video !== null) this.#video.volume = this.#volume;
  }

  /** Tries again from where playback stopped (F09 Retry, F13 Try Again). */
  retry(): void {
    this.#recoveries = 0;
    this.#update({
      phase: this.#frameShown ? PlayerPhase.Playing() : PlayerPhase.Preparing(),
      recovering: false,
    });

    const positionMs = this.port.positionMs();

    this.#stallWatch = watching(positionMs, monotonicNow());

    if (this.#playback === null) {
      this.#options.onNewSession(positionMs, Date.now());

      return;
    }

    this.#diagnostics?.recorder.intent();
    void this.port.play();
    void this.#renegotiate(positionMs);
  }

  /** Tries again below the quality that played (F09 Try Lower Quality). */
  tryLowerQuality(): void {
    const height = this.#playback?.stream.video.height ?? 0;

    this.#update({ quality: lowerQuality(height) ?? "480p" });
    this.retry();
  }

  /**
   * Stops playback and lets the native players go. The session itself ends when
   * `usePlaybackSession` closes, which also stops the stream it started; a renegotiated stream
   * that replaced it is stopped here.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#renewTimer);
    clearInterval(this.#stallTimer);
    this.#unsubscribePort();

    this.#closeDiagnostics();

    this.port.dispose();

    const current = this.#playback;

    if (current !== null && current.stream.streamId !== this.#original?.stream.streamId) {
      void runSdk(this.#runtime, Playback.stop(current));
    }

    this.#retire(this.#video);

    for (const subscription of this.#videoSubscriptions.values()) subscription.remove();
    this.#videoSubscriptions.clear();
    this.#video = null;
    this.#listeners.clear();
  }
}
