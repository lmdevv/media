import { delay, MAX_BUSY_RETRIES } from "./busy-retry";
import type { EngineErrorReason, EngineEvent, EngineSource, PlayerEngine } from "./engine";
import { primeInGesture } from "./prime-audio";
import { endedEarly, OffsetProbe, offsetUrl, probeOffset } from "./stream-offset";

/** How often the engine emits `time` while playing (5 Hz; the contract asks for at least 4). */
const TIME_INTERVAL_MS = 200;

/**
 * A live stream starts from its beginning instead of from an offset when asked for a position
 * this close to it: a load that took a moment, or a seek back to the start.
 */
const LIVE_RESTART_MS = 2000;

/**
 * A playing stream whose time has not moved for this long, while the element says it has data,
 * is stuck: Safari keeps "playing" in silence at the end of a stream that was cut off.
 */
const STALL_MS = 3000;

/** The same, while the element waits for data, which a slow network explains for a while. */
const WAITING_STALL_MS = 8000;

/** How long a reopened stream may take to become playable before it counts as failed. */
const REOPEN_TIMEOUT_MS = 15_000;

/** Reopenings in a row that may fail to get playback going again before the engine gives up. */
const MAX_RECOVERIES = 3;

/** Playback this far past where a recovery reopened the stream means it worked. */
const RECOVERED_MS = 2000;

/** A reopening of the stream at another position, waiting for it to play. */
interface Reopening {
  /** Where playback resumes; later seeks move it. */
  positionMs: number;
  /** Whether playback resumes playing; `play` and `pause` change it meanwhile. */
  play: boolean;
  /** Cancels what the reopening waits for. */
  readonly abort: AbortController;
}

/** When the current stream last showed progress, for spotting one that stopped. */
interface Watch {
  readonly currentTime: number;
  readonly at: number;
}

/** One of the two audio elements and the source it holds. */
interface Slot {
  readonly element: HTMLAudioElement;
  source: EngineSource | null;
  reopening: Reopening | null;
  /**
   * Where in the song the element's stream starts, in milliseconds: 0 for the song's own URL,
   * the offset for a stream opened part-way (`&start=`). Song position is this plus the
   * element's `currentTime`.
   */
  startMs: number;
  /** The element plays a stream of unknown length (see `isLive`); known from its metadata. */
  live: boolean;
  watch: Watch | null;
  /** Recoveries since playback last got going again, and where the last one reopened. */
  recoveries: number;
  recoveredAtMs: number;
  /**
   * Reopenings in a row that failed while the media service was busy or had audio there, each
   * opened again (see `#settleFailure`).
   */
  retries: number;
}

/**
 * True when `element` plays a stream of unknown length: a transcode the media service sends while
 * ffmpeg still writes it, or one from an offset. Browsers cannot seek in one (Firefox and Safari
 * ignore the seek).
 */
const isLive = (element: HTMLAudioElement): boolean =>
  element.readyState >= HTMLMediaElement.HAVE_METADATA &&
  element.duration === Number.POSITIVE_INFINITY;

const errorReason = (error: MediaError | null): EngineErrorReason => {
  if (error?.code === MediaError.MEDIA_ERR_NETWORK) return "network";

  if (error?.code === MediaError.MEDIA_ERR_DECODE) return "decode";

  return "unsupported";
};

/**
 * A `PlayerEngine` on two `HTMLAudioElement`s. The idle element preloads the next source; when
 * the current one ends, the engine starts the idle one from the `ended` handler and swaps roles.
 * The gap is whatever the browser needs to start a primed element (tens of milliseconds), so this
 * is "nearly gapless", not sample-accurate.
 *
 * A song the media service is still transcoding arrives as a live stream that plays at once but
 * cannot be sought in. A seek in one (or a load that starts past `LIVE_RESTART_MS`) opens the
 * song again from that position (`&start=`), which the service encodes from there at once; song
 * position is then the offset plus the element's time.
 *
 * A live stream can also stop before the song does: a proxy closes a connection the browser has
 * not read from in a while, or ffmpeg dies. The engine notices (an `ended` short of the song's
 * length, an `error`, or time that stops moving while playing, which is all Safari shows) and
 * reopens the song where it stopped. When that keeps failing it asks the service whether any
 * audio is left there: none means the song is over. A service busy with other seeks (`503`) is
 * asked again after its `Retry-After`, a few times; anything else is reported as an error.
 */
