/**
 * The iPhone's `PlayerEngine`: native audio players (AVPlayer through expo-audio, behind
 * `AudioOutput`), one per opened stream. It plays what `PlaybackController` from `@music/player`
 * tells it to, the way `HtmlAudioEngine` does in a browser.
 */
import { delay, MAX_BUSY_RETRIES } from "@music/player/busy-retry";
import type {
  EngineErrorReason,
  EngineEvent,
  EngineSource,
  PlayerEngine,
} from "@music/player/engine";
import { endedEarly, OffsetProbe, offsetUrl, probeOffset } from "@music/player/stream-offset";

/** What a native player is doing with its stream. */
export type OutputControl = "playing" | "waiting" | "paused";

/** One status report from a native player. */
export interface OutputStatus {
  /** The stream opened and can play. */
  readonly loaded: boolean;
  /** Playing, waiting for data to play, or paused. */
  readonly control: OutputControl;
  /** Position in the opened stream, in milliseconds. */
  readonly positionMs: number;
  /** The stream's length, or null while unknown: always for a transcode the server still writes. */
  readonly durationMs: number | null;
  /** The stream just played to its end. */
  readonly finished: boolean;
  /** Why the stream failed, or null. */
  readonly error: string | null;
}

/** What the lock screen and Control Center show for the song that plays. */
export interface LockScreenInfo {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** An absolute URL. */
  readonly artworkUrl: string | null;
}

/** One native player holding one opened stream. */
export interface AudioOutput {
  readonly play: () => void;
  readonly pause: () => void;
  /** Moves to `positionMs` in this stream. */
  readonly seek: (positionMs: number) => Promise<void>;
  readonly setVolume: (volume: number) => void;
  /**
   * Puts this player on the lock screen with `info`, or takes it off with null. `live` hides the
   * scrubber of a stream whose length is unknown.
   */
  readonly showOnLockScreen: (info: LockScreenInfo | null, live: boolean) => void;
  readonly subscribe: (listener: (status: OutputStatus) => void) => () => void;
  /** Stops the stream and frees the player. */
  readonly release: () => void;
}

/** Opens `url` on a new native player, paused. */
export type OpenOutput = (url: string) => AudioOutput;

/**
 * A stream of unknown length starts from its beginning instead of from an offset when asked for a
 * position this close to it.
 */
const LIVE_RESTART_MS = 2000;

/** How long a stream may take to become playable before it counts as failed. */
const OPEN_TIMEOUT_MS = 15_000;

/** Reopenings in a row that may fail to get playback going again before the engine gives up. */
const MAX_RECOVERIES = 3;

/** Playback this far past where a recovery reopened the stream means it worked. */
const RECOVERED_MS = 2000;

/** One opened stream on one native player. */
interface Stream {
  readonly output: AudioOutput;
  /** Song position where the stream starts: 0 for the song's own URL, the offset for `&start=`. */
  readonly startMs: number;
  unsubscribe: () => void;
  /** The latest status, or null before the first. */
  status: OutputStatus | null;
  /** The playback state last reported to the engine's listeners for this stream. */
  reported: OutputControl | null;
  /** Calls waiting for the stream to open or fail. */
  readonly waiters: Set<(ready: boolean) => void>;
  /** Whether this stream is on the lock screen, and as live or not. */
  shown: { readonly live: boolean } | null;
}

/**
 * Whether the media service has the finished file for a source: `null` while asking. The file
 * plays and seeks like any other; until it exists the source's URL answers with a live stream.
 */
interface Finished {
  ready: boolean | null;
  readonly abort: AbortController;
  /** Settles once the answer is in. */
  settled: Promise<void>;
}

/** A reopening of the stream at another position, waiting for it to play. */
interface Reopening {
  /** Where playback resumes; later seeks move it. */
  positionMs: number;
  /** Whether playback resumes playing; `play` and `pause` change it meanwhile. */
  play: boolean;
  readonly abort: AbortController;
}

/** The current song or the preloaded next one. */
interface Slot {
  source: EngineSource | null;
  stream: Stream | null;
  finished: Finished | null;
  reopening: Reopening | null;
  /** Recoveries since playback last got going again, and where the last one reopened. */
  recoveries: number;
  recoveredAtMs: number;
  /** Reopenings in a row that met a busy media service or had audio there, each tried again. */
  retries: number;
}

