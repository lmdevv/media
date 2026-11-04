import { delay, MAX_BUSY_RETRIES, retryAfterMs } from "./busy-retry";
import type {
  EnginePlayback,
  EngineErrorReason,
  EngineEvent,
  EngineSource,
  PlayerEngine,
} from "./engine";
import { codecMimeType, concatBytes, HeaderRead, readHeader } from "./fmp4";
import type { AudioCodec, StreamHeader } from "./fmp4";
import {
  evictionEnd,
  fragmentAt,
  parseStreamStart,
  parseStreamTiming,
  placeTrack,
} from "./gapless-timeline";
import type { Placement, StreamTiming } from "./gapless-timeline";
import { addToTail, holdTail, releaseAll, TailStep } from "./held-tail";
import type { HeldTail, Piece } from "./held-tail";
import { primeInGesture } from "./prime-audio";
import { endedEarly, offsetUrl } from "./stream-offset";
import type { MseSupport } from "./stream-quality";

declare global {
  /** Safari's power-aware `MediaSource` subclass (iOS 17.1+); the only one on iPhone. */
  var ManagedMediaSource: typeof MediaSource | undefined;
}

const TICK_MS = 100;

const AHEAD_SECONDS = 30;

const BEHIND_SECONDS = 30;

const EVICT_MIN_SECONDS = 5;

const QUOTA_BEHIND_SECONDS = 1;

const QUOTA_FREED_SECONDS = 1;

const MAX_APPEND_BYTES = 1024 * 1024;

const IDLE_MS = 250;

const BUFFERED_MARGIN = 0.05;

const LIVE_RESTART_SECONDS = 2;

const HUNG_MS = 8000;

const STUCK_MS = 3000;

const STUCK_AHEAD_SECONDS = 1;

const MAX_RECOVERIES = 3;

const FORBIDDEN = 403;

const TARGET_TOLERANCE = 0.01;

const GAP_SECONDS = 0.5;

/** One song on the timeline and how far its stream has been appended. */
interface Song {
  readonly source: EngineSource;
  /**
   * Where playback should begin inside the song, in seconds, when its header is next read: the
   * load position for the first song, or a seek target when a live stream is fetched again.
   */
  startSeconds: number;
  /** Aborts the song's current fetch; replaced on every restart. */
  abort: AbortController;
  /**
   * Where in the song, in seconds, the stream to open next should start, when it is to come from
   * an offset (`&start=`) rather than the whole song's stream; null otherwise.
   */
  fromSeconds: number | null;
  /**
   * Where in the song, in seconds, the open stream's first sample sits: 0 for the whole song,
   * the media service's `X-Music-Start-Samples` for a stream from an offset.
   */
  streamStart: number;
  /** Seconds into the song that its appends have reached: where a cut-off stream picks up. */
  appendedTo: number;
  /** When the open stream last sent bytes (or opened), from `performance.now()`. */
  lastBytesAt: number;
  /** Pickups of a cut-off stream since the song's last successful append. */
  recoveries: number;
  /** Busy answers (`503`) in a row from the media service while opening the song's stream. */
  busyRetries: number;
  /** The media service ignored `&start=` once, so the song is never asked for an offset again. */
  offsetsIgnored: boolean;
  /**
   * The song's exact timing, asked for once the song first streams from an offset, while the
   * full transcode it waits for is still running; null until then.
   */
  exact: Promise<StreamTiming> | null;
  /** Aborts the request behind `exact`; only dropping the song stops it. */
  exactAbort: AbortController;
  timing: StreamTiming | null;
  header: StreamHeader | null;
  placement: Placement | null;
  etag: string | null;
  /** Bumped whenever the song's stream restarts or stops; stale async steps then give up. */
  epoch: number;
  /** The open response body, or null before the first fetch and after a restart. */
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null;
  /**
   * The open stream has sent everything. Its end may still wait for the exact timing, and a
   * playhead waiting meanwhile is not a hung stream.
   */
  drained: boolean;
  /** File offset of the next byte the reader yields. */
  readOffset: number;
  /** File offset to fetch from when the reader is reopened. */
  resumeFrom: number;
  /** Bytes read but not appended yet (header bytes, or a chunk the quota refused). */
  pending: Piece | null;
  /** The held end of a stream that is still being transcoded, or null for a finished file. */
  tail: HeldTail | null;
  /** Some media bytes were appended since the stream (re)started. */
  appended: boolean;
  /** True once every fragment is appended. */
  complete: boolean;
  /** The codec differs from the buffer's and this browser cannot `changeType`. */
  needsReset: boolean;
}

/** One `MediaSource` attached to the element, with the songs on its timeline. */
interface Session {
  readonly mediaSource: MediaSource;
  readonly objectUrl: string;
  readonly songs: Array<Song>;
  buffer: SourceBuffer | null;
  codec: AudioCodec | null;
  /** The song whose init segment, window, and offset the buffer holds. */
  configuredFor: Song | null;
  /** A removal from this time to the end, which the pump runs before its next append. */
  removeFrom: number | null;
  /**
   * Where the last seek put the playhead, on the element's timeline, until it plays from there
   * (see `#holdTarget`); null otherwise.
   */
  target: number | null;
  /** Seconds to buffer ahead; lowered when the browser's buffer quota runs out first. */
  aheadLimit: number;
  cancelled: boolean;
  /** The end of the timeline was reported (`ended`) since the last seek or `play`. */
  endReported: boolean;
  loadingPlayback: boolean | null;
  wake: () => void;
}