export class HtmlAudioEngine implements PlayerEngine {
  readonly #slots: readonly [Slot, Slot];
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #current = 0;
  #volume = 1;
  /** Bumped by every `load` and `unload`, so a superseded load stops quietly. */
  #generation = 0;
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** Settles the pending `load` as superseded. */
  #cancelLoad: (() => void) | null = null;

  /**
   * @param createElement - Makes each audio element. Pass a factory to route output through Web
   *   Audio (a visualizer, an equalizer, or a capture-based gap measurement).
   */
  constructor(createElement: () => HTMLAudioElement = () => new Audio()) {
    this.#slots = [this.#emptySlot(createElement()), this.#emptySlot(createElement())];

    for (const slot of this.#slots) this.#attach(slot);
  }

  /** Loads `source` into the current element, seeks to `startMs`, and plays when `autoplay`. */
  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    this.#cancelLoad?.();
    const generation = this.#generation;
    const idle = this.#idleSlot();

    // The listener skipped ahead to the song that was already preloaded: reuse its buffer.
    if (idle.source?.url === source.url) {
      this.#release(this.#currentSlot());
      this.#current = 1 - this.#current;
    } else {
      const slot = this.#currentSlot();
      this.#release(slot);
      slot.element.preload = "auto";
      slot.element.src = source.url;
      slot.element.load();
    }

    const slot = this.#currentSlot();
    slot.source = source;
    const ready = await this.#whenReady(slot.element);

    if (generation !== this.#generation || !ready) return;

    if (slot.live && startMs >= LIVE_RESTART_MS) {
      this.#emit({ type: "time", positionMs: startMs });

      if (!autoplay) this.#emit({ type: "paused" });
      await this.#reopen(slot, {
        positionMs: startMs,
        play: autoplay,
        abort: new AbortController(),
      });

      return;
    }

    const start = slot.live ? 0 : startMs;

    if (start > 0) slot.element.currentTime = start / 1000;
    this.#emit({ type: "time", positionMs: start });

