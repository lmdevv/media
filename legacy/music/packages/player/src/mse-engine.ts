/**
 * The gapless engine: every song is a fragmented MP4 stream (`fmp4-flac` or `fmp4-aac`) appended
 * into one `SourceBuffer` of one `MediaSource`, laid end to end on a single timeline. Each song's
 * `timestampOffset` shifts its encoder priming in front of its slot and the append window cuts
 * priming and padding, so the decoder plays one continuous stream with no gap and no overlap.
 *
 * One pump appends at a time, in song order: the current song, then the preloaded one. It reads
 * each response as it streams, stays at most `AHEAD_SECONDS` ahead of the playhead (the HTTP
 * stream waits meanwhile; less when the browser's buffer quota runs out first, as Firefox's does
 * for hi-res FLAC), and evicts what lies more than `BEHIND_SECONDS` behind it. Seeking
 * outside the buffer drops everything and restarts the song from the fragment the `sidx` points
 * at with a range request.
 *
 * A song the media service is still transcoding arrives as it is encoded, with an estimated
 * length and no `sidx` (see `StreamTimingHeader.estimated`). The engine appends it as it comes
 * but holds back its last two fragments (`held-tail.ts`); when the stream ends it asks for the
 * exact length, narrows the append window, and only then appends the end. Seeking outside the
 * buffer of such a song (or loading it part-way) opens a stream the media service encodes from
 * the target at once (`&start=`, see `stream-offset.ts`): its fragments sit on the song's own
 * timeline, so they append at the song's usual place, behind their own init segment and an append
 * window that starts at the stream's first sample. The exact length then comes from the full
 * transcode, which a `HEAD` request asks for as soon as the offset stream opens.
 *
 * A stream cut off before its song's end (dropped, ended early, or silent while the playhead
 * waits) is picked up where its appends stopped, the same way as a seek, up to
 * `MAX_RECOVERIES` times in a row without progress. A stream the media service is too busy to
 * start (`503`) is asked for again after its `Retry-After` (see `busy-retry.ts`).
 *
 * A codec change between songs (FLAC to AAC) uses `SourceBuffer.changeType`. Browsers without it
 * finish the current song and reset the `MediaSource` for the next one, with a short gap.
 */
import { delay, MAX_BUSY_RETRIES, retryAfterMs } from "./busy-retry";
import type { EngineErrorReason, EngineEvent, EngineSource, PlayerEngine } from "./engine";
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

/** How often the engine emits `time` and checks for a song boundary while playing. */
const TICK_MS = 100;

/** Seconds buffered ahead of the playhead before the pump waits. */
const AHEAD_SECONDS = 30;

/** Seconds kept behind the playhead; older audio is evicted. */
const BEHIND_SECONDS = 30;

/** Evict only when at least this much can go, so removals stay rare. */
const EVICT_MIN_SECONDS = 5;

/**
 * Seconds kept behind the playhead when the buffer is full and less than a second is left to
 * play: everything older goes, so the append the playhead waits for fits.
 */
const QUOTA_BEHIND_SECONDS = 1;

/**
 * Least that freeing the buffer behind the playhead must remove to count, when it is full and
 * less than a second is left to play. Removing the few milliseconds just played would only
 * repeat the failing append until the playhead stalls.
 */
const QUOTA_FREED_SECONDS = 1;

/**
 * Largest single append. Browsers hand `fetch` chunks of any size (WebKit delivers megabytes at
 * once), and one append larger than the buffer quota could never succeed.
 */
const MAX_APPEND_BYTES = 1024 * 1024;

/** The pump re-checks the playhead at least this often while it waits. */
const IDLE_MS = 250;

/** Fewer seconds than this left in a buffered range means the playhead needs new data. */
const BUFFERED_MARGIN = 0.05;

/**
 * A song still being transcoded restarts from its beginning instead of from an offset when asked
 * for a position this close to it: a load that took a moment, or a seek back to the start.
 */
