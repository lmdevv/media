/**
 * One start continued on a Chromecast: the imperative shell of casting.
 *
 * Casting keeps the page's start (and its ticket): the receiver gets its own stream, negotiated
 * with the Chromecast's profile at the position the page reached, the page's element lets go of
 * its own (`handOff`), and the controller's output switches to the receiver, so progress keeps
 * reaching the core and a group session follows the TV. The receiver's URLs carry a receiver
 * credential the media server lends for the start, never its ticket (ADR 0011), and that
 * credential lasts as long as the stream's admission while the session is live (D46), so nothing
 * renews it. Subtitles, audio, and quality chosen on the page reach the receiver. A seek outside
 * what an HLS stream has produced moves the stream first (`seekStream`), as the page's own player
 * does, because the receiver would otherwise ask for segments of a generation that is gone; a seek
 * within it happens on the receiver at once. A stream whose ticket expired, or whose session the
 * server no longer knows, takes a new start (`startHandedOff`) and loads again where the TV was.
 * A receiver that refuses a stream, or a start that can no longer play, ends the cast through
 * `onLost`. Another sender's media taking the receiver, such as a second tab's movie or a song cast
 * from `/music`, ends the cast on the page's side at once, paused where the TV was, and `onTaken`
 * hears it so the page leaves the session with that media playing on. Ending the cast stops the
 * receiver's stream and continues on the page where the TV was. A start whose ticket expired before
 * the cast takes a new start first, as one expiring mid-cast does.
 *
 * Every load on the receiver has a number, and what the receiver says applies only to the newest
 * load (ADR 0018): an answer to an older `loadMedia`, and the end or failure of the media an older
 * load put there, change nothing.
 */
import { castCapabilities } from "@media/contracts/cast";
import { Milliseconds } from "@media/contracts/units";
import { Playback } from "@media/sdk/effect";
import type { PlaybackCallError } from "@media/sdk/effect";
import { Option, Predicate, Redacted, Result } from "effect";

import type { PlaybackController } from "@/playback/playback-controller";
import { inGeneration, runSdk } from "@/playback/sdk-calls";
import { heldPlayer } from "@/playback/switchable-player";

import type { CastLoadRequest, CastSession } from "./cast-api";
import { CastPlayer } from "./cast-player";
import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem, CastLoadPlan } from "./cast-profile";
import type { CastSdk } from "./cast-sdk";

/**
 * What a Chromecast is asked to play. The web sender SDK names a device but reports neither its
 * model nor its codecs (`chrome.cast.Receiver`), so every device gets the profile all of them
 * play; 4K, HEVC, and HDR wait for senders that know the model.
 */
const CAST_CAPABILITIES = castCapabilities(undefined);

/** What a viewer reads when casting cannot start. */
export type CastFailure =
  /** The media server has no stream this device plays. */
  | "unsupported"
  /** The receiver refused or could not load the stream. */
  | "load-failed"
  /** The page had nothing playing to cast. */
  | "not-ready";

/** How long a reload waits before it tries again while the media server cannot answer. */
const RETRY_MS = 30_000;

/**
 * How far past the receiver's position a seek stays on the receiver: the media server produces
 * well ahead of what a player asked for, so this part of a generation is there already.
 */
const IN_PLACE_AHEAD_MS = 30_000;

/** Failures that may pass: the media server unreachable or busy. */
const PASSING_FAILURES = [
  "TransportError",
  "TranscodeCapacityReached",
  "InsufficientTranscodeSpace",
  "FileResolverUnavailable",
  "SegmentNotReady",
] as const;

const mayPass = (failure: { readonly _tag: string }): boolean =>
  PASSING_FAILURES.some((tag) => Predicate.isTagged(failure, tag));

/** Failures a new start answers: the ticket expired, or the server no longer has the session. */
const needsNewStart = (failure: PlaybackCallError): boolean =>
  Predicate.isTagged(failure, "PlaybackSessionEnded") ||
  (Predicate.isTagged(failure, "PlaybackTokenInvalid") && failure.reason === "expired");

/** Why a cast ended by itself, as the viewer reads it. */
const LOST = {
  refused: "The TV couldn't play this. Continuing here.",
  ended: "This can no longer play on the TV. Continuing here.",
  failed: "The TV stopped playing this. Continuing here.",
  taken: "Something else is playing on the TV now. Continuing here.",
} as const;

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