/**
 * Asks the media service for the first byte of the finished file at `url`. A range other than a
 * player's opening one waits for a running transcode to finish, so the answer arrives once the
 * file exists. Resolves whether it does.
 */
const fetchFinished = async (url: string, signal: AbortSignal): Promise<boolean> => {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });

    void response.body?.cancel().catch(() => undefined);

    return response.ok;
  } catch {
    return false;
  }
};

const isLive = (stream: Stream): boolean =>
  stream.startMs > 0 || (stream.status?.loaded === true && stream.status.durationMs === null);

/** Where a stream for position `positionMs` should start: the song's start near it. */
const streamStartFor = (positionMs: number): number =>
  positionMs < LIVE_RESTART_MS ? 0 : positionMs;

/**
 * A `PlayerEngine` on native audio players. The next song preloads in a second player that starts
 * the moment the current one ends.
 *
 * A song the media service has not transcoded yet arrives as a live stream: it plays at once but
 * AVPlayer cannot seek in it (it ignores the seek). The engine asks the service for the finished
 * file alongside, and a seek opens the song again: from the finished file once it exists, seeking
 * there, else from that position (`&start=`), which the service encodes from there at once; song
 * position is then the offset plus the player's time. The next song preloads from the finished
 * file, so it plays and seeks like any cached one.
 *
 * A live stream that stops before the song does (it ends early or fails) is reopened where it
 * stopped. When that keeps failing the engine asks the service whether any audio is left there:
 * none means the song is over; a busy service (`503`) is asked again after its `Retry-After`.
 */
export class NativeEngine implements PlayerEngine {
  readonly #open: OpenOutput;
  readonly #slots: readonly [Slot, Slot] = [emptySlot(), emptySlot()];
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #current = 0;
  #volume = 1;
  #lockScreen: LockScreenInfo | null = null;
  /** Bumped by every `load` and `unload`, so a superseded load stops quietly. */
  #generation = 0;

  constructor(open: OpenOutput) {
    this.#open = open;
  }

  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const idle = this.#idleSlot();

    // The listener skipped ahead to the song that was already preloaded: reuse its player.
    if (idle.source?.url === source.url) {
      this.#release(this.#currentSlot());
      this.#current = 1 - this.#current;
    } else {
      const slot = this.#currentSlot();
      this.#release(slot);
      slot.source = source;
      slot.finished = this.#askFinished(source.url);
    }

    const slot = this.#currentSlot();
    const stream = slot.stream ?? this.#openStream(slot, source.url, 0);
    this.#showLockScreen();

    // Most loads start a song from the top (give or take the moment its URL took to arrive):
    // start the player before it has data, to save a round trip.
    const early = autoplay && startMs < LIVE_RESTART_MS;

    if (early) stream.output.play();
    const ready = await this.#whenReady(stream, OPEN_TIMEOUT_MS, null);

    if (generation !== this.#generation || slot.stream !== stream) return;

    if (!ready) {
      // A failure the player reported is handled as its status arrives; this one never opened.
      if (stream.status?.error == null) this.#onFailure(slot, stream);

      return;
    }

    if (early) return;

    if (isLive(stream) && startMs >= LIVE_RESTART_MS) {
      this.#emit({ type: "time", positionMs: startMs });

      if (!autoplay) this.#reportPaused(stream);
      await this.#reopen(slot, {
        positionMs: startMs,
        play: autoplay,
        abort: new AbortController(),
      });