    if (autoplay) await this.play();
    else this.#emit({ type: "paused" });
  }

  /** Buffers `source` in the idle element so it can start the moment the current one ends. */
  preload(source: EngineSource | null): void {
    const idle = this.#idleSlot();

    if (source === null) {
      this.#release(idle);

      return;
    }

    if (idle.source?.url === source.url) return;
    this.#release(idle);
    idle.source = source;
    idle.element.preload = "auto";
    idle.element.src = source.url;
    idle.element.load();
  }

  /** Starts output. Emits `autoplay-blocked` when the browser wants a user gesture first. */
  async play(): Promise<void> {
    const slot = this.#currentSlot();
    const reopening = slot.reopening;

    if (reopening !== null) {
      if (reopening.play) return;
      reopening.play = true;
      this.#emit({ type: "waiting" });

      return;
    }

    if (slot.source !== null) await this.#start(slot);
  }

  pause(): void {
    const slot = this.#currentSlot();
    const reopening = slot.reopening;

    if (reopening === null) {
      slot.element.pause();

      return;
    }

    // The element is paused already, so it reports nothing.
    if (!reopening.play) return;
    reopening.play = false;
    this.#emit({ type: "time", positionMs: reopening.positionMs });
    this.#emit({ type: "paused" });
  }

  seek(positionMs: number): void {
    const slot = this.#currentSlot();

    if (slot.source === null) return;

    if (slot.reopening !== null) slot.reopening.positionMs = positionMs;
    else if (slot.live) {
      const play = !slot.element.paused;

      void this.#reopen(slot, { positionMs, play, abort: new AbortController() });
    } else slot.element.currentTime = positionMs / 1000;

    this.#emit({ type: "time", positionMs });
  }

  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));

    for (const slot of this.#slots) slot.element.volume = this.#volume;
  }

  unlock(): void {
    for (const slot of this.#slots) {
      if (slot.source === null && slot.element.paused) primeInGesture(slot.element);
    }
  }

  unload(): void {
    this.#generation += 1;
    this.#cancelLoad?.();
    this.#stopTicker();

    for (const slot of this.#slots) this.#release(slot);
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emptySlot(element: HTMLAudioElement): Slot {
    return {
      element,
      source: null,
      reopening: null,
      startMs: 0,
      live: false,
      watch: null,
      recoveries: 0,
      recoveredAtMs: 0,
      retries: 0,
    };
  }

  #currentSlot(): Slot {
    return this.#current === 0 ? this.#slots[0] : this.#slots[1];
  }

  #idleSlot(): Slot {
    return this.#current === 0 ? this.#slots[1] : this.#slots[0];
  }

  #isCurrent(slot: Slot): boolean {
    return this.#currentSlot() === slot;
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #release(slot: Slot): void {
    slot.reopening?.abort.abort();
    slot.reopening = null;
    slot.source = null;
    slot.startMs = 0;
    slot.live = false;
    slot.watch = null;
    slot.recoveries = 0;
    slot.recoveredAtMs = 0;
    slot.retries = 0;
    slot.element.pause();
    slot.element.removeAttribute("src");
    // Loading an empty source aborts the download and frees the decoder.
    slot.element.load();
  }

  /**
   * Resolves true once `element` can start, or false when it failed or a newer load won, and with
   * `limit`, after `limit.ms` or once `limit.signal` aborts.
   */
  #whenReady(
    element: HTMLAudioElement,
    limit?: { readonly ms: number; readonly signal: AbortSignal },
  ): Promise<boolean> {
    if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(true);

    return new Promise((resolve) => {
      const settle = (ready: boolean): void => {
        element.removeEventListener("canplay", onReady);
        element.removeEventListener("error", onFail);
        limit?.signal.removeEventListener("abort", onFail);
        clearTimeout(timer);

        if (this.#cancelLoad === onFail) this.#cancelLoad = null;
        resolve(ready);
      };

      const onReady = (): void => {
        settle(true);
      };

      const onFail = (): void => {
        settle(false);
      };

      const timer = limit === undefined ? undefined : setTimeout(onFail, limit.ms);

      element.addEventListener("canplay", onReady);
      element.addEventListener("error", onFail);
      limit?.signal.addEventListener("abort", onFail, { once: true });
      this.#cancelLoad = onFail;
    });
  }

  #positionOf(slot: Slot): number {
    return slot.reopening?.positionMs ?? slot.startMs + Math.round(slot.element.currentTime * 1000);
  }

  #positionMs(): number {
    return this.#positionOf(this.#currentSlot());
  }

  #startTicker(): void {
    if (this.#ticker !== null) return;

    this.#ticker = setInterval(() => {
      this.#watch(this.#currentSlot());
      this.#emit({ type: "time", positionMs: this.#positionMs() });
    }, TIME_INTERVAL_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  /** Checks that a playing live stream still makes progress, and recovers one that stopped. */
  #watch(slot: Slot): void {
    const { element } = slot;

    if (slot.source === null || slot.reopening !== null || !slot.live) return;

    if (element.paused || element.seeking || element.ended) {
      slot.watch = null;

      return;
    }

    const now = performance.now();

    if (slot.watch === null || slot.watch.currentTime !== element.currentTime) {
      slot.watch = { currentTime: element.currentTime, at: now };

      if (this.#positionOf(slot) > slot.recoveredAtMs + RECOVERED_MS) slot.recoveries = 0;

      return;
    }

    const limit =
      element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ? STALL_MS : WAITING_STALL_MS;

    if (now - slot.watch.at >= limit) void this.#recover(slot, true);
  }

  #attach(slot: Slot): void {
    const { element } = slot;

    element.addEventListener("loadedmetadata", () => {
      // A stream from an offset is live even when all of it arrived before its metadata.
      slot.live = slot.startMs > 0 || isLive(element);
    });

    element.addEventListener("playing", () => {
      if (!this.#isCurrent(slot)) return;
      this.#startTicker();
      this.#emit({ type: "playing" });
    });

    element.addEventListener("waiting", () => {
      if (this.#isCurrent(slot) && slot.source !== null && slot.reopening === null) {
        this.#emit({ type: "waiting" });
      }
    });

    element.addEventListener("pause", () => {
      // `ended` also pauses the element; that case is reported as ended or advanced instead. A
      // reopening pauses it too, and reports for itself.
      if (!this.#isCurrent(slot) || slot.source === null || slot.reopening !== null) return;

      if (element.ended) return;
      this.#stopTicker();
      this.#emit({ type: "time", positionMs: this.#positionMs() });
      this.#emit({ type: "paused" });
    });

    element.addEventListener("ended", () => {
      if (!this.#isCurrent(slot) || slot.source === null || slot.reopening !== null) return;

      // A live stream that ends before the song does was cut off: carry on from there.
      if (slot.live && endedEarly(this.#positionOf(slot), slot.source.durationMs)) {
        void this.#recover(slot, true);

        return;
      }

      this.#advance(slot);
    });

    element.addEventListener("error", () => {
      // A failed preload surfaces when the engine advances to it, not while the current song
      // plays. A reopening handles its own failure.
      if (!this.#isCurrent(slot) || slot.source === null || slot.reopening !== null) return;

      if (slot.live) {
        void this.#recover(slot, !element.paused);

        return;
      }

      this.#stopTicker();
      this.#fail(element.error);
    });
  }

  /** Reports the current song as failed with `error`, the element's, when it has one. */
  #fail(error: MediaError | null): void {
    this.#emit({
      type: "error",
      reason: error === null ? "network" : errorReason(error),
      message: error?.message ?? "The audio stopped and could not be loaded again",
    });
  }

  /** The current element ended: start the preloaded one at once, or report the end. */
  #advance(finished: Slot): void {
    const next = this.#idleSlot();
    const source = next.source;

    if (source === null) {
      this.#stopTicker();
      this.#emit({ type: "time", positionMs: this.#positionMs() });
      this.#emit({ type: "ended" });

      return;
    }

    // Start first, bookkeeping second: every statement before play() adds to the gap.
    // `#start` calls play() synchronously before its first await.
    void this.#start(next);
    this.#current = 1 - this.#current;
    this.#emit({ type: "advanced", key: source.key });
    this.#emit({ type: "time", positionMs: 0 });
    this.#release(finished);
  }

  /** Reopens a live stream that stopped before the song did, where it stopped. */
  async #recover(slot: Slot, play: boolean): Promise<void> {
    if (slot.reopening !== null || slot.source === null) return;
    const positionMs = this.#positionOf(slot);

    if (slot.recoveries >= MAX_RECOVERIES) {
      this.#stopTicker();
      // It opened every time but never got going: audio there is no reason to try again.
      await this.#settleFailure(
        slot,
        { positionMs, play, abort: new AbortController() },
        slot.element.error,
        false,
      );

      return;
    }

    slot.recoveries += 1;
    slot.recoveredAtMs = positionMs;
    await this.#reopen(slot, { positionMs, play, abort: new AbortController() });
  }

  /**
   * The stream at `reopening.positionMs` could not be played (the element failed with `error`, or
   * never got going): asks the media service what it has there. No audio means the song is over
   * (an offset past its real end), and a refused URL is reported as `expired`. A busy service is
   * asked again after its `Retry-After`, and
   * with `retryAudio`, a stream it has audio for is opened again at once, once (the element may
   * have met a busy answer that has cleared since; failing again, the element can't play it).
   * Busy answers are retried up to `MAX_BUSY_RETRIES` times in a row.
   * Anything else fails the song. The reopening stays on the slot meanwhile, so seeks, `play`,
   * and `pause` still apply, and a load, an unload, or an advance cancels it.
   */
  async #settleFailure(
    slot: Slot,
    reopening: Reopening,
    error: MediaError | null,
    retryAudio: boolean,
  ): Promise<void> {
    const source = slot.source;

    if (source === null) return;
    slot.reopening = reopening;

    const probe = await probeOffset(
      offsetUrl(source.url, reopening.positionMs),
      reopening.abort.signal,
    );

    if (slot.reopening !== reopening) return;

    const again =
      slot.retries < MAX_BUSY_RETRIES &&
      (OffsetProbe.$is("Busy")(probe) ||
        (retryAudio && OffsetProbe.$is("Audio")(probe) && slot.retries === 0));

    if (again) {
      slot.retries += 1;

      if (OffsetProbe.$is("Busy")(probe)) {
        await delay(probe.retryAfterMs, reopening.abort.signal);

        if (slot.reopening !== reopening) return;
      }

      await this.#reopen(slot, reopening);

      return;
    }

    slot.reopening = null;

    if (!this.#isCurrent(slot)) return;

    if (OffsetProbe.$is("Empty")(probe)) this.#advance(slot);
    else if (OffsetProbe.$is("Expired")(probe)) {
      this.#emit({
        type: "error",
        reason: "expired",
        message: "The stream's signed URL has expired",
      });
    } else this.#fail(error);
  }

  /**
   * Opens a live stream again at `reopening.positionMs`: from an offset (or from the start, near
   * it), and plays or stays paused as `play` says by then. A load, an unload, or an advance
   * cancels it by releasing the slot.
   */
  async #reopen(slot: Slot, reopening: Reopening): Promise<void> {
    const source = slot.source;

    if (source === null) return;
    slot.reopening = reopening;
    this.#stopTicker();
    slot.element.pause();

    if (reopening.play) this.#emit({ type: "waiting" });
    const target = reopening.positionMs;
    const fromStart = target < LIVE_RESTART_MS;

    this.#openAt(
      slot,
      fromStart ? source.url : offsetUrl(source.url, target),
      fromStart ? 0 : target,
    );

    const ready = await this.#whenReady(slot.element, {
      ms: REOPEN_TIMEOUT_MS,
      signal: reopening.abort.signal,
    });

    if (slot.reopening !== reopening) return;

    // A seek moved the target while the stream opened live somewhere else.
    const wanted = reopening.positionMs < LIVE_RESTART_MS ? 0 : reopening.positionMs;

    if (ready && slot.live && wanted !== slot.startMs) {
      await this.#reopen(slot, reopening);

      return;
    }

    if (!ready) {
      const { error } = slot.element;

      // A load that timed out is still going: stop it, so the media service can end its encode
      // and the load's late events start nothing.
      if (error === null) this.#stopLoading(slot);
      await this.#settleFailure(slot, reopening, error, true);

      return;
    }

    slot.reopening = null;
    slot.retries = 0;

    // The song's own URL answered with the finished file, which seeks by itself.
    if (!slot.live) slot.element.currentTime = reopening.positionMs / 1000;

    if (reopening.play) await this.#start(slot);
    else this.#emit({ type: "time", positionMs: this.#positionOf(slot) });
  }

  /** Stops the slot's element loading its stream, which then reports nothing more. */
  #stopLoading(slot: Slot): void {
    slot.live = false;
    slot.watch = null;
    slot.element.removeAttribute("src");
    slot.element.load();
  }

  /**
   * Points the slot's element at `url`, a stream starting `startMs` into the song. Whether it is
   * live is known once its metadata loads.
   */
  #openAt(slot: Slot, url: string, startMs: number): void {
    slot.startMs = startMs;
    slot.live = false;
    slot.watch = null;
    slot.element.src = url;
    slot.element.load();
  }

  /** Calls `play()` on the slot's element and turns its rejection into an engine event. */
  async #start(slot: Slot): Promise<void> {
    try {
      await slot.element.play();
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;

      // A later load or pause interrupted this play; that caller owns the outcome.
      if (error.name === "AbortError") return;

      if (error.name === "NotAllowedError") {
        this.#emit({
          type: "error",
          reason: "autoplay-blocked",
          message: "The browser blocked playback until you tap play",
        });

        return;
      }

      // Source failures also arrive through the element's error event, which classifies them.
      if (slot.element.error === null) {
        this.#emit({ type: "error", reason: "unsupported", message: error.message });
      }
    }
  }
}