class EngineFailure extends Error {
  readonly reason: EngineErrorReason;

  constructor(reason: EngineErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const mediaSourceClass = (): typeof MediaSource | null => {
  if ("MediaSource" in globalThis) return MediaSource;

  return globalThis.ManagedMediaSource ?? null;
};

/** Reads a session's flag after an await; TypeScript would keep a narrowing from before it. */
const isCancelled = (session: Session): boolean => session.cancelled;

const elementErrorReason = (error: MediaError): EngineErrorReason =>
  error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "unsupported" : "decode";

/**
 * A `PlayerEngine` that plays fragmented MP4 through Media Source Extensions with sample-accurate
 * transitions. Sources must be `fmp4-flac` or `fmp4-aac` stream URLs: the engine reads their
 * `X-Music-*` timing headers and `sidx` index.
 */
export class MseEngine implements PlayerEngine {
  /**
   * What this browser's MSE can play, or null when it cannot run the engine (no `MediaSource`
   * and no `ManagedMediaSource`, or no AAC in MP4).
   */
  static detectSupport(): MseSupport | null {
    const MediaSourceClass = mediaSourceClass();

    if (MediaSourceClass === null || !MediaSourceClass.isTypeSupported(codecMimeType("aac"))) {
      return null;
    }

    return {
      flac: MediaSourceClass.isTypeSupported(codecMimeType("flac")),
      changeType: "SourceBuffer" in globalThis && "changeType" in SourceBuffer.prototype,
    };
  }

  readonly #element: HTMLAudioElement;
  readonly #canChangeType: boolean;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #session: Session | null = null;
  #preloadSource: EngineSource | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #moved = { time: 0, at: 0 };
  #cancelLoad: (() => void) | null = null;

  /**
   * @param element - The audio element to play through. Pass one routed through Web Audio for a
   *   visualizer, an equalizer, or a capture-based gap measurement.
   */
  constructor(element: HTMLAudioElement = new Audio()) {
    this.#element = element;
    this.#canChangeType = MseEngine.detectSupport()?.changeType ?? false;
    // ManagedMediaSource only opens when remote playback (AirPlay) is off or has an alternative.
    element.disableRemotePlayback = true;
    this.#attach();
  }

  /** Reads the current element and any seek target still landing. */
  samplePlayback(): EnginePlayback {
    return {
      positionMs: this.#positionMs(),
      playing: this.#session?.loadingPlayback ?? (this.#session !== null && !this.#element.paused),
    };
  }

  /** Starts a fresh timeline with `source` at `startMs`. Resolves once playback can begin. */
  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    this.#cancelLoad?.();

    if (this.#skipToQueued(source, startMs)) {
      if (autoplay) await this.play();
      else this.#emit({ type: "paused" });

      return;
    }

    const session = this.#open();

    if (session === null) {
      this.#fail("unsupported", "This browser has no Media Source Extensions");

      return;
    }

    session.loadingPlayback = autoplay;
    const song = this.#song(source, startMs / 1000);
    session.songs.push(song);

    if (this.#preloadSource !== null && this.#preloadSource.url !== source.url) {
      session.songs.push(this.#song(this.#preloadSource, 0));
    }

    const ready = await this.#whenPlayable(session, song);

    if (!ready || session !== this.#session) return;
    this.#emit({ type: "time", positionMs: startMs });

    const playing = session.loadingPlayback;
    session.loadingPlayback = null;

    if (playing) await this.play();
    else this.#emit({ type: "paused" });
  }

  /** Queues `source` right after the current song on the timeline, or drops the queued one. */
  preload(source: EngineSource | null): void {
    this.#preloadSource = source;
    const session = this.#session;

    if (session === null || session.songs.length === 0) return;
    const queued = session.songs[1];

    if (queued !== undefined && queued.source.url === source?.url) return;

    if (queued !== undefined) {
      session.songs.splice(1);
      this.#discard(session, queued);
    }

    if (source !== null) session.songs.push(this.#song(source, 0));
    session.wake();
  }

  /** Starts output. Emits `autoplay-blocked` when the browser wants a user gesture first. */
  async play(): Promise<void> {
    if (this.#session === null) return;

    if (this.#session.loadingPlayback !== null) this.#session.loadingPlayback = true;

    this.#session.endReported = false;

    try {
      await this.#element.play();
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;

      if (error.name === "AbortError") return;

      if (error.name === "NotAllowedError") {
        this.#fail("autoplay-blocked", "The browser blocked playback until you tap play");

        return;
      }

      if (this.#element.error === null) this.#fail("unsupported", error.message);
    }
  }

  pause(): void {
    if (this.#session !== null && this.#session.loadingPlayback !== null)
      this.#session.loadingPlayback = false;
    this.#element.pause();
  }

  unlock(): void {
    if (this.#session === null && this.#element.paused) primeInGesture(this.#element);
  }

  /** Seeks inside the current song; outside the buffer, refetches from the right fragment. */
  seek(positionMs: number): void {
    const session = this.#session;
    const song = session?.songs[0];

    if (session === null || song === undefined) return;
    const { placement } = song;

    if (placement === null) return;

    const target = Math.min(
      placement.start + Math.max(0, positionMs) / 1000,
      Math.max(placement.start, placement.end - BUFFERED_MARGIN),
    );

    session.target = target;
    this.#emit({ type: "time", positionMs: Math.round((target - placement.start) * 1000) });
    session.endReported = false;
    this.#extendDuration(session, placement.end);

    if (this.#bufferedAhead(target) > BUFFERED_MARGIN) {
      this.#element.currentTime = target;

      return;
    }

    for (const later of session.songs.slice(1)) this.#restartAt(later, 0);
    this.#restartAt(song, target - placement.start);
    session.removeFrom = 0;
    session.configuredFor = null;
    this.#element.currentTime = target;
    session.wake();
  }

  setVolume(volume: number): void {
    this.#element.volume = Math.min(1, Math.max(0, volume));
  }

  /** Stops output and releases the `MediaSource` and every buffered song. */
  unload(): void {
    this.#cancelLoad?.();
    this.#preloadSource = null;
    this.#close();
    this.#stopTicker();
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #fail(reason: EngineErrorReason, message: string): void {
    if (this.#session !== null) this.#session.loadingPlayback = null;
    this.#stopTicker();
    this.#emit({ type: "error", reason, message });
  }

  #song(source: EngineSource, startSeconds: number): Song {
    return {
      source,
      startSeconds,
      abort: new AbortController(),
      fromSeconds: null,
      streamStart: 0,
      appendedTo: startSeconds,
      lastBytesAt: 0,
      recoveries: 0,
      busyRetries: 0,
      offsetsIgnored: false,
      exact: null,
      exactAbort: new AbortController(),
      timing: null,
      header: null,
      placement: null,
      etag: null,
      epoch: 0,
      reader: null,
      drained: false,
      readOffset: 0,
      resumeFrom: 0,
      pending: null,
      tail: null,
      appended: false,
      complete: false,
      needsReset: false,
    };
  }

  #open(): Session | null {
    this.#close();
    const MediaSourceClass = mediaSourceClass();

    if (MediaSourceClass === null) return null;
    const mediaSource = new MediaSourceClass();
    const objectUrl = URL.createObjectURL(mediaSource);

    const session: Session = {
      mediaSource,
      objectUrl,
      songs: [],
      buffer: null,
      codec: null,
      configuredFor: null,
      removeFrom: null,
      target: null,
      aheadLimit: AHEAD_SECONDS,
      cancelled: false,
      endReported: false,
      loadingPlayback: null,
      wake: () => undefined,
    };

    this.#session = session;
    this.#element.src = objectUrl;
    void this.#pump(session);

    return session;
  }

  #close(): void {
    const session = this.#session;

    if (session === null) return;
    session.cancelled = true;
    session.wake();

    for (const song of session.songs) this.#stopReading(song);
    this.#session = null;
    this.#element.removeAttribute("src");
    this.#element.load();
    URL.revokeObjectURL(session.objectUrl);
  }

  #stopReading(song: Song): void {
    song.epoch += 1;
    song.abort.abort();
    song.exactAbort.abort();
    song.reader = null;
  }

  #rewind(song: Song, offset: number): void {
    song.epoch += 1;
    song.abort.abort();
    song.abort = new AbortController();
    song.reader = null;
    song.pending = null;
    song.tail = null;
    song.appended = false;
    song.resumeFrom = offset;
    song.complete = false;
  }

  #restartAt(song: Song, seconds: number): void {
    const { header, timing } = song;
    const index = header?.index ?? null;

    if (header !== null && index !== null && timing !== null) {
      this.#rewind(song, fragmentAt(index, timing, seconds)?.offset ?? header.length);
      song.appendedTo = seconds;

      return;
    }

    this.#rewind(song, 0);
    song.appendedTo = seconds;
    song.header = null;
    song.etag = null;
    song.startSeconds = seconds;
    song.fromSeconds = seconds >= LIVE_RESTART_SECONDS && !song.offsetsIgnored ? seconds : null;

    if (song.fromSeconds !== null) this.#askExactTiming(song);
  }

  #recover(session: Session, song: Song): boolean {
    if (song.recoveries >= MAX_RECOVERIES || (song.header?.index == null && song.offsetsIgnored)) {
      return false;
    }

    song.recoveries += 1;
    this.#restartAt(song, song.appendedTo);
    session.wake();

    return true;
  }

  #cutShort(song: Song): boolean {
    const placement = song.placement;

    return (
      placement !== null &&
      endedEarly(song.appendedTo * 1000, (placement.end - placement.start) * 1000)
    );
  }

  #askExactTiming(song: Song): void {
    if (song.exact !== null || song.timing?.estimated === false) return;

    const exact = this.#fetchExactTiming(song.source.url, song.exactAbort.signal);

    exact.catch(() => undefined);
    song.exact = exact;
  }

  async #fetchExactTiming(url: string, signal: AbortSignal): Promise<StreamTiming> {
    let response: Response;

    try {
      response = await fetch(url, { method: "HEAD", signal });
    } catch (error) {
      throw new EngineFailure("network", error instanceof Error ? error.message : String(error));
    }

    if (response.status === FORBIDDEN) {
      void response.body?.cancel().catch(() => undefined);

      throw new EngineFailure("expired", "The stream's signed URL has expired");
    }

    const timing = parseStreamTiming((name) => response.headers.get(name));

    if (!response.ok || timing === null || timing.estimated) {
      throw new EngineFailure("unsupported", `The finished stream answered ${response.status}`);
    }

    return timing;
  }