      return;
    }

    const start = isLive(stream) ? 0 : startMs;

    if (start > 0) await stream.output.seek(start);

    if (generation !== this.#generation || slot.stream !== stream) return;
    this.#emit({ type: "time", positionMs: start });

    if (autoplay) stream.output.play();
    else this.#reportPaused(stream);
  }

  preload(source: EngineSource | null): void {
    const idle = this.#idleSlot();

    if (source === null) {
      this.#release(idle);

      return;
    }

    if (idle.source?.url === source.url) return;
    this.#release(idle);
    idle.source = source;
    const finished = this.#askFinished(source.url);
    idle.finished = finished;

    // Open it once the finished file exists (or the question failed): a player opened earlier
    // would get the live stream, which cannot seek and has no length for the lock screen.
    const openWhenFinished = async (): Promise<void> => {
      await finished.settled;

      if (idle.finished === finished && idle.stream === null && !this.#isCurrent(idle)) {
        this.#openStream(idle, source.url, 0);
      }
    };

    void openWhenFinished();
  }

  async play(): Promise<void> {
    const slot = this.#currentSlot();
    const reopening = slot.reopening;

    if (reopening !== null) {
      if (reopening.play) return;
      reopening.play = true;
      this.#emit({ type: "waiting" });

      return;
    }

    if (slot.stream !== null) slot.stream.output.play();
  }

  pause(): void {
    const slot = this.#currentSlot();
    const reopening = slot.reopening;

    if (reopening !== null) {
      if (!reopening.play) return;
      reopening.play = false;
      this.#emit({ type: "time", positionMs: reopening.positionMs });
      this.#emit({ type: "paused" });

      return;
    }

    const stream = slot.stream;

    if (stream === null) return;
    stream.output.pause();
    this.#emit({ type: "time", positionMs: this.#positionOf(slot) });
    this.#reportPaused(stream);
  }

  seek(positionMs: number): void {
    const slot = this.#currentSlot();
    const stream = slot.stream;

    if (slot.source === null) return;

    if (slot.reopening !== null) slot.reopening.positionMs = positionMs;
    else if (stream !== null && isLive(stream)) {
      const play = stream.reported !== "paused";

      void this.#reopen(slot, { positionMs, play, abort: new AbortController() });
    } else if (stream !== null) void stream.output.seek(positionMs);

    this.#emit({ type: "time", positionMs });
  }

  setVolume(volume: number): void {
    this.#volume = Math.min(1, Math.max(0, volume));

    for (const slot of this.#slots) slot.stream?.output.setVolume(this.#volume);
  }

  unload(): void {
    this.#generation += 1;

    for (const slot of this.#slots) this.#release(slot);
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Shows `info` on the lock screen while a song plays here, or takes the player off it. */
  setLockScreen(info: LockScreenInfo | null): void {
    this.#lockScreen = info;
    const stream = this.#currentSlot().stream;

    if (stream !== null) stream.shown = null;
    this.#showLockScreen();
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

  /** Asks the media service in the background whether the finished file for `url` exists. */
  #askFinished(url: string): Finished {
    const abort = new AbortController();

    const finished: Finished = { ready: null, abort, settled: Promise.resolve() };

    const ask = async (): Promise<void> => {
      finished.ready = await fetchFinished(url, abort.signal);
    };

    finished.settled = ask();

    return finished;
  }

  /** Opens `url`, a stream starting `startMs` into the song, as the slot's stream. */
  #openStream(slot: Slot, url: string, startMs: number): Stream {
    this.#releaseStream(slot);
    const output = this.#open(url);
    output.setVolume(this.#volume);

    const stream: Stream = {
      output,
      startMs,
      unsubscribe: () => {},
      status: null,
      reported: null,
      waiters: new Set(),
      shown: null,
    };

    stream.unsubscribe = output.subscribe((status) => {
      this.#onStatus(slot, stream, status);
    });

    slot.stream = stream;

    return stream;
  }

  #releaseStream(slot: Slot): void {
    const stream = slot.stream;

    if (stream === null) return;
    slot.stream = null;
    stream.unsubscribe();
    stream.output.release();

    for (const settle of stream.waiters) settle(false);
  }

  #release(slot: Slot): void {
    slot.reopening?.abort.abort();
    slot.reopening = null;
    slot.finished?.abort.abort();
    slot.finished = null;
    this.#releaseStream(slot);
    slot.source = null;
    slot.recoveries = 0;
    slot.recoveredAtMs = 0;
    slot.retries = 0;
  }

  /**
   * Resolves true once `stream` can play, or false when it failed, was released, or did not open
   * within `ms`, or once `signal` aborts.
   */
  #whenReady(stream: Stream, ms: number, signal: AbortSignal | null): Promise<boolean> {
    if (stream.status?.loaded === true) return Promise.resolve(true);

    if (stream.status?.error != null) return Promise.resolve(false);

    return new Promise((resolve) => {
      const settle = (ready: boolean): void => {
        stream.waiters.delete(settle);
        signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        resolve(ready);
      };

      const abort = (): void => {
        settle(false);
      };

      const timer = setTimeout(abort, ms);

      stream.waiters.add(settle);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #positionOf(slot: Slot): number {
    const stream = slot.stream;

    return (
      slot.reopening?.positionMs ??
      (stream === null ? 0 : stream.startMs + Math.round(stream.status?.positionMs ?? 0))
    );
  }

  /** Reports a pause for `stream` once, however many paused statuses follow. */
  #reportPaused(stream: Stream): void {
    if (stream.reported === "paused") return;
    stream.reported = "paused";
    this.#emit({ type: "paused" });
  }

  #onStatus(slot: Slot, stream: Stream, status: OutputStatus): void {
    if (slot.stream !== stream) return;
    const previous = stream.status;
    const wasLoaded = previous?.loaded === true;

    // At its end a live stream reports position 0 (its length is unknown): keep where it got to.
    stream.status =
      status.finished && previous !== null
        ? { ...status, positionMs: Math.max(status.positionMs, previous.positionMs) }
        : status;

    if (status.loaded || status.error !== null) {
      for (const settle of stream.waiters) settle(status.loaded);
    }

    // The idle slot only preloads, and a reopening waits for its stream itself.
    if (!this.#isCurrent(slot) || slot.source === null || slot.reopening !== null) return;

    if (status.loaded && !wasLoaded) this.#showLockScreen();

    if (status.error !== null) {
      this.#onFailure(slot, stream);

      return;
    }

    if (status.finished) {
      this.#onFinished(slot, stream);

      return;
    }

    const positionMs = this.#positionOf(slot);

    if (status.control !== stream.reported) {
      // A player opens paused; only a pause after playing (the lock screen, a call, unplugged
      // headphones) is news.
      if (status.control === "paused") {
        if (stream.reported === null) return;
        this.#emit({ type: "time", positionMs });
        this.#reportPaused(stream);

        return;
      }

      stream.reported = status.control;
      this.#emit({ type: status.control });
    }

    if (status.control !== "playing") return;

    if (positionMs > slot.recoveredAtMs + RECOVERED_MS) slot.recoveries = 0;
    this.#emit({ type: "time", positionMs });
  }

  /** The current stream failed: a live one opens again where it stopped, else the song fails. */
  #onFailure(slot: Slot, stream: Stream): void {
    if (isLive(stream)) {
      void this.#recover(slot, stream.reported !== "paused");

      return;
    }

    this.#fail("unsupported", stream.status?.error ?? "The stream did not start");
  }

  #onFinished(slot: Slot, stream: Stream): void {
    // The end of the song: nothing reports this stop as a pause.
    stream.reported = "paused";

    // A live stream that ends before the song does was cut off: carry on from there.
    if (isLive(stream) && endedEarly(this.#positionOf(slot), slot.source?.durationMs ?? 0)) {
      void this.#recover(slot, true);

      return;
    }

    this.#advance(slot);
  }

  #fail(reason: EngineErrorReason, message: string): void {
    this.#emit({ type: "error", reason, message });
  }

  /** The current song ended: start the preloaded one at once, or report the end. */
  #advance(finished: Slot): void {
    const next = this.#idleSlot();
    const source = next.source;

    if (source === null) {
      this.#emit({ type: "time", positionMs: this.#positionOf(finished) });
      this.#emit({ type: "ended" });

      return;
    }

    // Start first, bookkeeping second: every statement before play() adds to the gap.
    (next.stream ?? this.#openStream(next, source.url, 0)).output.play();
    this.#current = 1 - this.#current;
    this.#showLockScreen();
    this.#emit({ type: "advanced", key: source.key });
    this.#emit({ type: "time", positionMs: 0 });
    this.#release(finished);
  }

  /** Reopens a live stream that stopped before the song did, where it stopped. */
  async #recover(slot: Slot, play: boolean): Promise<void> {
    if (slot.reopening !== null || slot.source === null) return;
    const positionMs = this.#positionOf(slot);
    const reopening = { positionMs, play, abort: new AbortController() };

    if (slot.recoveries >= MAX_RECOVERIES) {
      // It opened every time but never got going: audio there is no reason to try again.
      await this.#settleFailure(slot, reopening, false);

      return;
    }

    slot.recoveries += 1;
    slot.recoveredAtMs = positionMs;
    await this.#reopen(slot, reopening);
  }

  /**
   * The stream at `reopening.positionMs` could not be played: asks the media service what it has
   * there. No audio means the song is over, and a refused URL is reported as `expired`. A busy
   * service is asked again after its `Retry-After`, and with `retryAudio`, a stream it has audio
   * for is opened again at once, once. Anything else fails the song.
   */
  async #settleFailure(slot: Slot, reopening: Reopening, retryAudio: boolean): Promise<void> {
    const source = slot.source;

    if (source === null) return;
    slot.reopening = reopening;

    const probe = await probeOffset(
      offsetUrl(source.url, reopening.positionMs),
      reopening.abort.signal,
    );

    if (slot.reopening !== reopening) return;

    const busy = OffsetProbe.$is("Busy")(probe);

    const again =
      slot.retries < MAX_BUSY_RETRIES &&
      (busy || (retryAudio && OffsetProbe.$is("Audio")(probe) && slot.retries === 0));

    if (again) {
      slot.retries += 1;

      if (busy) {
        await delay(probe.retryAfterMs, reopening.abort.signal);

        if (slot.reopening !== reopening) return;
      }

      await this.#reopen(slot, reopening);

      return;
    }

    slot.reopening = null;

    if (!this.#isCurrent(slot)) return;

    OffsetProbe.$match(probe, {
      Empty: () => {
        this.#advance(slot);
      },
      Expired: () => {
        this.#fail("expired", "The stream's signed URL has expired");
      },
      Audio: () => {
        this.#fail("decode", "The stream has audio there that could not be played");
      },
      Busy: () => {
        this.#fail("network", "The media server stayed busy");
      },
      Failed: () => {
        this.#fail("network", "The audio stopped and could not be loaded again");
      },
    });
  }

  /**
   * Opens the song again at `reopening.positionMs`: from the finished file when it exists, else
   * from that offset (or from the start, near it). Plays or stays paused as `play` says by then.
   */
  async #reopen(slot: Slot, reopening: Reopening): Promise<void> {
    const source = slot.source;

    if (source === null) return;
    slot.reopening = reopening;

    if (reopening.play) this.#emit({ type: "waiting" });
    const target = reopening.positionMs;
    const whole = slot.finished?.ready === true || streamStartFor(target) === 0;

    const stream = whole
      ? this.#openStream(slot, source.url, 0)
      : this.#openStream(slot, offsetUrl(source.url, target), target);

    // The reopening reports for itself; the new stream starts from there.
    stream.reported = reopening.play ? "waiting" : "paused";
    const ready = await this.#whenReady(stream, OPEN_TIMEOUT_MS, reopening.abort.signal);

    if (slot.reopening !== reopening) return;

    if (!ready) {
      this.#releaseStream(slot);
      await this.#settleFailure(slot, reopening, true);

      return;
    }

    const wanted = streamStartFor(reopening.positionMs);

    // The song's own URL answered live after all (the finished file is gone), or a seek moved the
    // target while a live stream opened somewhere else.
    if (isLive(stream) && wanted !== stream.startMs) {
      if (slot.finished !== null) slot.finished.ready = false;
      await this.#reopen(slot, reopening);

      return;
    }

    if (!isLive(stream) && reopening.positionMs > 0) {
      await stream.output.seek(reopening.positionMs);

      if (slot.reopening !== reopening) return;
    }

    slot.reopening = null;
    slot.retries = 0;
    this.#showLockScreen();

    if (reopening.play) stream.output.play();
    else this.#emit({ type: "time", positionMs: this.#positionOf(slot) });
  }

  /** Puts the current stream on the lock screen with the song's details, once per change. */
  #showLockScreen(): void {
    const stream = this.#currentSlot().stream;

    if (stream === null) return;
    const live = isLive(stream);

    if (stream.shown?.live === live) return;
    stream.shown = { live };
    stream.output.showOnLockScreen(this.#lockScreen, live);
  }
}

function emptySlot(): Slot {
  return {
    source: null,
    stream: null,
    finished: null,
    reopening: null,
    recoveries: 0,
    recoveredAtMs: 0,
    retries: 0,
  };
}
