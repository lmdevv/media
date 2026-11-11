import type { ClientDiagnosticsRequest, PlayerObservation } from "@media/contracts/diagnostics";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import { Milliseconds } from "@media/contracts/units";
import { Playback, PlayerDiagnostics } from "@media/sdk/effect";
import { Data, Effect, Exit, Option, Result, Scope, Struct } from "effect";
import { createVideoPlayer } from "expo-video";
import type { VideoMetadata, VideoPlayer } from "expo-video";

import { StreamLifecycle } from "@/lib/player/app-state";
import type { AppStatus, HeldStream, LifecycleStep } from "@/lib/player/app-state";
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
import type { PlayCommands, StartedPlay } from "@/lib/player/play-session";
import { reportProgress } from "@/lib/player/progress-reporter";
import type { ReportedStart, StopReporting } from "@/lib/player/progress-reporter";
import { lowerQuality, qualityCap } from "@/lib/player/quality";
import type { QualityChoice } from "@/lib/player/quality";
import { StallVerdict, checked, watching } from "@/lib/player/stall-watchdog";
import type { StallWatch } from "@/lib/player/stall-watchdog";
import { clampSubtitleDelay } from "@/lib/player/subtitle-delay";
import { NATIVE_SEEKER, VideoPort, withinBuffer } from "@/lib/player/video-port";
import type { StreamSeeker } from "@/lib/player/video-port";

/** Where the player's first stream comes from. */
export type PlaySource = Data.TaggedEnum<{
  /**
   * A start from `movies.play.start`: the player negotiates each stream with its ticket, from
   * `atMs`, with the audio track `audioStreamIndex` or the file's default.
   */
  Streamed: {
    readonly play: StartedPlay;
    readonly atMs: number;
    readonly audioStreamIndex: number | null;
  };
  /** A download kept on this iPhone, played from its file. */
  Kept: { readonly playback: Playback.Playback };
}>;

/** Constructors and matchers for `PlaySource`. */
export const PlaySource = Data.taggedEnum<PlaySource>();

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

