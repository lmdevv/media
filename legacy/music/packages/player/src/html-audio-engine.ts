import type { EngineErrorReason, EngineEvent, EngineSource, PlayerEngine } from "./engine";
import { primeInGesture } from "./prime-audio";

/** How often the engine emits `time` while playing (5 Hz; the contract asks for at least 4). */
const TIME_INTERVAL_MS = 200;

/**
 * A live stream starts from its beginning instead of waiting for the finished file when asked
 * for a position this close to it: a load that took a moment, or a seek back to the start.
 */
const LIVE_RESTART_MS = 2000;

/** A seek in a live stream, waiting for the stream to be opened again. */
interface Reopening {
  /** Where playback resumes; later seeks move it. */
  positionMs: number;
  /** Whether playback resumes playing; `play` and `pause` change it meanwhile. */
  play: boolean;
  /** Cancels the wait for the finished file. */
  readonly abort: AbortController;
}

/** One of the two audio elements and the source it holds. */
interface Slot {
  readonly element: HTMLAudioElement;
  source: EngineSource | null;
  reopening: Reopening | null;
}

/**
 * True when `element` plays a stream of unknown length: a transcode the media service sends while
 * ffmpeg still writes it. Browsers cannot seek in one (Firefox and Safari ignore the seek).
 */
const isLive = (element: HTMLAudioElement): boolean =>
  element.readyState >= HTMLMediaElement.HAVE_METADATA &&
  element.duration === Number.POSITIVE_INFINITY;

/**
 * Resolves once the media service has finished the transcode at `url`: it answers `HEAD` from
 * the finished file only. Also resolves when the request fails; loading the URL again reports why.
 */
const finishedTranscode = (url: string, signal: AbortSignal): Promise<void> =>
  fetch(url, { method: "HEAD", signal }).then(
    () => undefined,
    () => undefined,
  );

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
 * cannot be sought in. A seek in one (or a load that starts past `LIVE_RESTART_MS`) waits for
 * the finished file, which serves byte ranges, opens the song again, and lands there.
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
    this.#slots = [
      { element: createElement(), source: null, reopening: null },
      { element: createElement(), source: null, reopening: null },
    ];

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

    if (isLive(slot.element) && startMs >= LIVE_RESTART_MS) {
      this.#emit({ type: "time", positionMs: startMs });

      if (!autoplay) this.#emit({ type: "paused" });
      await this.#reopen(slot, {
        positionMs: startMs,
        play: autoplay,
        abort: new AbortController(),
      });

      return;
    }

    const start = isLive(slot.element) ? 0 : startMs;

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
    else if (isLive(slot.element)) {
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
    slot.element.pause();
    slot.element.removeAttribute("src");
    // Loading an empty source aborts the download and frees the decoder.
    slot.element.load();
  }

  /** Resolves true once `element` can start, or false when it failed or a newer load won. */
  #whenReady(element: HTMLAudioElement): Promise<boolean> {
    if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(true);

    return new Promise((resolve) => {
      const settle = (ready: boolean): void => {
        element.removeEventListener("canplay", onReady);
        element.removeEventListener("error", onFail);
        this.#cancelLoad = null;
        resolve(ready);
      };

      const onReady = (): void => {
        settle(true);
      };

      const onFail = (): void => {
        settle(false);
      };

      element.addEventListener("canplay", onReady);
      element.addEventListener("error", onFail);
      this.#cancelLoad = onFail;
    });
  }

  #positionMs(): number {
    const slot = this.#currentSlot();

    return slot.reopening?.positionMs ?? Math.round(slot.element.currentTime * 1000);
  }

  #startTicker(): void {
    if (this.#ticker !== null) return;

    this.#ticker = setInterval(() => {
      this.#emit({ type: "time", positionMs: this.#positionMs() });
    }, TIME_INTERVAL_MS);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  #attach(slot: Slot): void {
    const { element } = slot;

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
      if (this.#isCurrent(slot)) this.#advance(slot);
    });

    element.addEventListener("error", () => {
      // A failed preload surfaces when the engine advances to it, not while the current song plays.
      if (!this.#isCurrent(slot) || slot.source === null) return;
      this.#stopTicker();

      this.#emit({
        type: "error",
        reason: errorReason(element.error),
        message: element.error?.message ?? "The audio could not be loaded",
      });
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

  /**
   * Moves a live stream to `reopening.positionMs`: waits for the finished file (unless the target
   * is near the start), loads the song again, seeks, and plays or stays paused as `play` says by
   * then. A load, an unload, or an advance cancels it by releasing the slot.
   */
  async #reopen(slot: Slot, reopening: Reopening): Promise<void> {
    const source = slot.source;

    if (source === null) return;
    slot.reopening = reopening;
    this.#stopTicker();
    slot.element.pause();

    if (reopening.play) this.#emit({ type: "waiting" });
    const waited = reopening.positionMs >= LIVE_RESTART_MS;

    if (waited) await finishedTranscode(source.url, reopening.abort.signal);

    if (slot.reopening !== reopening) return;
    slot.element.src = source.url;
    slot.element.load();
    const ready = await this.#whenReady(slot.element);

    if (slot.reopening !== reopening) return;

    // A seek moved the target past the start while the stream opened live again.
    if (ready && !waited && isLive(slot.element) && reopening.positionMs >= LIVE_RESTART_MS) {
      await this.#reopen(slot, reopening);

      return;
    }

    slot.reopening = null;

    // The element reported a failure itself.
    if (!ready) return;

    if (!isLive(slot.element)) slot.element.currentTime = reopening.positionMs / 1000;

    if (reopening.play) await this.#start(slot);
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