/** The page's quality and burned-in subtitle as one comparable value. */
const choicesKey = (controller: PlaybackController): string => {
  const { burnInSubtitle } = controller.streamChoices();

  return `${controller.getSnapshot().quality} ${Option.getOrElse(burnInSubtitle, () => "")}`;
};

/** A stream for the receiver and the credential its URLs carry. */
interface ReceiverStream {
  readonly playback: Playback.Playback;
  readonly credential: string;
}

/**
 * Negotiates a stream of `started` for the receiver at `positionMs` and has the media server lend
 * the credential its URLs carry. Answers the first failure, or null when a call failed
 * unexpectedly.
 */
const receiverStream = async (
  started: Playback.Playback["started"],
  controller: PlaybackController,
  positionMs: number,
  audioStreamIndex: number | null,
): Promise<Result.Result<ReceiverStream, PlaybackCallError> | null> => {
  const negotiated = await runSdk(
    Playback.negotiate(
      started,
      CAST_CAPABILITIES,
      Milliseconds.make(Math.max(0, positionMs)),
      Option.fromNullishOr(audioStreamIndex),
      controller.streamChoices(),
    ),
  );

  if (negotiated === null) return null;

  if (Result.isFailure(negotiated)) return Result.fail(negotiated.failure);

  const lent = await runSdk(Playback.lendToReceiver(started));

  if (lent === null) return null;

  if (Result.isFailure(lent)) return Result.fail(lent.failure);

  return Result.succeed({
    playback: { started, stream: negotiated.success },
    credential: Redacted.value(lent.success),
  });
};

/** A cast of one start. Create it with `start`, end it with `stop`. */
export class CastPlayback {
  readonly player: CastPlayer;
  readonly #sdk: CastSdk;
  readonly #session: CastSession;
  readonly #controller: PlaybackController;
  readonly #item: CastItem;
  readonly #onLost: (message: string) => void;
  readonly #onTaken: (message: string) => void;
  #receiver: ReceiverStream;
  /** Where the receiver's current HLS generation starts. */
  #generationStartMs: number;
  #plan: CastLoadPlan;
  #subtitleId: string | null;
  #audioStreamIndex: number | null;
  /** The page's quality and burned-in subtitle the receiver's stream was asked with. */
  #choices: string;
  /**
   * The stream changes asked for (reloads, and seeks the media server moves), run one at a time:
   * the media server keeps only the newest stream of a start, so two at once could leave the
   * receiver on one already replaced.
   */
  #changes: Promise<void> = Promise.resolve();
  #changesPending = 0;
  /** Counts the reloads asked for; one that a later reload will redo skips itself. */
  #reloadTicket = 0;
  /** The number of the newest load on the receiver; what an older one says changes nothing. */
  #load = 0;
  /** A load on the receiver has not answered yet; the media before it says nothing meanwhile. */
  #loading = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: () => void = () => undefined;
  #stopped = false;

