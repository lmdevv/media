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
 * A codec change between songs (FLAC to AAC) uses `SourceBuffer.changeType`. Browsers without it
 * finish the current song and reset the `MediaSource` for the next one, with a short gap.
 */
import type { EngineErrorReason, EngineEvent, EngineSource, PlayerEngine } from "./engine";
import { codecMimeType, HeaderRead, readHeader } from "./fmp4";
import type { AudioCodec, StreamHeader } from "./fmp4";
import { evictionEnd, fragmentAt, parseStreamTiming, placeTrack } from "./gapless-timeline";
import type { Placement, StreamTiming } from "./gapless-timeline";
import { primeInGesture } from "./prime-audio";
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
 * Largest single append. Browsers hand `fetch` chunks of any size (WebKit delivers megabytes at
 * once), and one append larger than the buffer quota could never succeed.
 */
const MAX_APPEND_BYTES = 1024 * 1024;

/** The pump re-checks the playhead at least this often while it waits. */
const IDLE_MS = 250;

/** Fewer seconds than this left in a buffered range means the playhead needs new data. */
const BUFFERED_MARGIN = 0.05;

/** Bytes of a stream and the file offset of their first byte. */
interface Piece {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** One song on the timeline and how far its stream has been appended. */
interface Song {
  readonly source: EngineSource;
  /** Where playback should begin inside the song, in seconds; only the first song uses it. */
  readonly startSeconds: number;
  /** Aborts the song's current fetch; replaced on every restart. */
  abort: AbortController;
  timing: StreamTiming | null;
  header: StreamHeader | null;
  placement: Placement | null;
  etag: string | null;
  /** Bumped whenever the song's stream restarts or stops; stale async steps then give up. */
  epoch: number;
  /** The open response body, or null before the first fetch and after a restart. */
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null;
  /** File offset of the next byte the reader yields. */
  readOffset: number;
  /** File offset to fetch from when the reader is reopened. */
  resumeFrom: number;
  /** Bytes read but not appended yet (header bytes, or a chunk the quota refused). */
  pending: Piece | null;
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
  /** Seconds to buffer ahead; lowered when the browser's buffer quota runs out first. */
  aheadLimit: number;
  cancelled: boolean;
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

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head);
  bytes.set(tail, head.length);

  return bytes;
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
    const { placement, timing, header } = song;

    if (placement === null || timing === null || header === null) return;

    const target = Math.min(
      placement.start + Math.max(0, positionMs) / 1000,
      Math.max(placement.start, placement.end - BUFFERED_MARGIN),
    );

    this.#emit({ type: "time", positionMs: Math.round((target - placement.start) * 1000) });

    if (this.#bufferedAhead(target) > BUFFERED_MARGIN) {
      this.#element.currentTime = target;

      return;
    }

    // Start over from the fragment that holds the target; every later song follows again.
    const fragment =
      header.index === null ? null : fragmentAt(header.index, timing, target - placement.start);

    for (const later of session.songs.slice(1)) this.#rewind(later, later.header?.length ?? 0);
    this.#rewind(song, fragment?.offset ?? header.length);
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
      timing: null,
      header: null,
      placement: null,
      etag: null,
      epoch: 0,
      reader: null,
      readOffset: 0,
      resumeFrom: 0,
      pending: null,
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
      aheadLimit: AHEAD_SECONDS,
      cancelled: false,
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
    song.reader = null;
  }

  /** Makes `song` append again from `offset` on, keeping its header and timing. */
  #rewind(song: Song, offset: number): void {
    song.epoch += 1;
    song.abort.abort();
    song.abort = new AbortController();
    song.reader = null;
    song.pending = null;
    song.appended = false;
    song.resumeFrom = offset;
    song.complete = false;
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

  async #evictBehind(session: Session, keep: number): Promise<boolean> {
    const ranges = session.buffer?.buffered;

    if (ranges === undefined || ranges.length === 0) return false;
    const start = ranges.start(0);
    const end = evictionEnd(start, this.#element.currentTime, keep);

    if (end === null || end - start < EVICT_MIN_SECONDS) return false;

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

    if (song.resumeFrom > 0) {
      headers.set("Range", `bytes=${song.resumeFrom}-`);

      if (song.etag !== null) headers.set("If-Range", song.etag);
    }

    let response: Response;

    try {
      response = await fetch(song.source.url, { headers, signal: song.abort.signal });
    } catch (error) {
      if (song.epoch !== epoch) return;

      throw new EngineFailure("network", error instanceof Error ? error.message : String(error));
    }

    if (song.epoch !== epoch) {
      void response.body?.cancel().catch(() => undefined);

      return;
    }

    if (!response.ok || response.body === null) {
      throw new EngineFailure("unsupported", `The stream answered ${response.status}`);
    }

    const timing = parseStreamTiming((name) => response.headers.get(name));

    if (timing === null) {
      throw new EngineFailure("unsupported", "The stream has no sample timing headers");
    }

    song.timing ??= timing;
    song.etag = response.headers.get("ETag");
    song.reader = response.body.getReader();
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

    if (result.done) return null;
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

    if (piece === null) throw new EngineFailure("unsupported", "The stream ended early");
    const bytes = song.pending === null ? piece.bytes : concat(song.pending.bytes, piece.bytes);
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
    song.header = header;
    song.placement = placeTrack(timing, previous?.placement?.end ?? 0);

    const fragment =
      song.startSeconds > 0 && header.index !== null
        ? fragmentAt(header.index, timing, song.startSeconds)
        : null;

    if (fragment !== null && fragment.offset > header.length) {
      // Start the first song at its position without downloading what comes before it.
      this.#rewind(song, fragment.offset);

      return;
    }

    song.resumeFrom = header.length;
    song.pending = { offset: header.length, bytes: bytes.subarray(header.length) };
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

    const buffer = session.buffer;

    // A stream stopped mid-fragment leaves the parser inside a segment; start it afresh.
    if (session.mediaSource.readyState === "open") buffer.abort();
    // Widen first: the window must stay valid (start < end) after every assignment.
    buffer.appendWindowEnd = Infinity;
    buffer.appendWindowStart = placement.start;
    buffer.appendWindowEnd = placement.end;
    buffer.timestampOffset = placement.timestampOffset;
    await this.#operate(session, (target) => {
      target.appendBuffer(header.init);
    });
    session.configuredFor = song;
  }

  /** Appends the next chunk of `song`, and marks it complete after its last fragment. */
  async #appendNext(session: Session, song: Song): Promise<void> {
    const pending = song.pending;
    song.pending = null;
    const piece = pending !== null && pending.bytes.length > 0 ? pending : await this.#read(song);

    if (piece === "stale") return;

    if (piece === null) {
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
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;

        // Nothing to play out and evict: the stream can never fit.
        if (this.#aheadOfPlayhead() < 1) {
          throw new EngineFailure("decode", "The browser's buffer cannot hold the stream");
        }

        // The buffer is full: free what lies behind the playhead, and buffer less far ahead from
        // now on so the pump waits for the playhead instead of retrying.
        song.pending = { offset: piece.offset, bytes: usable };
        session.aheadLimit = Math.max(EVICT_MIN_SECONDS, this.#aheadOfPlayhead() - 2);
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

  #positionMs(): number {
    const start = this.#session?.songs[0]?.placement?.start ?? 0;

    return Math.max(0, Math.round((this.#element.currentTime - start) * 1000));
  }

  /** The element reached the end: switch codecs the slow way, or report the end. */
  #onEnded(): void {
    const session = this.#session;

    if (session === null) return;
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
