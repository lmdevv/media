/**
 * The player's engine over a Chromecast running Google's default receiver (ADR 0018): the player
 * loads each song into it as into its own audio element, and it plays the song on the receiver.
 *
 * The receiver fetches the song itself, with a receiver credential the media server lends for the
 * song's start in place of its ticket (ADR 0011), so the receiver never holds the ticket and its
 * URL lasts as long as the start's admission while the session is live (D46). Positions and state
 * come from the Cast SDK's mirror of the receiver's player (`RemotePlayer`), and commands go
 * through its `RemotePlayerController`.
 *
 * Every load has a number, and the receiver's word applies only to the newest load once its media
 * is on the receiver: a credential, a `loadMedia` answer, or a change of the mirror that arrives
 * for an older load, or before the newest one landed, changes nothing (ADR 0018). The mirror names
 * the media it describes, and media another sender put on the receiver, such as a movie cast from
 * `/movies` in another tab, says nothing of this engine's songs. Once another sender's media takes
 * the receiver from this engine's song, the engine lets the receiver be and tells the host, which
 * takes the song back. The player then applies the engine's events only while they belong to the
 * load it made (`PlaybackController`).
 */
import { castMusicContentType, streamedTrack, withReceiverCredential } from "@media/contracts/cast";
import { MUSIC_STREAM_PARAMS, MusicStreamProfile } from "@media/contracts/music-playback";
import type {
  EngineErrorReason,
  EngineEvent,
  EnginePlayback,
  EngineSource,
} from "@media/player/engine";
import type { ReceiverEngine } from "@media/player/playback-controller";
import { Option, Schema } from "effect";

import type {
  CastLoadRequest,
  CastSession,
  RemotePlayer,
  RemotePlayerChange,
  RemotePlayerController,
} from "./cast-api";
import type { CastSdk } from "./cast-sdk";

/** The receiver's player states and idle reasons, as the SDK names them. */
const BUFFERING = "BUFFERING";

const PLAYING = "PLAYING";

const IDLE = "IDLE";

const FINISHED = "FINISHED";

const ERROR = "ERROR";

/** How many of its own loads' media an engine remembers, to tell a late report from another sender. */
const OWN_MEDIA_KEPT = 32;

/** How long a play or pause may take to show in the receiver's mirror before it counts as lost. */
const TOGGLE_TIMEOUT_MS = 5_000;

const decodeProfile = Schema.decodeUnknownOption(MusicStreamProfile);

/** What the receiver shows for a song. */
export interface CastSong {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** An absolute album art URL, or null. */
  readonly artUrl: string | null;
  /** The codec the scanner recorded, which decides the content type of an original. */
  readonly codec: string;
}

/** What the engine asks of the music client. */
export interface CastEngineHost {
  /** The song `trackId` as the receiver shows it; null when the client does not know it. */
  readonly song: (trackId: string) => CastSong | null;
  /**
   * The receiver credential for the start whose stream is `streamUrl`, or null when the media
   * server would not lend one (`Playback.lendToReceiver`).
   */
  readonly lend: (streamUrl: string) => Promise<string | null>;
  /** The answer status of a request for `url` from this page, or null when none came. */
  readonly probe: (url: string) => Promise<number | null>;
  /**
   * Another sender's media took the receiver from this engine's song: the engine drives the
   * receiver no more, and leaves the media there alone.
   */
  readonly taken: () => void;
}

/** A load and where it stands: its number, and its media once the receiver took it. */
interface Load {
  readonly number: number;
  readonly startMs: number;
  /** Whether the load asked the receiver to play. */
  readonly autoplay: boolean;
  /** The URL the receiver fetches, once lent; null while the credential is on its way. */
  readonly url: string | null;
  /** Whether the receiver took the media; until then the mirror describes the media before. */
  readonly landed: boolean;
  /** The media the mirror named as the load landed, before this load's own showed. */
  readonly before: string | null;
}

/** A Chromecast as the player's engine. Create one per Cast session, and `dispose` it after. */
export class CastEngine implements ReceiverEngine {
  readonly #sdk: CastSdk;
  readonly #session: CastSession;
  readonly #host: CastEngineHost;
  readonly #remote: RemotePlayer;
  readonly #controller: RemotePlayerController;
  readonly #changeEvent: string;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  readonly #volumeWatchers = new Set<(volume: number) => void>();
  #loads = 0;
  #load: Load | null = null;
  /**
   * Whether the receiver should be paused (true) or playing (false), until its mirror shows it.
   * Commands only toggle and the mirror lags, so what was asked is kept here and reached one toggle
   * at a time.
   */
  #wanted: boolean | null = null;
  /** A toggle is on its way; the next pause or play the mirror reports is its outcome. */
  #toggling: ReturnType<typeof setTimeout> | null = null;
  /** A seek the mirror does not show yet; positions read it until it does. */
  #seekTo: number | null = null;
  /** Where the receiver was while connected; a disconnect resets the mirror to zero. */
  #lastMs = 0;
  /** Once disposed, the engine sends the receiver nothing more. */
  #disposed = false;
  /** The mirror has shown the newest load's media; another sender's after it takes the receiver. */
  #shown = false;
  /** Another sender's media took the receiver: the engine sends it nothing more. */
  #taken = false;
  /** The media this engine loaded on the receiver, newest last: a late report of one is its own. */
  readonly #own: Array<string> = [];