const LIVE_RESTART_SECONDS = 2;

/**
 * A stream that has sent nothing for this long while the playhead waits for it is hung: a proxy
 * or a dying ffmpeg can keep a connection open without data.
 */
const HUNG_MS = 8000;

/**
 * A playing element whose time has not moved for this long while it has `STUCK_AHEAD_SECONDS`
 * buffered ahead is stuck; seeking it in place gets it going again (seen in Firefox right after
 * a stream was picked up).
 */
const STUCK_MS = 3000;

/** Seconds buffered ahead of a still playhead that rule out waiting for data. */
const STUCK_AHEAD_SECONDS = 1;

/** Pickups of a cut-off stream in a row, without a successful append, before the song fails. */
const MAX_RECOVERIES = 3;

/** The media service's answer to a signed URL it refuses, such as an expired one. */
const FORBIDDEN = 403;

/** A playhead this close to a seek target is at it. */
const TARGET_TOLERANCE = 0.01;

/**
 * The playhead jumps a hole in the buffer at most this long when it waits at one. An append
 * window cuts whole AAC frames, so a song's first buffered sample can sit a frame after its
 * start, and a stream picked up from an offset replaces the frame it overlaps whole, on a frame
 * grid of its own; some browsers wait at such a hole forever.
 */
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
  wake: () => void;
}