  #discard(session: Session, song: Song): void {
    this.#stopReading(song);

    if (song.placement !== null && (song.complete || song.appended)) {
      session.removeFrom = Math.min(session.removeFrom ?? Infinity, song.placement.start);
    }

    if (session.configuredFor === song) session.configuredFor = null;
  }

  #skipToQueued(source: EngineSource, startMs: number): boolean {
    const session = this.#session;
    const queued = session?.songs[1];

    if (
      session === null ||
      queued?.source.url !== source.url ||
      queued.placement === null ||
      queued.needsReset
    ) {
      return false;
    }

    session.songs.shift();
    this.#preloadSource = null;
    this.seek(startMs);

    return true;
  }

  #whenPlayable(session: Session, song: Song): Promise<boolean> {
    const element = this.#element;

    return new Promise((resolve) => {
      const settle = (ready: boolean): void => {
        element.removeEventListener("canplay", check);
        element.removeEventListener("error", onFail);
        clearInterval(poll);
        this.#cancelLoad = null;
        resolve(ready);
      };

      function onFail(): void {
        settle(false);
      }

      const check = (): void => {
        if (session.cancelled || session !== this.#session) {
          settle(false);

          return;
        }

        const placement = song.placement;

        if (placement === null) return;
        const target = placement.start + song.startSeconds;
        const ahead = this.#bufferedAhead(target);

        if (ahead <= BUFFERED_MARGIN && !(song.complete && ahead > 0)) return;

        if (Math.abs(element.currentTime - target) > 0.001) element.currentTime = target;

        if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA || song.complete) {
          settle(true);
        }
      };

      element.addEventListener("canplay", check);
      element.addEventListener("error", onFail);
      const poll = setInterval(check, 20);
      this.#cancelLoad = onFail;
    });
  }

  #bufferedAhead(time: number): number {
    const ranges = this.#session?.buffer?.buffered;

    if (ranges === undefined) return 0;

    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= time + 1e-6 && time < ranges.end(index)) {
        return ranges.end(index) - time;
      }
    }

    return 0;
  }

  #aheadOfPlayhead(): number {
    const ranges = this.#session?.buffer?.buffered;
    const time = this.#element.currentTime;

    if (ranges === undefined) return 0;

    for (let index = 0; index < ranges.length; index += 1) {
      if (time < ranges.end(index)) return ranges.end(index) - time;
    }

    return 0;
  }

  async #pump(session: Session): Promise<void> {
    await this.#opened(session);
    this.#continuePump(session);
  }

  #continuePump(session: Session): void {
    void this.#pumpStep(session).then((more) => {
      if (more && !isCancelled(session)) this.#continuePump(session);

      return undefined;
    });
  }

  async #pumpStep(session: Session): Promise<boolean> {
    const song = session.songs.find((candidate) => !candidate.complete && !candidate.needsReset);
    const epoch = song?.epoch;

    try {
      this.#holdTarget(session);

      if (await this.#runRemoval(session)) return true;

      if (await this.#evictBehind(session, BEHIND_SECONDS)) return true;

      if (song === undefined) {
        this.#endIfFinished(session);
        await this.#idle(session);

        return true;
      }

      await this.#step(session, song);

      return true;
    } catch (error) {
      if (isCancelled(session)) return false;

      if (song !== undefined && (song.epoch !== epoch || !session.songs.includes(song))) {
        return true;
      }

      if (
        song !== undefined &&
        error instanceof EngineFailure &&
        error.reason === "network" &&
        this.#recover(session, song)
      ) {
        return true;
      }

      const index = song === undefined ? 0 : session.songs.indexOf(song);

      if (song !== undefined && index > 0) {
        session.songs.splice(index);
        this.#discard(session, song);

        return true;
      }

      const failure =
        error instanceof EngineFailure
          ? error
          : new EngineFailure("decode", error instanceof Error ? error.message : String(error));

      session.cancelled = true;
      this.#fail(failure.reason, failure.message);

      return false;
    }
  }

  #opened(session: Session): Promise<void> {
    if (session.mediaSource.readyState === "open") return Promise.resolve();

    return new Promise((resolve) => {
      session.mediaSource.addEventListener(
        "sourceopen",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  }

  #idle(session: Session): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, IDLE_MS);

      function done(): void {
        clearTimeout(timer);
        session.wake = () => undefined;
        resolve();
      }

      session.wake = done;
    });
  }

  async #operate(session: Session, operation: (buffer: SourceBuffer) => void): Promise<void> {
    const buffer = session.buffer;

    if (buffer === null) return;

    if (session.mediaSource.readyState === "closed") {
      throw new EngineFailure("decode", "The media source closed");
    }

    await new Promise<void>((resolve, reject) => {
      const settle = (failure: Error | null): void => {
        buffer.removeEventListener("updateend", onEnd);
        buffer.removeEventListener("error", onError);

        if (failure === null) resolve();
        else reject(failure);
      };

      const onEnd = (): void => {
        settle(null);
      };

      const onError = (): void => {
        settle(new EngineFailure("decode", "The browser could not decode the stream"));
      };

      buffer.addEventListener("updateend", onEnd);
      buffer.addEventListener("error", onError);

      try {
        operation(buffer);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async #runRemoval(session: Session): Promise<boolean> {
    const from = session.removeFrom;

    if (from === null) return false;
    session.removeFrom = null;
    const ranges = session.buffer?.buffered;

    if (ranges === undefined || ranges.length === 0) return true;

    if (ranges.end(ranges.length - 1) > from) {
      await this.#operate(session, (buffer) => {
        buffer.remove(from, Infinity);
      });
    }

    return true;
  }

  async #evictBehind(
    session: Session,
    keep: number,
    atLeast = EVICT_MIN_SECONDS,
  ): Promise<boolean> {
    const ranges = session.buffer?.buffered;

    if (ranges === undefined || ranges.length === 0) return false;
    const start = ranges.start(0);
    const end = evictionEnd(start, this.#element.currentTime, keep);

    if (end === null || end - start < atLeast) return false;

    await this.#operate(session, (buffer) => {
      buffer.remove(start, end);
    });

    return true;
  }

  #endIfFinished(session: Session): void {
    const buffer = session.buffer;

    if (
      buffer === null ||
      buffer.updating ||
      session.mediaSource.readyState !== "open" ||
      session.songs.length === 0
    ) {
      return;
    }

    session.mediaSource.endOfStream();
    const target = session.target;
    const ranges = buffer.buffered;
    const bufferedEnd = ranges.length === 0 ? 0 : ranges.end(ranges.length - 1);

    if (target !== null && bufferedEnd <= target + BUFFERED_MARGIN) this.#reachEnd(session);
  }

  async #step(session: Session, song: Song): Promise<void> {
    if (song.reader === null && song.pending === null) {
      await this.#openStream(song);

      return;
    }

    if (song.header === null) {
      await this.#readHeader(session, song);

      return;
    }

    if (session.configuredFor !== song) {
      await this.#configure(session, song);

      return;
    }

    if (this.#aheadOfPlayhead() > session.aheadLimit) {
      await this.#idle(session);

      return;
    }

    await this.#appendNext(session, song);
  }

  async #openStream(song: Song): Promise<void> {
    const epoch = song.epoch;
    const headers = new Headers();
    const from = song.resumeFrom > 0 ? null : song.fromSeconds;

    if (song.resumeFrom > 0) {
      headers.set("Range", `bytes=${song.resumeFrom}-`);

      if (song.etag !== null) headers.set("If-Range", song.etag);
    }

    const url =
      from === null ? song.source.url : offsetUrl(song.source.url, Math.floor(from * 1000));

    let response: Response;

    try {
      response = await fetch(url, { headers, signal: song.abort.signal });
    } catch (error) {
      if (song.epoch !== epoch) return;

      throw new EngineFailure("network", error instanceof Error ? error.message : String(error));
    }

    if (song.epoch !== epoch) {
      void response.body?.cancel().catch(() => undefined);

      return;
    }

    const busy = retryAfterMs(response);

    if (busy !== null && song.busyRetries < MAX_BUSY_RETRIES) {
      void response.body?.cancel().catch(() => undefined);
      song.busyRetries += 1;
      await delay(busy, song.abort.signal);

      return;
    }

    if (response.status === FORBIDDEN) {
      void response.body?.cancel().catch(() => undefined);

      throw new EngineFailure("expired", "The stream's signed URL has expired");
    }

    if (!response.ok || response.body === null) {
      throw new EngineFailure("unsupported", `The stream answered ${response.status}`);
    }

    const timing = parseStreamTiming((name) => response.headers.get(name));

    if (timing === null) {
      throw new EngineFailure("unsupported", "The stream has no sample timing headers");
    }

    if (song.timing === null || song.timing.estimated) song.timing = timing;

    const startSamples =
      from === null ? null : parseStreamStart((name) => response.headers.get(name));

    if (from !== null && startSamples === null) {
      song.offsetsIgnored = true;
      song.fromSeconds = null;
    }

    song.busyRetries = 0;
    song.streamStart = startSamples === null ? 0 : startSamples / timing.sampleRate;
    song.etag = response.headers.get("ETag");
    song.reader = response.body.getReader();
    song.drained = false;
    song.lastBytesAt = performance.now();
    song.readOffset = response.status === 206 ? song.resumeFrom : 0;
  }

  async #read(song: Song): Promise<Piece | null | "stale"> {
    const reader = song.reader;
    const epoch = song.epoch;

    if (reader === null) return "stale";
    let result: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;

    try {
      result = await reader.read();
    } catch (error) {
      if (song.epoch !== epoch) return "stale";

      throw new EngineFailure("network", error instanceof Error ? error.message : String(error));
    }

    if (song.epoch !== epoch) return "stale";

    if (result.done) {
      song.drained = true;

      return null;
    }

    song.lastBytesAt = performance.now();
    const bytes = result.value;
    const offset = song.readOffset;
    song.readOffset += bytes.length;

    if (song.readOffset <= song.resumeFrom) return this.#read(song);

    return offset >= song.resumeFrom
      ? { offset, bytes }
      : { offset: song.resumeFrom, bytes: bytes.subarray(song.resumeFrom - offset) };
  }

  async #readHeader(session: Session, song: Song): Promise<void> {
    const piece = await this.#read(song);

    if (piece === "stale") return;

    if (piece === null) {
      if (song.fromSeconds !== null && !song.offsetsIgnored) {
        await this.#nothingLeft(session, song);

        return;
      }

      throw new EngineFailure("unsupported", "The stream ended early");
    }

    const bytes =
      song.pending === null ? piece.bytes : concatBytes(song.pending.bytes, piece.bytes);

    const read = readHeader(bytes);

    if (HeaderRead.$is("Invalid")(read)) throw new EngineFailure("unsupported", read.reason);

    if (!HeaderRead.$is("Complete")(read)) {
      song.pending = { offset: 0, bytes };

      return;
    }

    const { header } = read;
    const timing = song.timing;

    if (timing === null) return;
    const previous = session.songs[session.songs.indexOf(song) - 1];
    const current = session.songs[0] === song;
    song.header = header;
    song.placement = placeTrack(timing, song.placement?.start ?? previous?.placement?.end ?? 0);

    if (session.configuredFor === song) session.configuredFor = null;

    if (
      current &&
      header.index === null &&
      song.streamStart === 0 &&
      song.startSeconds >= LIVE_RESTART_SECONDS &&
      !song.offsetsIgnored
    ) {
      this.#restartAt(song, song.startSeconds);

      return;
    }

    if (current && song.streamStart > song.startSeconds) {
      const start = song.placement.start + song.streamStart;
      song.startSeconds = song.streamStart;

      if (session.target !== null && session.target < start) session.target = start;
    }

    const fragment =
      song.startSeconds > 0 && header.index !== null
        ? fragmentAt(header.index, timing, song.startSeconds)
        : null;

    if (fragment !== null && fragment.offset > header.length) {
      this.#rewind(song, fragment.offset);

      return;
    }

    if (header.index === null && song.streamStart === 0 && song.startSeconds > 0 && current) {
      this.#element.currentTime = song.placement.start + song.startSeconds;
    }

    song.resumeFrom = header.length;

    if (!timing.estimated) {
      song.pending = { offset: header.length, bytes: bytes.subarray(header.length) };

      return;
    }

    const { tail, release } = this.#hold(holdTail(header.length), bytes.subarray(header.length));
    song.tail = tail;
    song.pending = release;
  }

  #hold(
    tail: HeldTail,
    bytes: Uint8Array,
  ): { readonly tail: HeldTail; readonly release: Piece | null } {
    const step = addToTail(tail, bytes);

    if (TailStep.$is("Invalid")(step)) throw new EngineFailure("unsupported", step.reason);

    return step;
  }

  async #configure(session: Session, song: Song): Promise<void> {
    const { header, placement } = song;

    if (header === null || placement === null) return;
    const mime = codecMimeType(header.codec);

    if (session.buffer === null) {
      try {
        session.buffer = session.mediaSource.addSourceBuffer(mime);
      } catch (error) {
        throw new EngineFailure(
          "unsupported",
          error instanceof Error ? error.message : String(error),
        );
      }

      session.codec = header.codec;
      session.mediaSource.duration = placement.end;
    } else if (session.codec !== header.codec) {
      if (!this.#canChangeType) {
        song.needsReset = true;

        return;
      }

      session.buffer.changeType(mime);
      session.codec = header.codec;
    }

    // A stream from an offset at or past the song's exact end has nothing to append, and its
    // append window would be empty, which the buffer refuses.
    if (song.timing?.estimated === false && this.#startsPastEnd(song)) {
      this.#endSong(session, song);

      return;
    }

    const buffer = session.buffer;

    if (session.mediaSource.readyState === "open") buffer.abort();
    // Widen first: the window must stay valid (start < end) after every assignment.
    buffer.appendWindowEnd = Infinity;
    buffer.appendWindowStart = placement.start + song.streamStart;
    buffer.appendWindowEnd = song.timing?.estimated === true ? Infinity : placement.end;
    buffer.timestampOffset = placement.timestampOffset;
    await this.#operate(session, (target) => {
      target.appendBuffer(header.init);
    });
    session.configuredFor = song;
    this.#extendDuration(session, placement.end);
  }

  #extendDuration(session: Session, end: number): void {
    const { mediaSource, buffer } = session;

    if (mediaSource.readyState !== "open" || buffer?.updating === true) return;

    if (Number.isNaN(mediaSource.duration) || mediaSource.duration < end) {
      mediaSource.duration = end;
    }
  }

  #holdTarget(session: Session): boolean {
    const target = session.target;

    if (target === null || session !== this.#session) return false;
    const element = this.#element;
    const time = element.currentTime;

    if (time >= target - TARGET_TOLERANCE) {
      if (this.#bufferedAhead(time) > BUFFERED_MARGIN || time > target + TARGET_TOLERANCE) {
        session.target = null;

        return false;
      }

      const next = this.#gapEnd(session, time);

      if (next === null) return false;
      session.target = next;
      element.currentTime = next;

      return true;
    }

    this.#extendDuration(session, Math.max(target, session.songs[0]?.placement?.end ?? target));

    if (!(session.mediaSource.duration >= target)) return false;
    element.currentTime = target;

    return true;
  }

  #skipGap(session: Session): void {
    const element = this.#element;
    const time = element.currentTime;

    if (session.target !== null || element.paused) return;

    if (this.#bufferedAhead(time) > BUFFERED_MARGIN) return;
    const next = this.#gapEnd(session, time);

    if (next !== null) element.currentTime = next;
  }

  #gapEnd(session: Session, time: number): number | null {
    const ranges = session.buffer?.buffered;

    if (ranges === undefined || session.removeFrom !== null) return null;

    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);

      if (start > time) return start - time <= GAP_SECONDS ? start : null;
    }

    return null;
  }

  async #nextMedia(session: Session, song: Song): Promise<Piece | null | "stale"> {
    const tail = song.tail;
    const piece = await this.#read(song);

    if (tail === null || piece === "stale") return piece;

    if (piece === null) return this.#finishLive(session, song, tail);
    const { tail: held, release } = this.#hold(tail, piece.bytes);
    song.tail = held;

    return release ?? this.#nextMedia(session, song);
  }

  async #finishLive(session: Session, song: Song, tail: HeldTail): Promise<Piece | null | "stale"> {
    const exact = await this.#exactTiming(song);

    if (exact === "stale") return "stale";
    const { timing, placement } = song;

    if (
      timing === null ||
      placement === null ||
      exact.primingSamples !== timing.primingSamples ||
      exact.sampleRate !== timing.sampleRate
    ) {
      throw new EngineFailure("decode", "The finished stream's timing differs from its estimate");
    }

    song.timing = exact;
    song.placement = placeTrack(exact, placement.start);
    song.tail = null;

    // An offset past the real end of a song whose estimate was longer: a fragmented stream from
    // there still brings its init segment (and AAC its padding), but no audio of the song. Its
    // window would end before it starts, which the buffer refuses.
    if (this.#startsPastEnd(song)) {
      this.#endSong(session, song);

      return null;
    }

    if (session.configuredFor === song && session.buffer !== null) {
      session.buffer.appendWindowEnd = song.placement.end;
    }

    return releaseAll(tail);
  }

  #startsPastEnd(song: Song): boolean {
    const { placement } = song;

    return placement !== null && placement.end <= placement.start + song.streamStart;
  }

  #endSong(session: Session, song: Song): void {
    const placement = song.placement;

    void song.reader?.cancel().catch(() => undefined);
    song.reader = null;
    song.pending = null;
    song.tail = null;
    song.complete = true;

    if (placement === null || session.songs[0] !== song) return;
    this.#shrinkDuration(session, placement.end);
    session.target = placement.end;
    this.#element.currentTime = placement.end;
  }

  #shrinkDuration(session: Session, end: number): void {
    const { mediaSource, buffer } = session;

    if (mediaSource.readyState !== "open" || buffer?.updating === true) return;
    const ranges = buffer?.buffered;

    const buffered =
      ranges === undefined || ranges.length === 0 ? 0 : ranges.end(ranges.length - 1);

    if (buffered <= end && mediaSource.duration > end) mediaSource.duration = end;
  }

  async #exactTiming(song: Song): Promise<StreamTiming | "stale"> {
    const epoch = song.epoch;
    this.#askExactTiming(song);
    const exact = song.exact;

    if (exact === null) return "stale";
    let timing: StreamTiming;

    try {
      timing = await exact;
    } catch (error) {
      if (song.epoch !== epoch) return "stale";
      song.exact = null;

      throw error;
    }

    return song.epoch === epoch ? timing : "stale";
  }

  async #nothingLeft(session: Session, song: Song): Promise<void> {
    const exact = await this.#exactTiming(song);
    const placement = song.placement;

    if (exact === "stale" || placement === null) return;
    song.timing = exact;
    song.placement = placeTrack(exact, placement.start);
    this.#endSong(session, song);
  }

  async #appendNext(session: Session, song: Song): Promise<void> {
    const pending = song.pending;
    song.pending = null;

    const piece =
      pending !== null && pending.bytes.length > 0 ? pending : await this.#nextMedia(session, song);

    if (piece === "stale") return;

    if (piece === null) {
      if (this.#cutShort(song) && this.#recover(session, song)) return;
      song.complete = true;
      song.reader = null;

      return;
    }

    const last = song.header?.index?.fragments.at(-1);
    const mediaEnd = last === undefined ? Infinity : last.offset + last.size;
    const usable = piece.bytes.subarray(0, Math.max(0, mediaEnd - piece.offset));
    const media = usable.subarray(0, MAX_APPEND_BYTES);

    if (usable.length > media.length) {
      song.pending = {
        offset: piece.offset + media.length,
        bytes: usable.subarray(media.length),
      };
    }

    const finished = song.pending === null && piece.offset + piece.bytes.length >= mediaEnd;

    if (finished && song.reader !== null) {
      void song.reader.cancel().catch(() => undefined);
      song.reader = null;
    }

    if (media.length > 0) {
      try {
        await this.#operate(session, (buffer) => {
          buffer.appendBuffer(media);
        });
        song.appended = true;
        song.recoveries = 0;
        const ranges = session.buffer?.buffered;
        const placement = song.placement;

        if (ranges !== undefined && ranges.length > 0 && placement !== null) {
          song.appendedTo = ranges.end(ranges.length - 1) - placement.start;
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
        song.pending = { offset: piece.offset, bytes: usable };
        const ahead = this.#aheadOfPlayhead();

        if (ahead < 1) {
          if (await this.#evictBehind(session, QUOTA_BEHIND_SECONDS, QUOTA_FREED_SECONDS)) return;

          throw new EngineFailure("decode", "The browser's buffer cannot hold the stream");
        }

        session.aheadLimit = Math.max(EVICT_MIN_SECONDS, ahead - 2);
        await this.#evictBehind(session, EVICT_MIN_SECONDS);
        await this.#idle(session);

        return;
      }
    }

    if (finished) song.complete = true;
  }

  #startTicker(): void {
    if (this.#ticker !== null) return;

    this.#ticker = setInterval(() => {
      this.#tick();
    }, TICK_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  #tick(): void {
    const session = this.#session;

    if (session === null) return;
    this.#holdTarget(session);
    this.#skipGap(session);
    this.#unstick();
    this.#recoverHung(session);
    const next = session.songs[1];

    if (
      next?.placement != null &&
      !next.needsReset &&
      this.#element.currentTime >= next.placement.start
    ) {
      session.songs.shift();
      this.#preloadSource = null;
      this.#emit({ type: "advanced", key: next.source.key });
    }

    this.#emit({ type: "time", positionMs: this.#positionMs() });
    session.wake();
  }

  #unstick(): void {
    const element = this.#element;
    const time = element.currentTime;
    const now = performance.now();

    if (time !== this.#moved.time || element.paused || element.seeking) {
      this.#moved = { time, at: now };

      return;
    }

    if (now - this.#moved.at < STUCK_MS || this.#bufferedAhead(time) < STUCK_AHEAD_SECONDS) return;
    this.#moved = { time, at: now };
    element.currentTime = time;
  }

  #recoverHung(session: Session): void {
    const song = session.songs[0];

    if (
      song?.reader == null ||
      song.drained ||
      this.#element.paused ||
      this.#bufferedAhead(this.#element.currentTime) > BUFFERED_MARGIN ||
      performance.now() - song.lastBytesAt < HUNG_MS
    ) {
      return;
    }

    if (!this.#recover(session, song)) {
      session.cancelled = true;
      this.#fail("network", "The stream stopped sending audio");
    }
  }

  #positionMs(): number {
    const session = this.#session;
    const start = session?.songs[0]?.placement?.start ?? 0;
    const time = session?.target ?? this.#element.currentTime;

    return Math.max(0, Math.round((time - start) * 1000));
  }

  #onEnded(): void {
    const session = this.#session;

    if (session === null) return;

    if (this.#holdTarget(session)) {
      void this.play();

      return;
    }

    this.#reachEnd(session);
  }

  #reachEnd(session: Session): void {
    if (session.endReported) return;
    session.endReported = true;
    const next = session.songs[1];

    if (next?.needsReset === true) {
      this.#preloadSource = null;
      void this.load(next.source, 0, true);
      this.#emit({ type: "advanced", key: next.source.key });
      this.#emit({ type: "time", positionMs: 0 });

      return;
    }

    this.#stopTicker();
    this.#emit({ type: "time", positionMs: this.#positionMs() });
    this.#emit({ type: "ended" });
  }

  #attach(): void {
    const element = this.#element;

    element.addEventListener("playing", () => {
      if (this.#session === null) return;
      this.#startTicker();
      this.#emit({ type: "playing" });
    });

    element.addEventListener("waiting", () => {
      if (this.#session !== null) this.#emit({ type: "waiting" });
    });

    element.addEventListener("pause", () => {
      if (this.#session === null || element.ended) return;
      this.#stopTicker();
      this.#emit({ type: "time", positionMs: this.#positionMs() });
      this.#emit({ type: "paused" });
    });

    element.addEventListener("ended", () => {
      this.#onEnded();
    });

    element.addEventListener("error", () => {
      const session = this.#session;
      const error = element.error;

      if (session === null || error === null) return;
      session.cancelled = true;
      this.#fail(elementErrorReason(error), error.message || "Playback failed");
    });
  }
}
