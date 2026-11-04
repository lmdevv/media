import { artworkUrl } from "@media/contracts/artwork";
import { castCapabilities } from "@media/contracts/cast";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { Playback } from "@media/sdk/effect";
import { Option, Predicate, Result } from "effect";

import type { PlaybackController } from "@/playback/playback-controller";
import { RENEW_BEFORE_MS, inGeneration, runSdk } from "@/playback/sdk-calls";
import type { Runtime } from "@/playback/sdk-calls";
import { heldPlayer } from "@/playback/switchable-player";

import type { CastLoadRequest, CastSession } from "./cast-api";
import { CastPlayer } from "./cast-player";
import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem, CastLoadPlan } from "./cast-profile";
import type { CastSdk } from "./cast-sdk";

/**
 * What a Chromecast is asked to play. The web sender SDK names a device but reports neither its
 * model nor its codecs (`chrome.cast.Receiver`), so every device gets the profile all of them
 * play; 4K, HEVC, and HDR wait for senders that know the model (the native apps).
 */
const CAST_CAPABILITIES = castCapabilities(undefined);

/** What a viewer reads when casting cannot start. */
export type CastFailure =
  /** The media service has no stream this device plays. */
  | "unsupported"
  /** The receiver refused or could not load the stream. */
  | "load-failed"
  /** The page had nothing playing to cast. */
  | "not-ready";

const RETRY_MS = 30_000;

const IN_PLACE_AHEAD_MS = 30_000;

const PASSING_FAILURES = [
  "TransportError",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
  "FileResolverUnavailable",
  "SegmentNotReady",
  "RateLimited",
  "Unavailable",
] as const;

const mayPass = (failure: { readonly _tag: string }): boolean =>
  PASSING_FAILURES.some((tag) => Predicate.isTagged(failure, tag));

const LOST = {
  refused: "The TV couldn't play this. Continuing here.",
  ended: "This can no longer play on the TV. Continuing here.",
  failed: "The TV stopped playing this. Continuing here.",
} as const;

/** The poster or still the TV shows for `started`'s item, as an absolute URL. */
export const castImage = (started: StartedPlayback, key: string | null): string | null =>
  key === null || key === "" ? null : artworkUrl(started.mediaBaseUrl, key, 500);

const loadRequest = (sdk: CastSdk, plan: CastLoadPlan, autoplay: boolean): CastLoadRequest => {
  const { media, Image } = sdk.cast;
  const info = new media.MediaInfo(plan.contentUrl, plan.contentType);
  const episode = plan.item.episode;

  const metadata =
    episode === null ? new media.MovieMediaMetadata() : new media.TvShowMediaMetadata();

  metadata.title = plan.item.title;
  metadata.images = plan.item.imageUrl === null ? [] : [new Image(plan.item.imageUrl)];

  if (episode !== null) {
    metadata.seriesTitle = episode.seriesTitle;
    metadata.season = episode.season;
    metadata.episode = episode.episode;
  }

  info.contentUrl = plan.contentUrl;
  info.streamType = "BUFFERED";
  info.duration = plan.durationSeconds;
  info.metadata = metadata;

  info.tracks = plan.tracks.map((track) => {
    const text = new media.Track(track.trackId, "TEXT");

    text.trackContentId = track.url;
    text.trackContentType = "text/vtt";
    text.subtype = "SUBTITLES";
    text.name = track.name;
    text.language = track.language;

    return text;
  });

  if (plan.hls) {
    info.hlsSegmentFormat = "fmp4";
    info.hlsVideoSegmentFormat = "fmp4";
  }

  const request = new media.LoadRequest(info);

  request.autoplay = autoplay;
  request.currentTime = plan.startSeconds;
  request.activeTrackIds = [...plan.activeTrackIds];

  return request;
};

const choicesKey = (controller: PlaybackController): string => {
  const { burnInSubtitle } = controller.streamChoices();

  return `${controller.getSnapshot().quality} ${Option.getOrElse(burnInSubtitle, () => "")}`;
};

/** A cast of one playback session. Create it with `start`, end it with `stop`. */
export class CastPlayback {
  readonly player: CastPlayer;
  readonly #runtime: Runtime;
  readonly #sdk: CastSdk;
  readonly #session: CastSession;
  readonly #controller: PlaybackController;
  readonly #item: CastItem;
  readonly #onLost: (message: string) => void;
  #playback: Playback.Playback;
  #generationStartMs: number;
  #plan: CastLoadPlan;
  #subtitleId: string | null;
  #audioStreamIndex: number | null;
  #choices: string;
  #changes: Promise<void> = Promise.resolve();
  #changesPending = 0;
  #reloadTicket = 0;
  #renewTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: () => void = () => undefined;
  #stopped = false;