  constructor(sdk: CastSdk, session: CastSession, host: CastEngineHost) {
    this.#sdk = sdk;
    this.#session = session;
    this.#host = host;
    this.#remote = new sdk.framework.RemotePlayer();
    this.#controller = new sdk.framework.RemotePlayerController(this.#remote);
    this.#changeEvent = sdk.framework.RemotePlayerEventType.ANY_CHANGE;
    this.#controller.addEventListener(this.#changeEvent, this.#onChange);
  }

  /** The receiver's name, as the sender reads it off the device; null when it has none. */
  get receiverName(): string | null {
    const name = this.#session.getCastDevice().friendlyName.trim();

    return name === "" ? null : name;
  }

  /** Stops following the receiver; its listeners hear nothing more. */
  dispose(): void {
    this.#disposed = true;
    this.#loads += 1;
    this.#load = null;
    this.#settleToggle();
    this.#controller.removeEventListener(this.#changeEvent, this.#onChange);
    this.#listeners.clear();
    this.#volumeWatchers.clear();
  }

  /** The receiver's volume now, from 0 to 1: 0 while it is muted. */
  volume(): number {
    return this.#remote.isMuted ? 0 : this.#remote.volumeLevel;
  }

  /**
   * Calls `listener` with the receiver's volume each time it changes, its own remote's and a mute
   * included.
   */
  watchVolume(listener: (volume: number) => void): () => void {
    this.#volumeWatchers.add(listener);

    return () => {
      this.#volumeWatchers.delete(listener);
    };
  }

