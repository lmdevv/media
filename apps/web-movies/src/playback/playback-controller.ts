import type { ClientDiagnosticsRequest } from "@media/contracts/diagnostics";
import type { ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import type { CallError } from "@media/sdk/effect";
import { Playback, PlayerDiagnostics } from "@media/sdk/effect";
import { Data, Effect, Exit, Option, Predicate, Result, Scope } from "effect";

import type { EpisodeId, MediaFileId, TitleId } from "@/lib/catalog";

import { withoutFailedPath } from "./capabilities";
import { bufferedAheadSeconds, frameCounts, recoveryObservation } from "./diagnostics";
import { sampleDrift } from "./drift";
import type { QualityChoice } from "./quality";
import { qualityCap } from "./quality";
import { ELEMENT_SEEKER, MediaElementPlayer, isBuffered } from "./media-element-player";
import type { StreamSeeker } from "./media-element-player";
import {
  PlaybackStep,
  PlaybackStop,
  STOPPED_MESSAGE,
  afterPlaybackFailure,
  afterSessionFailure,
  afterStreamFailure,
  offersResume,
} from "./playback-policy";
import type { AttachedStream, Observe, StreamFailure } from "./stream-attachment";
import { attachStream, describeFailure, preloadHlsJs } from "./stream-attachment";
import { startArgs, startPlay } from "./play-session";
import type { CoreStart, PlayCommands, StartedPlay } from "./play-session";
import { reportProgress } from "./progress-reporter";
import type { StopReporting } from "./progress-reporter";
import { inGeneration, runSdk } from "./sdk-calls";
import { SubtitleRetimer, clampSubtitleDelay } from "./subtitle-timing";

/** Where playback starts. */
export type StartChoice = Data.TaggedEnum<{
  /** Ask with the resume prompt when there is saved progress, else start at the beginning. */
  Ask: {};
  Resume: {};
  Beginning: {};
}>;

/** Constructors and matchers for `StartChoice`. */
export const StartChoice = Data.taggedEnum<StartChoice>();

export interface PlaybackRequest {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | null;
  /** The version to play; null for the one the person last played, else the best quality. */
  readonly fileId: MediaFileId | null;
  readonly start: StartChoice;
  /** The quality this browser plays at, as the viewer last chose it. */
  readonly quality: QualityChoice;
}

export interface PlaybackServices {
  /** `movies.play.start` and `movies.play.report` of the signed-in person. */
  readonly play: PlayCommands;
  /** The media server's address, where streams are negotiated and media URLs point. */
  readonly mediaBaseUrl: string;
  /** Sends a batch of player diagnostics to the media server as the signed-in person. */
  readonly sendDiagnostics: (request: ClientDiagnosticsRequest) => Promise<void>;
}

/** Where playback stands. */
export type PlaybackPhase = Data.TaggedEnum<{
  /** Starting the playback with `movies.play.start`. */
  Starting: {};
  /** Waiting for the viewer to resume or start over. */
  Choosing: { readonly resumeAtMs: number };
  /** Negotiating and loading a stream; `progress` runs from 0 to 1. */
  Preparing: { readonly startAtMs: number; readonly progress: number };
  /** The stream showed its first frame; buffering and pausing are the element's business. */
  Playing: {};
  /** A path failed and another one is being negotiated. */
  Recovering: { readonly positionMs: number };
  Stopped: { readonly stop: PlaybackStop };
}>;

/** Constructors and matchers for `PlaybackPhase`. */
export const PlaybackPhase = Data.taggedEnum<PlaybackPhase>();

/** Everything the player UI reads. */
export interface PlaybackSnapshot {
  readonly phase: PlaybackPhase;
  /** The latest start as the core answered it: its ids, episode, and file name things to the platform. */
  readonly coreStart: CoreStart | null;
  /** The same start as the media server reads it, with its ticket as the token. */
  readonly started: StartedPlayback | null;
  readonly stream: NegotiateResponse | null;
  /** The audio track playing, as an ffmpeg stream index. */
  readonly audioStreamIndex: number | null;
  /**
   * The subtitle track shown, or null for none. A picture subtitle shows once a stream that burns
   * it in has loaded; the stream's `burnedInSubtitle` says which one is in the video.
   */
  readonly subtitleId: string | null;
  /**
   * How much later than their file says the text subtitles show, in milliseconds; negative is
   * earlier. It belongs to the text track and file it was set for, and reads 0 while anything else
   * shows: Off or a picture track and back to that track has it again, while choosing another text
   * track, or a version that then plays, drops it.
   */
  readonly subtitleDelayMs: number;
  readonly quality: QualityChoice;
  /**
   * The quality the loaded stream was negotiated with, once one has loaded; it trails `quality`
   * while a change negotiates, and never takes a choice the service refused.
   */
  readonly loadedQuality: QualityChoice | null;
  /** The browser refused to start playback until the viewer interacts with the page. */
  readonly needsGesture: boolean;
}

const MAX_RECOVERIES = 3;

const PLAYBACK_MARKS = {
  start: "movies:playback-start",
  firstFrame: "movies:first-frame",
} as const;

const STOPPED = PlaybackStop.Failed({ message: STOPPED_MESSAGE });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isPlaying = PlaybackPhase.$is("Playing");

const UNHONOURED = [
  "UnsupportedPlayback",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
] as const;

const isUnhonoured = (failure: { readonly _tag: string }): boolean =>
  UNHONOURED.some((tag) => Predicate.isTagged(failure, tag));

interface StreamChoice {
  readonly quality: QualityChoice;
  readonly burnIn: string | null;
}

interface CarriedLanguages {
  readonly audio: string | null;
  readonly subtitle: string | null;
}

interface VersionSwitch {
  readonly positionMs: number;
  readonly play: boolean;
  readonly from: MediaFileId;
}

interface SubtitleDelay {
  readonly fileId: string;
  readonly trackId: string;
  readonly ms: number;
}

const delayShown = (
  delay: SubtitleDelay | null,
  snapshot: Pick<PlaybackSnapshot, "started" | "subtitleId">,
): number =>
  delay !== null &&
  delay.trackId === snapshot.subtitleId &&
  delay.fileId === snapshot.started?.file.id
    ? delay.ms
    : 0;

const refusesFile = (failure: CallError): boolean =>
  Predicate.isTagged(failure, "Conflict") || Predicate.isTagged(failure, "NotFound");

/**
 * Plays one request in one element. Create it, `start` it, and `dispose` it.
 *
 * Each start takes one ticket from `movies.play.start`, and the controller never renews it (ADR
 * 0011): the media server continues a running stream past the ticket's expiry. When the server
 * answers that the session ended, or refuses an expired ticket for a new stream (after a lost
 * stream, or an audio, quality, or subtitle change long after the start), the controller starts
 * again from where playback is, which takes a new ticket.
 */
export class PlaybackController {
  /** The element as the SDK sees it, which the progress reports and diagnostics follow. */
  readonly player: MediaElementPlayer;
  readonly #services: PlaybackServices;
  readonly #element: HTMLVideoElement;
  readonly #request: PlaybackRequest;
  readonly #hlsJs: boolean;
  #capabilities: ClientCapabilities;
  #fileId: MediaFileId | null;
  #carried: CarriedLanguages | null = null;
  #switching: VersionSwitch | null = null;
  #burnIn: string | null = null;
  #loadedBurnIn: string | null = null;
  #choicesVersion = 0;
  #negotiation = 0;
  #loading: { readonly atMs: number; readonly play: boolean } | null = null;
  #snapshot: PlaybackSnapshot = {
    phase: PlaybackPhase.Starting(),
    coreStart: null,
    started: null,
    stream: null,
    audioStreamIndex: null,
    subtitleId: null,
    subtitleDelayMs: 0,
    quality: "auto",
    loadedQuality: null,
    needsGesture: false,
  };
  readonly #listeners = new Set<() => void>();
  #current: StartedPlay | null = null;
  #playback: Playback.Playback | null = null;
  #attached: AttachedStream | null = null;
  #generation = 0;
  #recoveries = 0;
  #reporting: StopReporting | null = null;
  #diagnostics: {
    readonly recorder: PlayerDiagnostics.Recorder;
    readonly scope: Scope.Closeable;
    readonly stopDrift: () => void;
  } | null = null;
  #disposed = false;
  readonly #retimer: SubtitleRetimer;
  #delay: SubtitleDelay | null = null;

  /**
   * @param hlsJs - Play HLS through hls.js rather than the element (`usesHlsJs`).
   */
  constructor(
    services: PlaybackServices,
    element: HTMLVideoElement,
    capabilities: ClientCapabilities,
    hlsJs: boolean,
    request: PlaybackRequest,
  ) {
    this.#services = services;
    this.#element = element;
    this.#capabilities = capabilities;
    this.#hlsJs = hlsJs;
    this.#request = request;
    this.#fileId = request.fileId;
    this.#snapshot = { ...this.#snapshot, quality: request.quality };
    this.player = new MediaElementPlayer(element);
    this.#retimer = new SubtitleRetimer(element);
    element.addEventListener("playing", this.#onPlaying);
    element.addEventListener("loadeddata", this.#onFirstFrame);
    element.addEventListener("pause", this.#onSettled);
    element.addEventListener("seeking", this.#onSettled);
    element.ownerDocument.defaultView?.addEventListener("pagehide", this.#onPageHide);
  }

  /**
   * A reload or a navigation away ends the page without unmounting the player, so `dispose` never
   * runs: stop the stream here, at once, or it holds a transcode slot until the media service's
   * idle release.
   */
  readonly #onPageHide = (): void => {
    if (this.#playback !== null) Playback.stopNow(this.#playback);
  };

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): PlaybackSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(change: Partial<PlaybackSnapshot>): void {
    if (this.#disposed) return;

    const next = { ...this.#snapshot, ...change };
    const delayMs = delayShown(this.#delay, next);

    if (delayMs !== this.#snapshot.subtitleDelayMs) this.#retimer.set(delayMs);
    this.#snapshot = { ...next, subtitleDelayMs: delayMs };

    for (const listener of this.#listeners) listener();
  }

  #stop(stop: PlaybackStop): void {
    this.#negotiation += 1;
    this.#switching = null;
    this.#detach();
    this.#update({ phase: PlaybackPhase.Stopped({ stop }) });
  }

  /**
   * Starts the playback, then negotiates or asks where to start. A version the request names that
   * is gone from disk gives way to the one the server picks.
   */
  start(): Promise<void> {
    performance.mark(PLAYBACK_MARKS.start);
    this.#startDiagnostics();
    this.#diagnostics?.recorder.intent();

    return this.#begin();
  }

  async #begin(): Promise<void> {
    this.#update({ phase: PlaybackPhase.Starting() });

    const ticket = ++this.#negotiation;
    const created = await this.#createPlay();

    if (this.#disposed || ticket !== this.#negotiation) return;

    if (created === null) return this.#stop(STOPPED);

    if (Result.isFailure(created)) {
      if (this.#fileId !== null && refusesFile(created.failure)) {
        this.#fileId = null;

        return this.#begin();
      }

      return this.#follow(afterSessionFailure(created.failure), 0, created.failure.message);
    }

    const play = created.success;

    this.#adopt(play);
    this.#update({ coreStart: play.start, started: play.started });

    return StartChoice.$match(this.#request.start, {
      Beginning: () => this.#negotiate(play, 0),
      Resume: () => this.#negotiate(play, play.started.resumePositionMs),
      Ask: () => {
        if (!offersResume(play.started.resumePositionMs)) return this.#negotiate(play, 0);

        this.#update({
          phase: PlaybackPhase.Choosing({ resumeAtMs: play.started.resumePositionMs }),
        });

        return Promise.resolve();
      },
    });
  }

  /** Takes a new ticket with `movies.play.start`; null when the call failed unexpectedly. */
  #createPlay(): Promise<Result.Result<StartedPlay, CallError> | null> {
    return startPlay(
      this.#services.play,
      startArgs(this.#request, this.#fileId, this.#capabilities),
      this.#services.mediaBaseUrl,
    ).catch(() => null);
  }

  /** Makes `play` the current start, reporting its progress from its first stream on. */
  #adopt(play: StartedPlay): void {
    this.#current = play;
    this.#fileId = play.start.file.id;
  }

  /** Answers the resume prompt. */
  choose(from: "resume" | "beginning"): void {
    const play = this.#current;
    const { phase } = this.#snapshot;

    if (play === null || !PlaybackPhase.$is("Choosing")(phase)) return;

    this.#diagnostics?.recorder.intent();
    void this.#negotiate(play, from === "resume" ? phase.resumeAtMs : 0);
  }

  async #negotiate(play: StartedPlay, positionMs: number, autoplay = true): Promise<void> {
    this.#update({ phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.35 }) });

    if (this.#hlsJs) void preloadHlsJs().catch(() => undefined);

    const ticket = ++this.#negotiation;
    const version = this.#choicesVersion;
    const chosen = this.#chosen();

    const negotiated = await runSdk(
      Playback.negotiate(
        play.started,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#snapshot.audioStreamIndex),
        this.streamChoices(),
      ),
    );

    if (this.#disposed || ticket !== this.#negotiation) return;

    if (negotiated === null) return this.#stop(STOPPED);

    if (Result.isFailure(negotiated)) {
      if (isUnhonoured(negotiated.failure) && this.#dropChoices()) {
        return this.#negotiate(play, positionMs, autoplay);
      }

      const switching = this.#switching;

      if (switching !== null) {
        this.#switching = null;
        this.#fileId = switching.from;

        return this.#restart(switching.positionMs, switching.play);
      }

      return this.#follow(
        afterPlaybackFailure(negotiated.failure),
        positionMs,
        negotiated.failure.message,
      );
    }

    const playback: Playback.Playback = { started: play.started, stream: negotiated.success };

    this.#diagnostics?.recorder.reached("negotiated");
    this.#pickCarriedSubtitle(negotiated.success);
    this.#update({ phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.7 }) });
    this.#startReporting(play);
    await this.#load(playback, autoplay, chosen);
    this.#catchUpOnChoices(version, ticket);
  }

  #catchUpOnChoices(version: number, ticket: number): void {
    const playback = this.#playback;

    if (
      this.#disposed ||
      playback === null ||
      ticket !== this.#negotiation ||
      version === this.#choicesVersion
    ) {
      return;
    }

    void this.#renegotiate(playback, this.positionMs(), this.#snapshot.audioStreamIndex);
  }

  /** The playback position, or where the stream being attached starts. */
  positionMs(): number {
    return this.#loading?.atMs ?? this.player.positionMs();
  }

  /** Whether playback is under way, or the stream being attached will play. */
  playing(): boolean {
    return this.#loading?.play ?? !this.#element.paused;
  }

  async #load(playback: Playback.Playback, play: boolean, chosen: StreamChoice): Promise<void> {
    this.#detach();

    const generation = ++this.#generation;
    const { stream } = playback;

    this.#loading = { atMs: stream.startSeconds * 1000, play };
    this.#switching = null;
    this.#playback = playback;
    this.#update({
      stream,
      started: playback.started,
      audioStreamIndex: stream.audio?.streamIndex ?? null,
    });

    const attached = await attachStream(
      this.#element,
      stream,
      stream.startSeconds,
      this.#hlsJs,
      (failure) => {
        if (generation === this.#generation) this.#onStreamFailure(failure);
      },
      {
        observe: (observation) => {
          if (generation === this.#generation) this.#observe(observation);
        },
        reached: (stage) => {
          if (generation === this.#generation) this.#diagnostics?.recorder.reached(stage);
        },
      },
    );

    if (this.#disposed || generation !== this.#generation) {
      attached.detach();

      return;
    }

    this.#attached = attached;
    this.#observe(
      PlayerDiagnostics.attached(playback, attached.engine === "hls.js" ? "hls.js" : "html-video"),
    );
    this.#loadedBurnIn = chosen.burnIn;
    this.#update({ loadedQuality: chosen.quality });
    this.player.setSeeker(stream.mode === "direct" ? ELEMENT_SEEKER : this.#hlsSeeker());

    if (play) await this.#play();

    if (generation === this.#generation) this.#loading = null;
  }

  async #play(): Promise<void> {
    try {
      await this.player.play();
      this.#update({ needsGesture: false });
    } catch {
      this.#update({ needsGesture: true });
    }
  }

  /** Plays after the browser asked for a gesture; call it from a click or key handler. */
  resumeWithGesture(): void {
    void this.#play();
  }

  #detach(): void {
    this.#loading = null;
    this.#attached?.detach();
    this.#attached = null;
    this.player.setSeeker(ELEMENT_SEEKER);
  }

  #hlsSeeker(): StreamSeeker {
    return {
      reaches: (positionMs) => isBuffered(this.#element.buffered, positionMs / 1000),
      move: async (positionMs, signal) => {
        const playback = this.#playback;

        if (playback === null) return;

        const moved = await runSdk(Playback.seekStream(playback, Milliseconds.make(positionMs)));

        if (signal.aborted || this.#disposed || playback !== this.#playback) return;

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

        await this.#moveTo(playback, moved.success, positionMs);
      },
    };
  }

  async #moveTo(
    playback: Playback.Playback,
    moved: Option.Option<{ readonly generation: number; readonly playlistUrl: string }>,
    positionMs: number,
  ): Promise<void> {
    const seconds = positionMs / 1000;

    if (Option.isNone(moved) || moved.value.generation === playback.stream.generation) {
      this.#element.currentTime = seconds;

      return;
    }

    const next = inGeneration(playback, moved.value);

    const attached = this.#attached;

    this.#playback = next;
    this.#update({ stream: next.stream });

    if (attached === null) return;
    await attached.reloadPlaylist(next.stream.url, seconds);

    if (this.#disposed || this.#playback !== next || !this.player.wantsToPlay()) return;
    await this.#play();
  }

  #onStreamFailure(failure: StreamFailure): void {
    void this.#follow(afterStreamFailure(failure), this.positionMs(), describeFailure(failure));
  }

  readonly #observe: Observe = (observation) => {
    this.#diagnostics?.recorder.record(observation);
  };

  /**
   * Takes the recovery `step` from `positionMs`. `resume` says whether playback goes on afterwards
   * when it starts again with a new ticket; by default it plays.
   */
  async #follow(
    step: PlaybackStep,
    positionMs: number,
    reason: string,
    resume = true,
  ): Promise<void> {
    if (this.#disposed) return;

    const recovery = recoveryObservation(step, reason);

    if (Option.isSome(recovery)) this.#observe(recovery.value);

    if (PlaybackStep.$is("Stop")(step)) return this.#stop(step.stop);

    this.#recoveries += 1;

    if (this.#recoveries > MAX_RECOVERIES) return this.#stop(STOPPED);

    const playback = this.#playback;
    const play = this.#current;

    if (play === null || PlaybackStep.$is("NewSession")(step)) {
      return this.#restart(positionMs, resume);
    }

    if (playback === null) {
      if (PlaybackStep.$is("Renegotiate")(step)) await sleep(step.afterMs);

      return this.#negotiate(play, positionMs);
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
        this.#detach();
        this.#update({ phase: PlaybackPhase.Recovering({ positionMs }) });

        return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
      },
      Renegotiate: async ({ afterMs }) => {
        await sleep(afterMs);

        return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
      },
    });
  }

  async #reloadPlaylist(playback: Playback.Playback, positionMs: number): Promise<void> {
    const moved = await runSdk(Playback.seekStream(playback, Milliseconds.make(positionMs)));

    if (this.#disposed || playback !== this.#playback) return;

    if (moved !== null && Result.isSuccess(moved)) {
      return this.#moveTo(playback, moved.success, positionMs);
    }

    return this.#renegotiate(playback, positionMs, this.#snapshot.audioStreamIndex);
  }

  /**
   * Starts again at `positionMs` with a new `movies.play.start`, and so a new ticket: after the
   * session ended, after the server refused the old ticket as expired, or to play another version.
   * The old start's stream stops and its reports end at where it stopped.
   */
  async #restart(positionMs: number, play = true): Promise<void> {
    const ticket = ++this.#negotiation;
    const previous = this.#playback;
    // The last report reads the element's position, which detaching resets to 0.
    const reported = this.#closeReporting();

    this.#detach();
    this.#playback = null;

    if (previous !== null) void runSdk(Playback.stop(previous));
    await reported;

    const created = this.#disposed ? null : await this.#createPlay();

    if (this.#disposed || ticket !== this.#negotiation) return;

    const switching = this.#switching;

    if (switching !== null && (created === null || Result.isFailure(created))) {
      this.#switching = null;
      this.#fileId = switching.from;

      return this.#restart(switching.positionMs, switching.play);
    }

    if (created === null || Result.isFailure(created)) this.#carried = null;

    if (created === null) return this.#stop(STOPPED);

    if (Result.isFailure(created)) {
      return this.#follow(
        afterSessionFailure(created.failure),
        positionMs,
        created.failure.message,
      );
    }

    const next = created.success;
    const durationMs = next.started.file.probe.durationMs;

    this.#adopt(next);
    this.#update(
      this.#carried === null
        ? { coreStart: next.start, started: next.started }
        : {
            coreStart: next.start,
            started: next.started,
            audioStreamIndex: this.#carriedAudio(next.started),
          },
    );

    return this.#negotiate(
      next,
      durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs,
      play,
    );
  }

  #carriedAudio(started: StartedPlayback): number | null {
    const language = this.#carried?.audio ?? null;

    if (language === null) return null;

    return started.file.probe.audio.find((track) => track.language === language)?.index ?? null;
  }

  #pickCarriedSubtitle(stream: NegotiateResponse): void {
    const carried = this.#carried;

    if (carried === null) return;
    this.#carried = null;

    const track = stream.subtitles.find(
      (candidate) =>
        candidate.kind === "text" &&
        candidate.url !== undefined &&
        carried.subtitle !== null &&
        candidate.language === carried.subtitle,
    );

    if (this.#delay !== null && this.#delay.fileId !== this.#fileId) this.#delay = null;
    this.#update({ subtitleId: track?.id ?? null });
  }

  /**
   * Plays version `fileId` from where playback is, in a new start: the media server streams one
   * file per start. Track choices name the old file's streams, so the audio and text subtitle
   * languages carry over instead, and a burned-in subtitle is dropped. Another pick before the new
   * stream loads starts from the same place with the same languages; a version that cannot start
   * gives way to the one that played. At the resume prompt the new version's start asks again.
   *
   * @returns Whether a switch started; false before a start exists, or for the version already
   *   chosen.
   */
  selectVersion(fileId: MediaFileId): boolean {
    const { started, stream, audioStreamIndex, subtitleId, phase } = this.#snapshot;
    const current = this.#current;

    if (started === null || current === null || this.#disposed || fileId === this.#fileId) {
      return false;
    }

    if (PlaybackPhase.$is("Choosing")(phase) || PlaybackPhase.$is("Starting")(phase)) {
      this.#fileId = fileId;
      void this.start();

      return true;
    }

    const pending = this.#switching;

    const firstStream =
      PlaybackPhase.$is("Preparing")(phase) && this.#attached === null && this.#loading === null
        ? phase.startAtMs
        : null;

    const positionMs = pending?.positionMs ?? firstStream ?? this.positionMs();
    const play = pending?.play ?? (firstStream === null ? this.playing() : true);

    this.#carried ??= {
      audio:
        started.file.probe.audio.find((track) => track.index === audioStreamIndex)?.language ??
        null,
      subtitle:
        stream?.subtitles.find((track) => track.id === subtitleId && track.kind === "text")
          ?.language ?? null,
    };
    this.#switching = { positionMs, play, from: pending?.from ?? current.start.file.id };
    this.#fileId = fileId;
    this.#burnIn = null;
    this.#loadedBurnIn = null;
    this.#choicesVersion += 1;
    this.#recoveries = 0;
    this.#update({
      audioStreamIndex: null,
      subtitleId: null,
      phase: PlaybackPhase.Preparing({ startAtMs: positionMs, progress: 0.2 }),
    });
    this.#diagnostics?.recorder.intent();
    void this.#restart(positionMs, play);

    return true;
  }

  /**
   * Negotiates a new stream of the current start at `positionMs` with the same ticket. A ticket
   * the server refuses as expired leads to a new start (`afterPlaybackFailure`).
   */
  async #renegotiate(
    playback: Playback.Playback,
    positionMs: number,
    audioStreamIndex: number | null,
    options: {
      /** Play the new stream, or not; by default as the old one was. */
      readonly play?: boolean;
      /**
       * For a negotiation the viewer asked for (another quality or picture subtitle): undoes the
       * choice when the service cannot honour it, and the current stream plays on.
       */
      readonly revert?: () => void;
    } = {},
  ): Promise<void> {
    const wasPlaying = this.playing();
    const ticket = ++this.#negotiation;
    const version = this.#choicesVersion;
    const chosen = this.#chosen();

    const negotiated = await runSdk(
      Playback.negotiate(
        playback.started,
        this.#capabilities,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(audioStreamIndex),
        this.streamChoices(),
      ),
    );

    if (
      this.#disposed ||
      ticket !== this.#negotiation ||
      this.#playback?.started !== playback.started
    ) {
      return;
    }

    if (negotiated === null) return this.#stop(STOPPED);

    if (Result.isFailure(negotiated) && isUnhonoured(negotiated.failure)) {
      if (options.revert !== undefined) {
        options.revert();

        return;
      }

      if (this.#dropChoices()) {
        return this.#renegotiate(playback, positionMs, audioStreamIndex, {
          play: options.play ?? wasPlaying,
        });
      }
    }

    const resume = options.play ?? (wasPlaying || !isPlaying(this.#snapshot.phase));

    if (Result.isFailure(negotiated)) {
      return this.#follow(
        afterPlaybackFailure(negotiated.failure),
        positionMs,
        negotiated.failure.message,
        resume,
      );
    }

    await this.#load({ started: playback.started, stream: negotiated.success }, resume, chosen);

    this.#catchUpOnChoices(version, ticket);
  }

  /** Switches to another audio track by renegotiating with it. */
  selectAudio(streamIndex: number): void {
    const playback = this.#playback;

    if (playback === null || streamIndex === this.#snapshot.audioStreamIndex) return;

    this.#update({ audioStreamIndex: streamIndex });
    void this.#renegotiate(playback, this.positionMs(), streamIndex);
  }

  /** The quality cap and burned-in subtitle every negotiation asks for. */
  streamChoices(): Playback.StreamChoices {
    return {
      quality: Option.fromNullishOr(qualityCap(this.#snapshot.quality)),
      burnInSubtitle: Option.fromNullishOr(this.#burnIn),
    };
  }

  #chosen(): StreamChoice {
    return { quality: this.#snapshot.quality, burnIn: this.#burnIn };
  }

  #bitmapTrack(id: string | null): string | null {
    const track = this.#snapshot.stream?.subtitles.find((candidate) => candidate.id === id);

    return track?.kind === "bitmap" ? track.id : null;
  }

  #dropChoices(): boolean {
    if (this.#snapshot.quality === "auto" && this.#burnIn === null) return false;

    const shown = this.#snapshot.subtitleId;

    this.#burnIn = null;
    this.#choicesVersion += 1;
    this.#update({ quality: "auto", subtitleId: this.#bitmapTrack(shown) === null ? shown : null });

    return true;
  }

  /**
   * Shows the subtitle track `id`, or none. A picture subtitle needs a stream with it burned in,
   * and leaving one for a text track or none goes back to a stream without it: both renegotiate
   * at the current position. Text tracks switch in place.
   */
  selectSubtitle(id: string | null): void {
    const burnIn = this.#bitmapTrack(id);
    const previous = this.#snapshot.subtitleId;

    if (id !== null && burnIn === null && id !== this.#delay?.trackId) this.#delay = null;
    this.#update({ subtitleId: id });

    if (burnIn === this.#burnIn) return;

    this.#changeChoices(() => {
      this.#burnIn = burnIn;
    }, previous);
  }

  /**
   * Shows the text subtitles `delayMs` later than their file says (earlier when negative), held
   * to `SUBTITLE_DELAY`'s range, until another track or version is chosen. Only the cues in this
   * element move: nothing reaches the media service.
   *
   * @returns Whether the delay was set; false without a start or a text subtitle chosen.
   */
  setSubtitleDelay(delayMs: number): boolean {
    const { started, subtitleId } = this.#snapshot;

    if (started === null || subtitleId === null || this.#bitmapTrack(subtitleId) !== null) {
      return false;
    }

    this.#delay = { fileId: started.file.id, trackId: subtitleId, ms: clampSubtitleDelay(delayMs) };
    this.#update({});

    return true;
  }

  /** Plays at `quality` from here on, renegotiating when it changes. */
  selectQuality(quality: QualityChoice): void {
    if (quality === this.#snapshot.quality) return;

    this.#changeChoices(() => this.#update({ quality }), this.#snapshot.subtitleId);
  }

  #changeChoices(apply: () => void, subtitleBefore: string | null): void {
    apply();
    this.#choicesVersion += 1;

    const playback = this.#playback;

    if (playback === null) return;

    void this.#renegotiate(playback, this.positionMs(), this.#snapshot.audioStreamIndex, {
      revert: () => this.#revertToLoaded(subtitleBefore),
    });
  }

  #revertToLoaded(subtitleBefore: string | null): void {
    const burnIn = this.#loadedBurnIn;
    const shown = this.#snapshot.subtitleId;
    const before = this.#bitmapTrack(subtitleBefore) === null ? subtitleBefore : null;

    this.#burnIn = burnIn;
    this.#choicesVersion += 1;
    this.#update({
      quality: this.#snapshot.loadedQuality ?? this.#snapshot.quality,
      subtitleId: this.#bitmapTrack(shown) === burnIn ? shown : (burnIn ?? before),
    });
  }

  /**
   * Tries again from where playback stopped, with the current start's ticket; one the server
   * refuses as expired leads to a new start.
   */
  retry(): void {
    this.#recoveries = 0;

    const play = this.#current;

    if (play === null) {
      void this.start();

      return;
    }

    this.#diagnostics?.recorder.intent();
    void this.#negotiate(play, this.player.positionMs());
  }

  readonly #onFirstFrame = (): void => {
    this.#diagnostics?.recorder.reached("firstFrame");

    if (isPlaying(this.#snapshot.phase)) return;

    performance.mark(PLAYBACK_MARKS.firstFrame, { detail: { mode: this.#snapshot.stream?.mode } });
    this.#update({ phase: PlaybackPhase.Playing() });
  };

  readonly #onPlaying = (): void => {
    this.#recoveries = 0;
    this.#onSettled();
    this.#onFirstFrame();
  };

  readonly #onSettled = (): void => {
    if (this.#attached !== null) this.#loading = null;
  };

  #startReporting(play: StartedPlay): void {
    if (this.#reporting !== null) return;

    this.#reporting = reportProgress(this.#services.play.report, play.start, this.player);
  }

  #startDiagnostics(): void {
    if (this.#disposed || this.#diagnostics !== null) return;

    const scope = Scope.makeUnsafe();

    const started = Effect.runSyncExit(
      Scope.provide(scope)(
        PlayerDiagnostics.reportDiagnostics(this.player, {
          platform: "web",
          playback: () => Option.fromNullishOr(this.#playback),
          bufferedAheadSeconds: () => bufferedAheadSeconds(this.#element),
          frames: () => frameCounts(this.#element),
          send: this.#services.sendDiagnostics,
        }),
      ),
    );

    if (Exit.isSuccess(started)) {
      const recorder = started.value;

      this.#diagnostics = {
        recorder,
        scope,
        stopDrift: sampleDrift(this.#element, recorder.record),
      };
    }
  }

  #closeDiagnostics(): void {
    const diagnostics = this.#diagnostics;

    this.#diagnostics = null;

    if (diagnostics !== null) {
      diagnostics.stopDrift();
      diagnostics.recorder.close();
      void Effect.runPromiseExit(Scope.close(diagnostics.scope, Exit.void));
    }
  }

  async #closeReporting(): Promise<void> {
    const stop = this.#reporting;

    this.#reporting = null;

    if (stop !== null) await stop();
  }

  /** Stops playback, reports where it stopped, stops the stream, and frees the element. */
  dispose(): void {
    if (this.#disposed) return;

    void this.#closeReporting();
    this.#closeDiagnostics();

    const current = this.#playback;

    // A navigation that unmounts the player may unload the page next, so the stop goes out now.
    if (current !== null) Playback.stopNow(current);

    this.#disposed = true;
    this.#element.removeEventListener("playing", this.#onPlaying);
    this.#element.removeEventListener("loadeddata", this.#onFirstFrame);
    this.#element.removeEventListener("pause", this.#onSettled);
    this.#element.removeEventListener("seeking", this.#onSettled);
    this.#element.ownerDocument.defaultView?.removeEventListener("pagehide", this.#onPageHide);
    this.player.dispose();
    this.#retimer.dispose();
    this.#detach();
    this.#listeners.clear();
  }
}