  private constructor(
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    playing: { readonly receiver: ReceiverStream; readonly plan: CastLoadPlan },
    onLost: (message: string) => void,
    onTaken: (message: string) => void,
  ) {
    this.#sdk = sdk;
    this.#session = session;
    this.#controller = controller;
    this.#item = item;
    this.#receiver = playing.receiver;
    this.#plan = playing.plan;
    this.#generationStartMs = playing.plan.startSeconds * 1000;
    this.#onLost = onLost;
    this.#onTaken = onTaken;

    const snapshot = controller.getSnapshot();

    this.#subtitleId = snapshot.subtitleId;
    this.#audioStreamIndex = snapshot.audioStreamIndex;
    this.#choices = choicesKey(controller);
    this.player = new CastPlayer(
      sdk.framework,
      playing.plan.contentUrl,
      (positionMs, signal) => this.#moveTo(positionMs, signal),
      // The media an older load left on the receiver ends or fails as the newest replaces it.
      () => (this.#loading ? null : (session.getMediaSession()?.idleReason ?? null)),
      () => {
        if (!this.#stopped && !this.#loading) this.#onLost(LOST.failed);
      },
      () => {
        if (this.#stopped) return;
        this.#end(true, false);
        this.#onTaken(LOST.taken);
      },
    );
  }

  /** The device's name, as the cast menu shows it. */
  get deviceName(): string {
    return this.#session.getCastDevice().friendlyName;
  }

  /**
   * Negotiates a stream for the device in `session` at the page's position, loads it there with a
   * receiver credential, and hands the start to it. The media server keeps one stream per start,
   * so the receiver's stream replaces the page's, and the page waits (`handOff`) until the cast ends.
   * `onLost` hears when the cast can no longer go on, so the caller ends it; `onTaken` hears that
   * another sender's media took the receiver, after the page took the start back paused.
   */
  static async start(
    sdk: CastSdk,
    session: CastSession,
    controller: PlaybackController,
    item: CastItem,
    onLost: (message: string) => void,
    onTaken: (message: string) => void,
  ): Promise<Result.Result<CastPlayback, CastFailure>> {
    const snapshot = controller.getSnapshot();
    const { started, stream } = snapshot;

    if (started === null || stream === null) return Result.fail("not-ready");

    // The controller's view, not the element's: a stream still attaching reads 0 and paused.
    const positionMs = controller.positionMs();
    const playing = controller.playing();

    // The receiver's stream will replace the page's, so the page lets go first.
    controller.output.switchTo(heldPlayer(positionMs, !playing));
    controller.handOff();

    const resumeOnPage = (failure: CastFailure): Result.Result<CastPlayback, CastFailure> => {
      controller.output.switchTo(controller.player);
      controller.takeBack(positionMs, playing);

      return Result.fail(failure);
    };

    const first = await receiverStream(started, controller, positionMs, snapshot.audioStreamIndex);

    // A start that sat paused past its ticket's expiry, or whose session the server lost, takes a
    // new start, as one that expires mid-cast does.
    const renewed =
      first !== null && Result.isFailure(first) && needsNewStart(first.failure)
        ? await controller.startHandedOff()
        : null;

    const receiver =
      renewed === null
        ? first
        : await receiverStream(renewed, controller, positionMs, snapshot.audioStreamIndex);

    if (receiver === null || Result.isFailure(receiver)) return resumeOnPage("unsupported");

    const plan = castLoadPlan(
      receiver.success.playback.stream,
      item,
      snapshot.subtitleId,
      positionMs / 1000,
      receiver.success.credential,
    );

    const failure = await session
      .loadMedia(loadRequest(sdk, plan, playing))
      .catch(() => "load-failed");

    if (failure !== undefined) {
      void runSdk(Playback.stop(receiver.success.playback));

      return resumeOnPage("load-failed");
    }

    const cast = new CastPlayback(
      sdk,
      session,
      controller,
      item,
      { receiver: receiver.success, plan },
      onLost,
      onTaken,
    );

    controller.output.switchTo(cast.player);
    cast.#unsubscribe = controller.subscribe(cast.#onSnapshot);

    return Result.succeed(cast);
  }

  /**
   * Follows the page's subtitle, audio, and quality choices; a picture subtitle or a quality needs
   * a new stream, as audio does.
   */
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

  /** Whether the cast ended: a method, so TypeScript does not keep a check before an await. */
  #ended(): boolean {
    return this.#stopped;
  }

  /** Runs `change` after every stream change asked for before it. */
  #serially(change: () => Promise<void>): Promise<void> {
    this.#changesPending += 1;

    const run = this.#changes.then(change).finally(() => {
      this.#changesPending -= 1;
    });

    this.#changes = run.catch(() => undefined);