  private constructor(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    playing: { readonly playback: Playback.Playback; readonly plan: CastLoadPlan },
    onLost: (message: string) => void,
  ) {
    this.#runtime = runtime;
    this.#sdk = sdk;
    this.#session = session;
    this.#controller = controller;
    this.#item = item;
    this.#playback = playing.playback;
    this.#plan = playing.plan;
    this.#generationStartMs = playing.plan.startSeconds * 1000;
    this.#onLost = onLost;

    const snapshot = controller.getSnapshot();

    this.#subtitleId = snapshot.subtitleId;
    this.#audioStreamIndex = snapshot.audioStreamIndex;
    this.#choices = choicesKey(controller);
    this.player = new CastPlayer(
      sdk.framework,
      (positionMs, signal) => this.#moveTo(positionMs, signal),
      () => session.getMediaSession()?.idleReason ?? null,
      () => {
        if (!this.#stopped) this.#onLost(LOST.failed);
      },
    );
  }

  /** The device's name, as the cast menu shows it. */
  get deviceName(): string {
    return this.#session.getCastDevice().friendlyName;
  }

  /**
   * Negotiates a stream for the device in `session` at the page's position, loads it there, and
   * hands the session to it. The media service keeps one stream per playback session, so the
   * receiver's stream replaces the page's, and the page waits (`park`) until the cast ends.
   * `onLost` hears when the cast can no longer go on, so the caller ends it.
   */
  static async start(
    runtime: Runtime,
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    onLost: (message: string) => void,
  ): Promise<Result.Result<CastPlayback, CastFailure>> {
    const snapshot = controller.getSnapshot();
    const { started, stream } = snapshot;

    if (started === null || stream === null) return Result.fail("not-ready");

    const positionMs = controller.positionMs();
    const playing = controller.playing();

    controller.output.switchTo(heldPlayer(positionMs, !playing));
    controller.park();

    const resumeOnPage = (failure: CastFailure): Result.Result<CastPlayback, CastFailure> => {
      controller.output.switchTo(controller.player);
      controller.unpark(positionMs, playing);

      return Result.fail(failure);
    };

    const negotiated = await runSdk(
      runtime,
      Playback.renegotiate(
        { started, stream },
        CAST_CAPABILITIES,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(snapshot.audioStreamIndex),
        controller.streamChoices(),
      ),
    );

    if (negotiated === null || Result.isFailure(negotiated)) return resumeOnPage("unsupported");

    const playback = negotiated.success;
    const plan = castLoadPlan(playback.stream, item, snapshot.subtitleId, positionMs / 1000);

    const failure = await session
      .loadMedia(loadRequest(sdk, plan, playing))
      .catch(() => "load-failed");

    if (failure !== undefined) {
      void runSdk(runtime, Playback.stop(playback));

      return resumeOnPage("load-failed");
    }

    const cast = new CastPlayback(
      runtime,
      sdk,
      session,
      controller,
      item,
      { playback, plan },
      onLost,
    );

    controller.output.switchTo(cast.player);
    cast.#begin();

    return Result.succeed(cast);
  }

  #begin(): void {
    this.#unsubscribe = this.#controller.subscribe(this.#onSnapshot);
    this.#scheduleRenewal();
  }

  readonly #onSnapshot = (): void => {
    const { subtitleId, audioStreamIndex } = this.#controller.getSnapshot();

    if (this.#stopped) return;

    if (subtitleId !== this.#subtitleId) {
      this.#subtitleId = subtitleId;
      this.#showSubtitle(subtitleId);
    }

    const choices = choicesKey(this.#controller);

    if (audioStreamIndex !== this.#audioStreamIndex || choices !== this.#choices) {
      this.#audioStreamIndex = audioStreamIndex;
      this.#choices = choices;
      void this.#reload();
    }
  };

  #showSubtitle(subtitleId: string | null): void {
    const media = this.#session.getMediaSession();
    const ids = castTrackIds(this.#plan.tracks, subtitleId);

    media?.editTracksInfo(
      new this.#sdk.cast.media.EditTracksInfoRequest([...ids]),
      () => undefined,
      () => undefined,
    );
  }

  #scheduleRenewal(): void {
    clearTimeout(this.#renewTimer);

    const due = Math.max(0, this.#playback.stream.expiresAt - RENEW_BEFORE_MS - Date.now());

    this.#renewTimer = setTimeout(() => {
      if (!this.#stopped && !this.player.getState().ended) {
        void this.#reload();
      }
    }, due);
  }