  samplePlayback(): EnginePlayback {
    const load = this.#load;

    if (load === null) return { positionMs: 0, playing: false };

    if (!load.landed) return { positionMs: load.startMs, playing: false };

    if (this.#taken) return { positionMs: this.#lastMs, playing: false };

    // Until the mirror describes this load's media, it describes another's: the song stands where
    // it was asked to start, playing or paused as asked.
    if (!this.#describes(load)) {
      return { positionMs: this.#seekTo ?? load.startMs, playing: !this.#asked(load) };
    }

    return { positionMs: this.#positionMs(), playing: !this.#paused() };
  }

  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    this.#loads += 1;
    const number = this.#loads;

    this.#load = { number, startMs, autoplay, url: null, landed: false, before: null };
    this.#wanted = null;
    this.#settleToggle();
    this.#seekTo = null;
    this.#shown = false;

    const credential = await this.#host.lend(source.url);

    if (!this.#current(number)) return;

    if (credential === null) {
      this.#emit({ type: "error", reason: "expired", message: "The receiver got no credential" });

      return;
    }

    const url = withReceiverCredential(source.url, credential);

    this.#own.push(url);

    if (this.#own.length > OWN_MEDIA_KEPT) this.#own.shift();

    this.#load = { number, startMs, autoplay, url, landed: false, before: null };

    const play = this.#playAsked(autoplay);

    const failure = await this.#session
      .loadMedia(this.#request(url, source, startMs, play))
      .catch(() => "load-failed");

    if (!this.#current(number)) {
      // The receiver took a song the player let go of meanwhile, as when playback moved to another
      // device or the person skipped: until a newer load's song reaches the receiver, it stops.
      if (failure === undefined && this.#noNewerMedia() && this.#remote.isConnected) {
        this.#controller.stop();
      }

      return;
    }

    if (failure !== undefined) {
      await this.#failed(number, url, "The TV couldn't load this song");

      return;
    }

    const landed: Load = {
      number,
      startMs,
      autoplay: play,
      url,
      landed: true,
      before: this.#mediaOnReceiver(),
    };

    this.#load = landed;

    if (this.#mediaOnReceiver() === url) this.#shown = true;

    const now = this.samplePlayback();

    this.#emit({ type: "time", positionMs: now.positionMs });
    this.#emit({ type: now.playing ? "playing" : "paused" });
    this.#reconcile();
  }

  /** The receiver plays every song as it comes; it has nothing to queue ahead. */
  preload(): void {}

  play(): Promise<void> {
    this.#ask(false);

    return Promise.resolve();
  }

  pause(): void {
    this.#ask(true);
  }

  seek(positionMs: number): void {
    const target = Math.max(0, positionMs);

    if (this.#load?.landed !== true) {
      this.#emit({ type: "time", positionMs: target });

      return;
    }

    this.#seekTo = target;
    this.#remote.currentTime = target / 1000;
    this.#controller.seek();
    this.#emit({ type: "time", positionMs: target });
  }

  setVolume(volume: number): void {
    this.#remote.volumeLevel = Math.min(1, Math.max(0, volume));
    this.#controller.setVolumeLevel();

    // A level above silence brings back the sound of a receiver its own remote muted.
    if (this.#remote.volumeLevel > 0 && this.#remote.isMuted) this.#controller.muteOrUnmute();
  }

  unload(): void {
    const landed = this.#load?.landed === true && !this.#disposed && !this.#taken;

    this.#loads += 1;
    this.#load = null;
    this.#wanted = null;
    this.#settleToggle();
    this.#seekTo = null;

    // The Cast session stays for the next song.
    if (landed && this.#remote.isConnected) this.#controller.stop();
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Whether load `number` is still the newest. */
  #current(number: number): boolean {
    return this.#load?.number === number;
  }

  /**
   * Whether no load newer than the one awaited has sent its song to the receiver: the player let
   * go of the song, or a newer load still waits for its credential. A method, so TypeScript does
   * not keep the check before the await narrowed. A disposed engine sends nothing.
   */
  #noNewerMedia(): boolean {
    return !this.#disposed && !this.#taken && (this.#load === null || this.#load.url === null);
  }

  /** The URL of the media on the receiver, whichever sender loaded it; null while it has none. */
  #mediaOnReceiver(): string | null {
    return this.#remote.mediaInfo?.contentId ?? null;
  }

  /**
   * Whether the mirror describes `load`'s media: it names that media, or none, as while it resets.
   * The media before this load, or another sender's, says nothing of it (ADR 0018).
   */
  #describes(load: Load): boolean {
    const media = this.#mediaOnReceiver();

    return media === null || media === load.url;
  }

  /**
   * Whether a load asking `autoplay` should start playing: a play or pause asked while its
   * credential was on its way goes with it. A method, so TypeScript does not keep a narrowing of
   * the wish from before the await.
   */
  #playAsked(autoplay: boolean): boolean {
    return this.#wanted === null ? autoplay : !this.#wanted;
  }

  /** Whether `load` should be paused, as last asked, or as it asked the receiver to start. */
  #asked(load: Load): boolean {
    return this.#wanted ?? !load.autoplay;
  }

  #request(url: string, source: EngineSource, startMs: number, autoplay: boolean): CastLoadRequest {
    const { media, Image } = this.#sdk.cast;
    const trackId = streamedTrack(url);
    const song = trackId === null ? null : this.#host.song(trackId);
    const asked = new URL(url).searchParams.get(MUSIC_STREAM_PARAMS.profile) ?? "original";
    const profile = Option.getOrElse(decodeProfile(asked), () => "original" as const);
    const info = new media.MediaInfo(url, castMusicContentType(profile, song?.codec ?? ""));
    const metadata = new media.MusicTrackMediaMetadata();

    metadata.title = song?.title ?? "";
    metadata.artist = song?.artist ?? "";
    metadata.albumName = song?.album ?? "";
    metadata.images = song === null || song.artUrl === null ? [] : [new Image(song.artUrl)];
    info.contentUrl = url;
    info.streamType = "BUFFERED";
    info.duration = source.durationMs / 1000;
    info.metadata = metadata;

    const request = new media.LoadRequest(info);

    request.autoplay = autoplay;
    request.currentTime = startMs / 1000;

    return request;
  }

  /**
   * Why the receiver could not play `url`, from what the media server answers this page for it:
   * a refused credential (its start's admission or session ended) is `expired`, which a new start
   * answers; no answer is `network`; anything else is the song's own `unsupported`.
   */
  async #reasonOf(url: string): Promise<EngineErrorReason> {
    const status = await this.#host.probe(url);

    if (status === null) return "network";

    return status === 401 || status === 403 || status === 410 ? "expired" : "unsupported";
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #paused(): boolean {
    return this.#remote.isConnected ? (this.#wanted ?? this.#remote.isPaused) : true;
  }

  #positionMs(): number {
    if (this.#seekTo !== null) return this.#seekTo;

    return this.#remote.isConnected ? this.#remote.currentTime * 1000 : this.#lastMs;
  }

  readonly #onChange = (change: RemotePlayerChange): void => {
    if (change.field === "volumeLevel" || change.field === "isMuted") {
      for (const watcher of this.#volumeWatchers) watcher(this.volume());
    }

    const load = this.#load;

    if (load === null || !load.landed || this.#taken) return;

    const media = this.#mediaOnReceiver();

    if (media !== null && media !== load.url) {
      // An older load of this engine's, or the media before this load, says nothing of it. Other
      // media arriving after it landed, or after its own showed, is another sender's, which took
      // the receiver from the song.
      if (!this.#own.includes(media) && (this.#shown || media !== load.before)) this.#take();

      return;
    }

    if (media !== null && !this.#shown) {
      this.#shown = true;
      // The mirror reports its fields one at a time: a play or pause asked meanwhile goes once the
      // rest of this load's state came.
      queueMicrotask(() => {
        if (this.#load === load) this.#reconcile();
      });
    }

    // A disconnect resets the mirror (time to zero, paused): that is no position of the song. A
    // jump to zero this engine asked for is the answer to that seek, not the reset.
    const reset =
      change.field === "currentTime" &&
      change.value === 0 &&
      this.#seekTo !== 0 &&
      this.#lastMs > 1_000;

    if (this.#remote.isConnected && !reset) this.#lastMs = this.#remote.currentTime * 1000;

    switch (change.field) {
      case "currentTime": {
        if (reset) return;

        if (this.#seekTo !== null && Math.abs(this.#lastMs - this.#seekTo) < 1_000) {
          this.#seekTo = null;
        }

        if (this.#seekTo === null) this.#emit({ type: "time", positionMs: this.#lastMs });
        break;
      }

      case "isPaused": {
        this.#settleToggle();
        this.#reconcile();
        this.#emit({ type: change.value === true ? "paused" : "playing" });
        break;
      }

      case "playerState": {
        if (change.value === BUFFERING) this.#emit({ type: "waiting" });
        else if (change.value === PLAYING && !this.#remote.isPaused) {
          this.#emit({ type: "playing" });
        } else if (change.value === IDLE) this.#idle(load);
        break;
      }

      default:
    }
  };

  /** The receiver went idle: its song ended, or failed to play on. A stop or a new load changes nothing. */
  #idle(load: Load): void {
    const reason = this.#session.getMediaSession()?.idleReason ?? null;

    if (reason === FINISHED) {
      this.#emit({ type: "ended" });

      return;
    }

    if (reason !== ERROR || load.url === null) return;

    void this.#failed(load.number, load.url, "The TV stopped playing this song");
  }

  /** Another sender's media took the receiver: the engine lets it be, and the host takes the song. */
  #take(): void {
    this.#taken = true;
    this.#wanted = null;

    // A seek the receiver had not shown yet is where the song was asked to be.
    if (this.#seekTo !== null) this.#lastMs = this.#seekTo;
    this.#seekTo = null;
    this.#settleToggle();
    this.#host.taken();
  }

  /** Tells the player why the receiver failed load `number`'s song, if it is still the newest. */
  async #failed(number: number, url: string, message: string): Promise<void> {
    const reason = await this.#reasonOf(url);

    if (this.#current(number)) this.#emit({ type: "error", reason, message });
  }

  /** Asks for the receiver to be `paused` (or playing); reached as soon as no toggle is on its way. */
  #ask(paused: boolean): void {
    if (this.#load === null || this.#taken) return;

    this.#wanted = paused;
    this.#reconcile();
  }

  /**
   * Sends one toggle if the receiver isn't where it was asked to be and none is on its way. A
   * toggle whose outcome never shows (a lost command) is given up on after a while, and the mirror
   * is trusted again.
   */
  #reconcile(): void {
    const load = this.#load;

    if (this.#wanted === null || this.#toggling !== null || this.#taken) return;

    // The mirror's pause belongs to another's media until it describes this load's.
    if (load === null || !load.landed || !this.#describes(load)) return;

    if (!this.#remote.isConnected) {
      this.#wanted = null;

      return;
    }

    if (this.#remote.isPaused === this.#wanted) {
      // A mirror that names no media yet may still show the receiver before this load started:
      // the wish stands until this load's own media shows.
      if (this.#shown || this.#mediaOnReceiver() !== null) this.#wanted = null;

      return;
    }

    this.#toggling = setTimeout(() => {
      this.#toggling = null;
      this.#wanted = null;
      this.#emit({ type: this.#remote.isPaused ? "paused" : "playing" });
    }, TOGGLE_TIMEOUT_MS);
    this.#controller.playOrPause();
  }

  #settleToggle(): void {
    if (this.#toggling !== null) clearTimeout(this.#toggling);
    this.#toggling = null;
  }
}