    return run;
  }

  /**
   * Negotiates the receiver's stream again where it is (another audio track, quality, or picture
   * subtitle) and loads it, once the stream changes before it ran.
   */
  #reload(): Promise<void> {
    const ticket = ++this.#reloadTicket;

    return this.#serially(async () => {
      if (!this.#stopped && ticket === this.#reloadTicket) {
        await this.#renegotiate(this.player.positionMs());
      }
    });
  }

  /**
   * Negotiates the receiver's stream again at `positionMs` and loads it, keeping play or pause.
   * A ticket that expired, or a session the server lost, takes a new start first. While the media
   * server cannot answer it tries again every half minute; a start that can no longer play ends
   * the cast. Runs as a stream change.
   */
  async #renegotiate(positionMs: number, newStart = false): Promise<void> {
    const started = newStart
      ? await this.#controller.startHandedOff()
      : this.#receiver.playback.started;

    if (this.#stopped) return;

    if (started === null) {
      this.#onLost(LOST.ended);

      return;
    }

    const renewed = await receiverStream(
      started,
      this.#controller,
      positionMs,
      this.#audioStreamIndex,
    );

    if (this.#ended()) {
      if (renewed !== null && Result.isSuccess(renewed)) {
        void runSdk(Playback.stop(renewed.success.playback));
      }

      return;
    }

    if (renewed !== null && Result.isFailure(renewed) && !newStart) {
      if (needsNewStart(renewed.failure)) return this.#renegotiate(positionMs, true);
    }

    if (renewed === null || Result.isFailure(renewed)) {
      if (renewed !== null && !mayPass(renewed.failure)) {
        this.#onLost(LOST.ended);

        return;
      }

      clearTimeout(this.#retryTimer);
      this.#retryTimer = setTimeout(() => {
        if (!this.#stopped) void this.#reload();
      }, RETRY_MS);

      return;
    }

    this.#receiver = renewed.success;
    await this.#loadAt(positionMs);
  }

  /**
   * Loads the current stream on the receiver at `positionMs`, keeping play or pause. A receiver
   * that refuses it ends the cast, unless a newer load replaced it meanwhile.
   */
  async #loadAt(positionMs: number): Promise<void> {
    const load = ++this.#load;

    this.#plan = castLoadPlan(
      this.#receiver.playback.stream,
      this.#item,
      this.#subtitleId,
      positionMs / 1000,
      this.#receiver.credential,
    );
    this.#generationStartMs = positionMs;
    this.#loading = true;
    this.player.expect(this.#plan.contentUrl);

    const failure = await this.#session
      .loadMedia(loadRequest(this.#sdk, this.#plan, !this.player.isPaused()))
      .catch(() => "load-failed");

    if (load !== this.#load) return;
    this.#loading = false;

    if (failure !== undefined && !this.#stopped) this.#onLost(LOST.refused);
  }

  /**
   * Whether the receiver can seek to `positionMs` itself: a direct file, or a produced position
   * (from the generation's start to a little past where the TV is).
   */
  #inPlace(positionMs: number): boolean {
    return (
      this.#receiver.playback.stream.streamId === undefined ||
      (positionMs >= this.#generationStartMs &&
        positionMs <= this.player.receiverPositionMs() + IN_PLACE_AHEAD_MS)
    );
  }

  /**
   * Moves the receiver to `positionMs`: on the receiver itself where it can, else through the media
   * server, which starts a new generation there for the receiver to load. A move waits for the
   * stream changes asked for before it, and one a newer seek replaced does not start.
   */
  #moveTo(positionMs: number, signal: AbortSignal): Promise<void> {
    if (this.#changesPending === 0 && this.#inPlace(positionMs)) {
      this.player.seekInPlace(positionMs);

      return Promise.resolve();
    }

    return this.#serially(async () => {
      // A newer seek replaced this one, or the cast ended (which aborts every move).
      if (signal.aborted) return;

      if (this.#inPlace(positionMs)) {
        this.player.seekInPlace(positionMs);

        return;
      }

      const { playback } = this.#receiver;
      const moved = await runSdk(Playback.seekStream(playback, Milliseconds.make(positionMs)));

      // Once the media server moved the stream the receiver follows it, even for a seek replaced
      // meanwhile: the old generation is gone, and the newer seek runs next.
      if (this.#stopped) return;

      if (moved === null || Result.isFailure(moved)) {
        // Any failure renegotiates there, which retries or ends the cast as the failure calls for.
        await this.#renegotiate(positionMs);

        return;
      }

      const next = Option.getOrUndefined(moved.success);

      if (next === undefined || next.generation === playback.stream.generation) {
        this.player.seekInPlace(positionMs);

        return;
      }

      this.#receiver = { ...this.#receiver, playback: inGeneration(playback, next) };
      await this.#loadAt(positionMs);
    });
  }

  /**
   * Ends the cast on the page's side and stops the receiver's stream. With `resume` (the device
   * disconnected), the page takes the start back where the TV was. Without it (the player is
   * closing), the start's output stays on the receiver's last position, so the last report says
   * where the TV stopped. The cast session itself is the caller's to end.
   */
  stop(resume: boolean): void {
    this.#end(resume, !this.player.isPaused());
  }

  /** Ends the cast as `stop` does; with `resume`, the page takes the start back, `playing` or not. */
  #end(resume: boolean, playing: boolean): void {
    if (this.#stopped) return;
    this.#stopped = true;

    const positionMs = this.player.positionMs();

    clearTimeout(this.#retryTimer);
    this.#unsubscribe();
    this.player.dispose();
    void runSdk(Playback.stop(this.#receiver.playback));

    if (!resume) return;
    this.#controller.output.switchTo(this.#controller.player);
    this.#controller.takeBack(positionMs, playing);
  }
}