/** A failure that stops the current song, with the reason the engine reports. */
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
  /** The source `preload` asked for, kept across a `load` that arrives later. */
  #preloadSource: EngineSource | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** The playhead the ticker last saw move, and when (`performance.now()`). */
  #moved = { time: 0, at: 0 };
  /** Settles the pending `load` as superseded. */
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

    const song = this.#song(source, startMs / 1000);
    session.songs.push(song);

    if (this.#preloadSource !== null && this.#preloadSource.url !== source.url) {
      session.songs.push(this.#song(this.#preloadSource, 0));
    }

    const ready = await this.#whenPlayable(session, song);

    if (!ready || session !== this.#session) return;
    this.#emit({ type: "time", positionMs: startMs });

    if (autoplay) await this.play();
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
    // Playing again after the end (the element starts over) ends again.
    this.#session.endReported = false;

    try {
      await this.#element.play();
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;

      // A later load, seek, or pause interrupted this play; that caller owns the outcome.
      if (error.name === "AbortError") return;

      if (error.name === "NotAllowedError") {
        this.#fail("autoplay-blocked", "The browser blocked playback until you tap play");

        return;
      }

      if (this.#element.error === null) this.#fail("unsupported", error.message);
    }
  }

  pause(): void {
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

    this.#emit({ type: "time", positionMs: Math.round((target - placement.start) * 1000) });
    session.target = target;
    session.endReported = false;
    // A queued song lies past the duration its appends have reached so far, and the element cuts
    // a seek beyond the duration short. When an append runs meanwhile, `#holdTarget` retries.
    this.#extendDuration(session, placement.end);

    if (this.#bufferedAhead(target) > BUFFERED_MARGIN) {
      this.#element.currentTime = target;

      return;
    }

    // Start over from the fragment that holds the target; every later song follows again.
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

  /** Replaces the element's source with a new `MediaSource` and starts its pump. */
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
    // Loading an empty source stops output without a `pause` event that could reach the next
    // session's listeners.
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

  /** Makes `song` append again from `offset` on, keeping its header and timing. */
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

  /**
   * Makes `song` append again from `seconds` into it, choosing where its bytes come from: the
   * fragment its index points at in the finished file, a stream the media service encodes from
   * that point for a song still being transcoded, or the whole stream again near its start (or
   * when the media service ignores offsets). Every jump inside a song goes through here.
   */
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

  /**
   * Picks up a cut-off stream where the song's appends stopped, without moving the playhead.
   * Returns false when the song cannot be picked up: too many tries in a row, or a stream still
   * being transcoded from a media service without offsets.
   */
  #recover(session: Session, song: Song): boolean {
    if (song.recoveries >= MAX_RECOVERIES || (song.header?.index == null && song.offsetsIgnored)) {
      return false;
    }

    song.recoveries += 1;
    this.#restartAt(song, song.appendedTo);
    session.wake();

    return true;
  }

  /** True when a stream that just ended stopped short of its song's end. */
  #cutShort(song: Song): boolean {
    const placement = song.placement;

    return (
      placement !== null &&
      endedEarly(song.appendedTo * 1000, (placement.end - placement.start) * 1000)
    );
  }

  /**
   * Starts asking for the song's exact timing, unless that is known or asked for already. The
   * `HEAD` request waits for the full transcode and keeps it running meanwhile, so the answer is
   * usually there by the time an offset stream reaches its end.
   */
  #askExactTiming(song: Song): void {
    if (song.exact !== null || song.timing?.estimated === false) return;

    const exact = this.#fetchExactTiming(song.source.url, song.exactAbort.signal);

    // Awaited only when a stream ends; a song dropped before that leaves it unobserved.
    exact.catch(() => undefined);
    song.exact = exact;
  }

  /** Reads the exact timing of the finished transcode at `url` with a `HEAD` request. */
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

  /** Drops a queued song: stops its stream and removes whatever of it was buffered. */
  #discard(session: Session, song: Song): void {
    this.#stopReading(song);

    if (song.placement !== null && (song.complete || song.appended)) {
      session.removeFrom = Math.min(session.removeFrom ?? Infinity, song.placement.start);
    }

    if (session.configuredFor === song) session.configuredFor = null;
  }

  /**
   * The listener skipped ahead to the song that is already queued on the timeline: drop the
   * current song and seek into the queued one instead of fetching it again.
   */
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

  /** Resolves true once the first song can play at its start position. */
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

  /** Seconds buffered from `time` to the end of the range holding it (0 when unbuffered). */
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

  /**
   * Seconds buffered ahead of the playhead, counting a range that starts after it: before the
   * first song reaches its start position, the playhead still sits at 0.
   */
  #aheadOfPlayhead(): number {
    const ranges = this.#session?.buffer?.buffered;
    const time = this.#element.currentTime;

    if (ranges === undefined) return 0;

    for (let index = 0; index < ranges.length; index += 1) {
      if (time < ranges.end(index)) return ranges.end(index) - time;
    }

    return 0;
  }

  /**
   * Appends songs until the session closes, one step at a time. A failing queued song is dropped
   * (the current one then ends and the provider moves on); a failing current song stops the
   * session with an error.
   */
  async #pump(session: Session): Promise<void> {
    await this.#opened(session);
    this.#continuePump(session);
  }

  /** Schedules the next pump step; each step schedules its successor, so nothing accumulates. */
  #continuePump(session: Session): void {
    void this.#pumpStep(session).then((more) => {
      if (more && !isCancelled(session)) this.#continuePump(session);

      return undefined;
    });
  }

  /** Runs one pump step. Resolves false once the session should stop. */
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

      // The song was dropped or restarted while this step ran; its failure no longer matters.
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

  /** Waits for a wake-up (seek, preload, playhead progress) or `IDLE_MS`. */
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

  /** Runs one buffer operation and waits for it to finish. */
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

  /**
   * Removes what lies more than `keep` seconds behind the playhead, when at least `atLeast`
   * seconds can go. Resolves whether it removed anything.
   */
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

  /** Calls `endOfStream` once nothing more can be appended, so the element reaches `ended`. */
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

    // A seek past a song's real end left nothing to play from its target: Chromium ends there,
    // but Firefox waits at it for good.
    if (target !== null && bufferedEnd <= target + BUFFERED_MARGIN) this.#reachEnd(session);
  }

  /** Advances one song's stream by one step: open, read the header, configure, or append. */
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

    // Whole milliseconds at or before the position, so the stream starts no later than it.
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
      // Every seek transcode is taken; one frees up shortly. The next step opens it again.
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

    // A live stream's estimate gives way to whatever comes next: the exact timing of the
    // finished file, or of the `HEAD` request at the end of the stream.
    if (song.timing === null || song.timing.estimated) song.timing = timing;

    const startSamples =
      from === null ? null : parseStreamStart((name) => response.headers.get(name));

    if (from !== null && startSamples === null) {
      // A media service without offsets sent the whole song; the playhead waits for it.
      song.offsetsIgnored = true;
      song.fromSeconds = null;
    }

    song.busyRetries = 0;
    song.streamStart = startSamples === null ? 0 : startSamples / timing.sampleRate;
    song.etag = response.headers.get("ETag");
    song.reader = response.body.getReader();
    song.drained = false;
    song.lastBytesAt = performance.now();
    // A 200 answer to a range request starts at byte 0; the extra bytes are skipped on read.
    song.readOffset = response.status === 206 ? song.resumeFrom : 0;
  }

  /**
   * Reads the next bytes at or after `resumeFrom`, null at the end of the stream, or `stale` when
   * the song restarted or stopped meanwhile.
   */
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

    // A server that ignored the range request sends the bytes before `resumeFrom` too.
    if (song.readOffset <= song.resumeFrom) return this.#read(song);

    return offset >= song.resumeFrom
      ? { offset, bytes }
      : { offset: song.resumeFrom, bytes: bytes.subarray(song.resumeFrom - offset) };
  }

  async #readHeader(session: Session, song: Song): Promise<void> {
    const piece = await this.#read(song);

    if (piece === "stale") return;

    if (piece === null) {
      // An offset past the song's real end: nothing is left of it.
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
    // A song fetched again keeps its place on the timeline.
    song.placement = placeTrack(timing, song.placement?.start ?? previous?.placement?.end ?? 0);

    // Every stream brings its own init segment: an offset stream's encode may differ.
    if (session.configuredFor === song) session.configuredFor = null;

    if (
      current &&
      header.index === null &&
      song.streamStart === 0 &&
      song.startSeconds >= LIVE_RESTART_SECONDS &&
      !song.offsetsIgnored
    ) {
      // Still being transcoded: start at the load position instead of waiting for the encoder.
      this.#restartAt(song, song.startSeconds);

      return;
    }

    if (current && song.streamStart > song.startSeconds) {
      // The offset stream begins a fraction of a sample after the position asked for.
      const start = song.placement.start + song.streamStart;
      song.startSeconds = song.streamStart;

      if (session.target !== null && session.target < start) session.target = start;
    }

    const fragment =
      song.startSeconds > 0 && header.index !== null
        ? fragmentAt(header.index, timing, song.startSeconds)
        : null;

    if (fragment !== null && fragment.offset > header.length) {
      // Start the first song at its position without downloading what comes before it.
      this.#rewind(song, fragment.offset);

      return;
    }

    // Without an index the stream plays in from its start, so the playhead waits at the position
    // meanwhile: the look-ahead then counts from there instead of stopping short of it. A seek
    // into an offset stream has placed it already, and a pickup leaves it where it plays.
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

  /** Adds bytes to a held tail; the release goes to `pending`, ahead of anything read later. */
  #hold(
    tail: HeldTail,
    bytes: Uint8Array,
  ): { readonly tail: HeldTail; readonly release: Piece | null } {
    const step = addToTail(tail, bytes);

    if (TailStep.$is("Invalid")(step)) throw new EngineFailure("unsupported", step.reason);

    return step;
  }

  /** Points the buffer at `song`: codec, append window, offset, and init segment. */
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

    // A stream stopped mid-fragment leaves the parser inside a segment; start it afresh.
    if (session.mediaSource.readyState === "open") buffer.abort();
    // Widen first: the window must stay valid (start < end) after every assignment.
    buffer.appendWindowEnd = Infinity;
    // An offset stream's encoder priming lies before its first sample; it must not overwrite
    // audio already buffered there.
    buffer.appendWindowStart = placement.start + song.streamStart;
    // A live stream's end is cut once its exact length is known (`#finishLive`).
    buffer.appendWindowEnd = song.timing?.estimated === true ? Infinity : placement.end;
    buffer.timestampOffset = placement.timestampOffset;
    await this.#operate(session, (target) => {
      target.appendBuffer(header.init);
    });
    session.configuredFor = song;
    // Appends only stretch the duration to what is buffered; a seek must reach the whole song.
    this.#extendDuration(session, placement.end);
  }

  /** Raises the media source's duration to `end` unless it is longer already or busy. */
  #extendDuration(session: Session, end: number): void {
    const { mediaSource, buffer } = session;

    if (mediaSource.readyState !== "open" || buffer?.updating === true) return;

    if (Number.isNaN(mediaSource.duration) || mediaSource.duration < end) {
      mediaSource.duration = end;
    }
  }

  /**
   * Keeps the playhead at the last seek target until it plays from there, and tells whether it
   * moved the playhead. Left alone, the element waits silently wherever it sits: short of a
   * target past the media source's duration, where it cut the seek, or just before data that
   * starts a little after the target.
   */
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

  /** Moves a playing playhead that waits at a short hole in the buffer to the audio after it. */
  #skipGap(session: Session): void {
    const element = this.#element;
    const time = element.currentTime;

    if (session.target !== null || element.paused) return;

    if (this.#bufferedAhead(time) > BUFFERED_MARGIN) return;
    const next = this.#gapEnd(session, time);

    if (next !== null) element.currentTime = next;
  }

  /**
   * Where the audio after a hole of at most `GAP_SECONDS` at `time` starts, or null when there is
   * none. A pending removal clears whatever lies ahead; the refetch then covers it.
   */
  #gapEnd(session: Session, time: number): number | null {
    const ranges = session.buffer?.buffered;

    if (ranges === undefined || session.removeFrom !== null) return null;

    for (let index = 0; index < ranges.length; index += 1) {
      const start = ranges.start(index);

      if (start > time) return start - time <= GAP_SECONDS ? start : null;
    }

    return null;
  }

  /**
   * The next media bytes to append: what the stream yields, or for a live stream what its held
   * tail releases. At the end of a live stream, the exact timing first, then the held rest.
   */
  async #nextMedia(session: Session, song: Song): Promise<Piece | null | "stale"> {
    const tail = song.tail;
    const piece = await this.#read(song);

    if (tail === null || piece === "stale") return piece;

    if (piece === null) return this.#finishLive(session, song, tail);
    const { tail: held, release } = this.#hold(tail, piece.bytes);
    song.tail = held;

    return release ?? this.#nextMedia(session, song);
  }

  /**
   * A live stream ended, so its transcode is in the media service's cache: reads the exact timing
   * with a `HEAD` request, cuts the append window at the real end, and releases the held tail.
   */
  async #finishLive(session: Session, song: Song, tail: HeldTail): Promise<Piece | null | "stale"> {
    const exact = await this.#exactTiming(song);

    if (exact === "stale") return "stale";
    const { timing, placement } = song;

    // What is appended already was placed with the expected priming and rate.
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

  /** True when the open stream of `song` starts at or after the song's end. */
  #startsPastEnd(song: Song): boolean {
    const { placement } = song;

    return placement !== null && placement.end <= placement.start + song.streamStart;
  }

  /**
   * Ends `song` at its placement's end with nothing more appended, and moves a current song's
   * playhead there, so the next song plays or the queue ends.
   */
  #endSong(session: Session, song: Song): void {
    const placement = song.placement;

    void song.reader?.cancel().catch(() => undefined);
    song.reader = null;
    song.pending = null;
    song.tail = null;
    song.complete = true;

    if (placement === null || session.songs[0] !== song) return;
    // A seek may have stretched the duration to the song's estimated end; the element would play
    // on to it, and report the end there.
    this.#shrinkDuration(session, placement.end);
    session.target = placement.end;
    this.#element.currentTime = placement.end;
  }

  /** Lowers the media source's duration to `end`, unless audio is buffered past it or it is busy. */
  #shrinkDuration(session: Session, end: number): void {
    const { mediaSource, buffer } = session;

    if (mediaSource.readyState !== "open" || buffer?.updating === true) return;
    const ranges = buffer?.buffered;

    const buffered =
      ranges === undefined || ranges.length === 0 ? 0 : ranges.end(ranges.length - 1);

    if (buffered <= end && mediaSource.duration > end) mediaSource.duration = end;
  }

  /**
   * The song's exact timing from the media service once its transcode has finished, or `stale`
   * when the song restarted or stopped meanwhile.
   */
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
      // A later stream asks again.
      song.exact = null;

      throw error;
    }

    return song.epoch === epoch ? timing : "stale";
  }

  /**
   * An offset stream came back empty: the song ends before the offset. Places its exact end and
   * moves the playhead there, so the next song plays or the queue ends.
   */
  async #nothingLeft(session: Session, song: Song): Promise<void> {
    const exact = await this.#exactTiming(song);
    const placement = song.placement;

    if (exact === "stale" || placement === null) return;
    song.timing = exact;
    song.placement = placeTrack(exact, placement.start);
    this.#endSong(session, song);
  }

  /** Appends the next chunk of `song`, and marks it complete after its last fragment. */
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

    // Bytes after the last indexed fragment (ffmpeg's `mfra`) are not media.
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
      // Only ffmpeg's trailing index is left; close the response.
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

        // Appends go in song order, so the last range ends with this song's audio.
        if (ranges !== undefined && ranges.length > 0 && placement !== null) {
          song.appendedTo = ranges.end(ranges.length - 1) - placement.start;
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
        song.pending = { offset: piece.offset, bytes: usable };
        const ahead = this.#aheadOfPlayhead();

        if (ahead < 1) {
          // The playhead is about to wait for this append. Free all but the last moment behind
          // it (up to `BEHIND_SECONDS` can be there) and append again on the next step; only a
          // buffer with nothing behind to free and nothing ahead to play out can never fit it.
          if (await this.#evictBehind(session, QUOTA_BEHIND_SECONDS, QUOTA_FREED_SECONDS)) return;

          throw new EngineFailure("decode", "The browser's buffer cannot hold the stream");
        }

        // The buffer is full of audio still to play: free what lies behind the playhead, and
        // buffer less far ahead from now on so the pump waits for the playhead instead of
        // retrying.
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

  /** Emits the position, crosses song boundaries, and lets the pump see the playhead move. */
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

  /** Seeks a playing element in place when its time stands still with audio buffered ahead. */
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

  /** Picks up the current song's stream when it has sent nothing for a while the playhead waits. */
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

  /** The position in the current song: the seek target until the playhead plays from there. */
  #positionMs(): number {
    const session = this.#session;
    const start = session?.songs[0]?.placement?.start ?? 0;
    const time = session?.target ?? this.#element.currentTime;

    return Math.max(0, Math.round((time - start) * 1000));
  }

  /** The element reached the end: switch codecs the slow way, or report the end. */
  #onEnded(): void {
    const session = this.#session;

    if (session === null) return;

    // The element ended at a duration that cut a seek short; play from the target instead.
    if (this.#holdTarget(session)) {
      void this.play();

      return;
    }

    this.#reachEnd(session);
  }

  /** The timeline played out: switch codecs the slow way, or report the end, once. */
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
      // `ended` also pauses the element; that case is reported as ended or advanced instead.
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