/** Runs `effect` and returns its success or failure; defects and interruption become `null`. */
const runSdk = async <A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E> | null> => {
  const exit = await Effect.runPromiseExit(Effect.result(effect));

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

/** What the controller calls besides the media server. */
interface PlayerServices {
  /** `movies.play.report` of the signed-in person. */
  readonly report: PlayCommands["report"];
  /** Sends a batch of player diagnostics to the media server as the signed-in person. */
  readonly sendDiagnostics: (request: ClientDiagnosticsRequest) => Promise<void>;
}

/** What the controller needs from the screen. */
export interface PlayerControllerOptions {
  readonly services: PlayerServices;
  /**
   * Start again at `positionMs` with a new `movies.play.start`, which takes a new ticket: the
   * session ended, the server refused the ticket as expired, or the app came back from the
   * background. `intentAt` is the play intent its startup counts from: the viewer's latest, unless
   * the old start played since. `play` says whether the new start plays or stays paused.
   */
  readonly onNewSession: (positionMs: number, intentAt: number | null, play: boolean) => void;
  /** The quality to start at, from App Settings' Streaming Quality. */
  readonly quality: QualityChoice;
  /**
   * When the viewer asked to play, in milliseconds since the epoch; startup stages count from it.
   * None for a start the player made on its own after one played.
   */
  readonly intentAt: number | null;
  /** Whether the first stream plays once it loads, or stays paused there. */
  readonly play: boolean;
  /** Whether the app is in the background as the player opens, from `AppState.currentState`. */
  readonly background: boolean;
}

/** Where playback was when the app went away and its stream stopped, or its start was deferred. */
interface Parked {
  readonly positionMs: number;
  readonly play: boolean;
  /** Start again on return; false for a player that had already stopped. */
  readonly restart: boolean;
}

/**
 * Plays one start's streams. Create it, `start` it, and `dispose` it.
 *
 * A streamed start takes one ticket from `movies.play.start`, and the controller never renews it
 * (ADR 0011): the media server continues a running stream past the ticket's expiry. When the
 * server answers that the session ended, or refuses an expired ticket for a new stream, the
 * controller asks the screen for a new start (`onNewSession`). The media service runs only a few
 * transcodes, so the controller stops its stream at once (`Playback.stopNow`) when it is disposed,
 * and when nobody watches or hears it while the app is away (`StreamLifecycle`): in the background
 * with no Picture in Picture and nothing playing.
 */
export class PlayerController {
  /** The player as the progress reporter and the diagnostics see it. */
  readonly port = new VideoPort();
  readonly #options: PlayerControllerOptions;
  #capabilities: ClientCapabilities = IOS_CAPABILITIES;
  #begun = false;
  /** The streamed start's playback as the media server reads it; null for a kept download. */
  #started: Playback.Playback["started"] | null = null;
  /** The streamed start the progress reports name. */
  #reported: ReportedStart | null = null;
  #reporting: StopReporting | null = null;
  #kept: Playback.Playback | null = null;
  #startAtMs = 0;
  #playback: Playback.Playback | null = null;
  /** The stream last stopped, so it is not stopped twice. */
  #stopped: Playback.Playback | null = null;
  /** The negotiation in flight, by its number; null when none is. */
  #negotiating: number | null = null;
  #parked: Parked | null = null;
  readonly #lifecycle: StreamLifecycle;
  #video: VideoPlayer | null = null;
  #diagnostics: {
    readonly recorder: PlayerDiagnostics.Recorder;
    readonly scope: Scope.Closeable;
  } | null = null;
  readonly #videoSubscriptions = new Map<VideoPlayer, { remove(): void }>();
  #generation = 0;
  #negotiation = 0;
  #recoveries = 0;
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

  constructor(options: PlayerControllerOptions) {
    this.#options = options;
    this.#lifecycle = new StreamLifecycle(options.background, options.play);
    this.#snapshot = { ...this.#snapshot, quality: options.quality };
    this.#unsubscribePort = this.port.subscribe((event) => {
      if (event === "playing") {
        this.#recoveries = 0;
        this.#reloadedAfterError = false;
        this.#followLifecycle(this.#lifecycle.playing(true, this.#holds()));
      } else if (event === "paused" || event === "ended") {
        this.#followLifecycle(this.#lifecycle.playing(false, this.#holds()));
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
   * Plays `source`, from where it starts; there is no resume prompt. A streamed start negotiates
   * its first stream here and reports its progress and what AVPlayer sees to the server.
   */
  start(source: PlaySource): void {
    if (this.#begun || this.#disposed) return;
    this.#begun = true;
    this.#update({ phase: PlayerPhase.Preparing() });

    if (this.#options.play) void this.port.play();

    PlaySource.$match(source, {
      Kept: ({ playback }) => {
        this.#kept = playback;
        this.#load(playback, playback.stream.startSeconds * 1000);
      },
      Streamed: ({ play, atMs, audioStreamIndex }) => {
        this.#started = play.started;
        this.#reported = play.start;
        this.#startAtMs = atMs;
        this.#diagnose();
        this.#update({ audioStreamIndex });

        // The start may answer after the app went away: then no stream opens until it is back.
        if (this.#lifecycle.started() === "negotiate") void this.#renegotiate(atMs);
        else this.#parked = { positionMs: atMs, play: this.#options.play, restart: true };
      },
    });
    this.#watchForStalls();
  }

  /** Where playback is, or where the first stream will start before it loads. */
  #positionNow(): number {
    return this.#playback === null ? this.#startAtMs : this.port.positionMs();
  }

  /** Follows the app's state; see `StreamLifecycle`. */
  appStateChanged(status: AppStatus): void {
    this.#followLifecycle(this.#lifecycle.appState(status, this.#holds()));
  }

  /** Follows Picture in Picture opening and closing; see `StreamLifecycle`. */
  pictureInPictureChanged(active: boolean): void {
    this.#followLifecycle(this.#lifecycle.pictureInPicture(active, this.#holds()));
  }

  #followLifecycle(step: LifecycleStep): void {
    if (this.#disposed) return;

    if (step === "stop") this.#park();
    else if (step === "restart") this.#return();
  }

  #holds(): HeldStream {
    if (this.#started === null) return "none";

    if (this.#negotiating === this.#negotiation) return "server";

    return this.#playback?.stream.streamId === undefined ? "none" : "server";
  }

  #park(): void {
    this.#parked = {
      positionMs: this.#positionNow(),
      play: this.port.wantsToPlay(),
      restart: !PlayerPhase.$is("Stopped")(this.#snapshot.phase),
    };
    // A negotiation in flight stops the stream it gets.
    this.#negotiation += 1;
    this.port.pause();
    this.#stopStream();
  }

  #return(): void {
    const parked = this.#parked;

    this.#parked = null;

    if (parked === null || !parked.restart) return;
    this.#options.onNewSession(parked.positionMs, null, parked.play);
  }

  /** Stops the current server stream at once, unless it was stopped already. */
  #stopStream(): void {
    const playback = this.#playback;

    if (playback === null || playback === this.#stopped) return;
    this.#stopped = playback;
    Playback.stopNow(playback);
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
        this.#parked === null &&
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

    const started = Effect.runSyncExit(
      Scope.provide(scope)(
        PlayerDiagnostics.reportDiagnostics(this.port, {
          platform: "ios",
          playback: () => Option.fromNullishOr(this.#playback),
          bufferedAheadSeconds: () =>
            this.#video === null ? 0 : bufferedAheadSeconds(this.#video),
          frames: () => Option.none(),
          send: this.#options.services.sendDiagnostics,
        }),
      ),
    );

    if (Exit.isSuccess(started)) {
      this.#diagnostics = { recorder: started.value, scope };

      if (this.#options.intentAt !== null) started.value.intent(this.#options.intentAt);
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
      void Effect.runPromiseExit(Scope.close(diagnostics.scope, Exit.void));
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

        const moved = await runSdk(Playback.seekStream(playback, Milliseconds.make(positionMs)));

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
    if (this.#disposed || this.#parked !== null) return;

    const recovery = recoveryObservation(step, reason);

    if (Option.isSome(recovery)) this.#observe(recovery.value);

    if (PlaybackStep.$is("Stop")(step)) return this.#stop(step.stop);

    this.#recoveries += 1;

    if (this.#recoveries > MAX_RECOVERIES) return this.#stop(STOPPED);

    const kept = this.#kept;

    // A kept download has no stream to negotiate: AVPlayer opens its file again.
    if (kept !== null) return this.#load(kept, positionMs);

    if (PlaybackStep.$is("NewSession")(step)) {
      this.#options.onNewSession(
        positionMs,
        Option.getOrNull(
          Option.flatMap(Option.fromNullishOr(this.#diagnostics), ({ recorder }) =>
            recorder.intentAt(),
          ),
        ),
        this.port.wantsToPlay(),
      );

      return;
    }

    const playback = this.#playback;

    if (playback === null) {
      if (PlaybackStep.$is("Renegotiate")(step)) await sleep(step.afterMs);

      return this.#renegotiate(positionMs);
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

    const moved = await runSdk(Playback.seekStream(playback, Milliseconds.make(positionMs)));

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
    this.port.pause();
    this.#update({ phase: PlayerPhase.Stopped({ stop }), recovering: false });
  }

  #choices(): Playback.StreamChoices {
    return {
      quality: Option.fromNullishOr(qualityCap(this.#snapshot.quality)),
      burnInSubtitle: Option.fromNullishOr(this.#burnIn),
    };
  }

  /**
   * Negotiates a stream of the current start at `positionMs` with its ticket, which the media
   * server never needs renewed for a running stream. A ticket it refuses as expired leads to a new
   * start (`afterPlaybackFailure`).
   *
   * @param revert - For a negotiation the viewer asked for (another track, quality, or picture
   *   subtitle): undoes the choice when the service cannot honour it, and the current stream plays
   *   on.
   */
  async #renegotiate(positionMs: number, revert?: () => void): Promise<void> {
    const started = this.#started;

    if (started === null || this.#disposed || this.#parked !== null) return;

    const ticket = ++this.#negotiation;
    const seeks = this.#seeks;

    this.#negotiating = ticket;

    const negotiated = await runSdk(
      Playback.negotiate(
        started,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#snapshot.audioStreamIndex),
        this.#choices(),
      ),
    );

    if (this.#negotiating === ticket) this.#negotiating = null;

    const fresh: Playback.Playback | null =
      negotiated !== null && Result.isSuccess(negotiated)
        ? { started, stream: negotiated.success }
        : null;

    if (this.#isDisposed() || ticket !== this.#negotiation) {
      if (fresh !== null) this.#stopUnused(fresh);

      return;
    }

    if (seeks !== this.#seeks) {
      if (fresh !== null) this.#stopUnused(fresh);

      return this.#renegotiate(this.#positionNow(), revert);
    }

    if (negotiated === null) return this.#stop(STOPPED);

    if (Result.isFailure(negotiated) && isUnhonoured(negotiated.failure)) {
      if (revert !== undefined) {
        revert();

        return;
      }

      if (this.#dropChoices()) return this.#renegotiate(positionMs);
    }

    if (Result.isFailure(negotiated)) {
      return this.#follow(
        afterPlaybackFailure(negotiated.failure),
        positionMs,
        negotiated.failure.message,
      );
    }

    this.#diagnostics?.recorder.reached("negotiated");
    this.#startReporting();
    this.#load({ started, stream: negotiated.success }, positionMs);
  }

  /** Stops a stream negotiated for a player that no longer wants it, at once. */
  #stopUnused(playback: Playback.Playback): void {
    Playback.stopNow(playback);
  }

  #startReporting(): void {
    const reported = this.#reported;

    if (reported === null || this.#reporting !== null) return;
    this.#reporting = reportProgress(this.#options.services.report, reported, this.port);
  }

  #dropChoices(): boolean {
    if (this.#snapshot.quality === "auto" && this.#burnIn === null) return false;

    const shown = this.#burnIn === null ? this.#snapshot.subtitleId : null;

    this.#burnIn = null;
    this.#update({ quality: "auto", subtitleId: shown });

    return true;
  }

  /** Switches to another audio track by renegotiating with it. */
  selectAudio(streamIndex: number): void {
    const before = this.#snapshot.audioStreamIndex;

    if (streamIndex === before) return;

    this.#update({ audioStreamIndex: streamIndex });
    void this.#renegotiate(this.#positionNow(), () => {
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
    void this.#renegotiate(this.#positionNow(), () => {
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
    void this.#renegotiate(this.#positionNow(), () => {
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

  /**
   * Tries again from where playback stopped (F09 Retry, F13 Try Again), with the current start's
   * ticket; one the server refuses as expired leads to a new start.
   */
  retry(): void {
    this.#recoveries = 0;
    this.#update({
      phase: this.#frameShown ? PlayerPhase.Playing() : PlayerPhase.Preparing(),
      recovering: false,
    });

    const positionMs = this.#positionNow();

    this.#stallWatch = watching(positionMs, monotonicNow());
    this.#diagnostics?.recorder.intent();
    void this.port.play();

    const kept = this.#kept;

    if (kept !== null) {
      this.#load(kept, positionMs);

      return;
    }

    void this.#renegotiate(positionMs);
  }

  /** Tries again below the quality that played (F09 Try Lower Quality). */
  tryLowerQuality(): void {
    const height = this.#playback?.stream.video.height ?? 0;

    this.#update({ quality: lowerQuality(height) ?? "480p" });
    this.retry();
  }

  /**
   * Stops playback, reports where it stopped, stops the server stream at once so its transcode slot
   * is free, and lets the native players go.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.close();
    clearInterval(this.#stallTimer);
    this.#unsubscribePort();

    // The last report reads the port's position, which disposing it freezes.
    const reporting = this.#reporting;

    this.#reporting = null;

    if (reporting !== null) void reporting();
    this.#closeDiagnostics();
    this.#stopStream();
    this.port.dispose();
    this.#retire(this.#video);

    for (const subscription of this.#videoSubscriptions.values()) subscription.remove();
    this.#videoSubscriptions.clear();
    this.#video = null;
    this.#listeners.clear();
  }
}