  #serially(change: () => Promise<void>): Promise<void> {
    this.#changesPending += 1;

    const run = this.#changes.then(change).finally(() => {
      this.#changesPending -= 1;
    });

    this.#changes = run.catch(() => undefined);

    return run;
  }

  #reload(): Promise<void> {
    const ticket = ++this.#reloadTicket;

    return this.#serially(async () => {
      if (!this.#stopped && ticket === this.#reloadTicket) {
        await this.#renegotiate(this.player.positionMs());
      }
    });
  }

  async #renegotiate(positionMs: number): Promise<void> {
    const previous = this.#playback;

    const renewed = await runSdk(
      this.#runtime,
      Playback.renegotiate(
        previous,
        CAST_CAPABILITIES,
        Milliseconds.make(Math.max(0, positionMs)),
        Option.fromNullishOr(this.#audioStreamIndex),
        this.#controller.streamChoices(),
      ),
    );

    if (this.#stopped) {
      if (renewed !== null && Result.isSuccess(renewed)) {
        void runSdk(this.#runtime, Playback.stop(renewed.success));
      }

      return;
    }

    if (renewed === null || Result.isFailure(renewed)) {
      if (renewed !== null && !mayPass(renewed.failure)) {
        this.#onLost(LOST.ended);

        return;
      }

      clearTimeout(this.#renewTimer);
      this.#renewTimer = setTimeout(() => {
        if (!this.#stopped) void this.#reload();
      }, RETRY_MS);

      return;
    }

    this.#playback = renewed.success;
    this.#scheduleRenewal();
    await this.#load(positionMs);
  }

  async #load(positionMs: number): Promise<void> {
    this.#plan = castLoadPlan(
      this.#playback.stream,
      this.#item,
      this.#subtitleId,
      positionMs / 1000,
    );
    this.#generationStartMs = positionMs;

    const failure = await this.#session
      .loadMedia(loadRequest(this.#sdk, this.#plan, !this.player.isPaused()))
      .catch(() => "load-failed");

    if (failure !== undefined && !this.#stopped) this.#onLost(LOST.refused);
  }

  #inPlace(positionMs: number): boolean {
    return (
      this.#playback.stream.streamId === undefined ||
      (positionMs >= this.#generationStartMs &&
        positionMs <= this.player.receiverPositionMs() + IN_PLACE_AHEAD_MS)
    );
  }

  #moveTo(positionMs: number, signal: AbortSignal): Promise<void> {
    if (this.#changesPending === 0 && this.#inPlace(positionMs)) {
      this.player.seekInPlace(positionMs);

      return Promise.resolve();
    }

    return this.#serially(async () => {
      if (signal.aborted) return;

      if (this.#inPlace(positionMs)) {
        this.player.seekInPlace(positionMs);

        return;
      }

      const playback = this.#playback;

      const moved = await runSdk(
        this.#runtime,
        Playback.seekStream(playback, Milliseconds.make(positionMs)),
      );

      if (this.#stopped) return;

      if (moved === null || Result.isFailure(moved)) {
        await this.#renegotiate(positionMs);

        return;
      }

      const next = Option.getOrUndefined(moved.success);

      if (next === undefined || next.generation === playback.stream.generation) {
        this.player.seekInPlace(positionMs);

        return;
      }

      this.#playback = inGeneration(playback, next);
      await this.#load(positionMs);
    });
  }

  /**
   * Ends the cast on the page's side and stops the receiver's stream. With `resume` (the device
   * disconnected), the page takes the session back where the TV was. Without it (the player is
   * closing), the session's output stays on the receiver's last position, so the exit report
   * saves where the TV stopped. The cast session itself is the caller's to end.
   */
  stop(resume: boolean): void {
    if (this.#stopped) return;
    this.#stopped = true;

    const positionMs = this.player.positionMs();
    const wasPlaying = !this.player.isPaused();

    clearTimeout(this.#renewTimer);
    this.#unsubscribe();
    this.player.dispose();
    void runSdk(this.#runtime, Playback.stop(this.#playback));

    if (!resume) return;
    this.#controller.output.switchTo(this.#controller.player);
    this.#controller.unpark(positionMs, wasPlaying);
  }
}
