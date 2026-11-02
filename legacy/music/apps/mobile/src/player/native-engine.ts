import { delay, MAX_BUSY_RETRIES } from "@music/player/busy-retry";
import type {
  EngineErrorReason,
  EnginePlayback,
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
  /**
   * The stream played to its end. The report can arrive after a seek has moved the player back
   * from there, so `positionMs` is where the player is when it reports.
   */
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
  /** Reads native output now, independently of a queued status callback. */
  readonly samplePlayback: () => Pick<OutputStatus, "positionMs" | "control">;
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

const LIVE_RESTART_MS = 2000;

const OPEN_TIMEOUT_MS = 15_000;

const MAX_RECOVERIES = 3;

const RECOVERED_MS = 2000;

/** A seek in a stream that can seek, from when it is asked for until the player lands it. */
interface Seeking {
  /** Where the latest seek takes the player. Until it lands, statuses carry an older position. */
  positionMs: number;
  /** The player played to its end before the seek landed. */
  ended: boolean;
}

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
  /** The seek the player has not landed yet, or null. */
  seeking: Seeking | null;
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
  #generation = 0;

  constructor(open: OpenOutput) {
    this.#open = open;
  }

  /** Samples the current native output, preserving an outstanding seek or reopening target. */
  samplePlayback(): EnginePlayback {
    const slot = this.#currentSlot();

    return {
      positionMs: this.#positionOf(slot),
      playing:
        slot.reopening?.play ??
        (slot.stream !== null && slot.stream.output.samplePlayback().control !== "paused"),
    };
  }

  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const idle = this.#idleSlot();

    if (idle.source?.url === source.url) {
      this.#release(this.#currentSlot());
      this.#current = 1 - this.#current;
    } else {
      const slot = this.#currentSlot();
      this.#release(slot);
      slot.source = source;
      slot.finished = this.#askFinished(source);
    }

    const slot = this.#currentSlot();
    const stream = slot.stream ?? this.#openStream(slot, source.url, 0);
    this.#showLockScreen();

    const early = autoplay && startMs < LIVE_RESTART_MS;

    if (early) stream.output.play();
    const ready = await this.#whenReady(stream, OPEN_TIMEOUT_MS, null);

    if (generation !== this.#generation || slot.stream !== stream) return;

    if (!ready) {
      if (stream.status?.error == null) this.#onFailure(slot, stream);

      return;
    }

    if (early) return;

    if (isLive(stream) && startMs >= LIVE_RESTART_MS) {
      const reopening = { positionMs: startMs, play: autoplay, abort: new AbortController() };
      slot.reopening = reopening;
      this.#emit({ type: "time", positionMs: startMs });

      if (!autoplay) this.#reportPaused(stream);
      await this.#reopen(slot, reopening);

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
    const finished = this.#askFinished(source);
    idle.finished = finished;

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
    } else if (stream !== null) void this.#seekStream(slot, stream, positionMs);

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

  #askFinished(source: EngineSource): Finished {
    const abort = new AbortController();

    if (source.finished) return { ready: true, abort, settled: Promise.resolve() };

    const finished: Finished = { ready: null, abort, settled: Promise.resolve() };

    const ask = async (): Promise<void> => {
      finished.ready = await fetchFinished(source.url, abort.signal);
    };

    finished.settled = ask();

    return finished;
  }

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
      seeking: null,
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

  async #seekStream(slot: Slot, stream: Stream, positionMs: number): Promise<void> {
    if (stream.seeking !== null) {
      stream.seeking.positionMs = positionMs;

      return;
    }

    const seeking: Seeking = { positionMs, ended: false };
    stream.seeking = seeking;

    try {
      await this.#land(slot, stream, seeking);
    } finally {
      stream.seeking = null;
    }

    if (seeking.ended && slot.stream === stream) this.#onFinished(slot, stream, seeking.positionMs);
  }

  async #land(slot: Slot, stream: Stream, seeking: Seeking): Promise<void> {
    const target = seeking.positionMs;

    try {
      await stream.output.seek(target);
    } catch (error) {
      if (slot.stream !== stream || seeking.positionMs === target) throw error;
    }

    if (slot.stream === stream && seeking.positionMs !== target) {
      await this.#land(slot, stream, seeking);
    }
  }

  #positionOf(slot: Slot): number {
    if (slot.reopening !== null) return slot.reopening.positionMs;
    const stream = slot.stream;

    if (stream === null) return 0;

    if (stream.seeking !== null) return stream.seeking.positionMs;
    const measured = stream.output.samplePlayback().positionMs;

    const positionMs =
      stream.status?.finished === true && isLive(stream)
        ? Math.max(measured, stream.status.positionMs)
        : measured;

    return stream.startMs + Math.round(positionMs);
  }

  #reportPaused(stream: Stream): void {
    if (stream.reported === "paused") return;
    stream.reported = "paused";
    this.#emit({ type: "paused" });
  }

  #onStatus(slot: Slot, stream: Stream, reported: OutputStatus): void {
    if (slot.stream !== stream) return;
    const measured = stream.output.samplePlayback();

    const status: OutputStatus = {
      ...reported,
      positionMs: measured.positionMs,
      control: measured.control,
    };

    const previous = stream.status;
    const wasLoaded = previous?.loaded === true;

    stream.status =
      status.finished && previous !== null && isLive(stream)
        ? { ...status, positionMs: Math.max(status.positionMs, previous.positionMs) }
        : status;

    if (status.loaded || status.error !== null) {
      for (const settle of stream.waiters) settle(status.loaded);
    }

    if (!this.#isCurrent(slot) || slot.source === null || slot.reopening !== null) return;

    if (status.loaded && !wasLoaded) this.#showLockScreen();

    if (status.error !== null) {
      this.#onFailure(slot, stream);

      return;
    }

    const seeking = stream.seeking;

    if (seeking !== null && (status.finished || seeking.ended)) {
      seeking.ended = true;

      return;
    }

    if (status.finished) {
      this.#onFinished(slot, stream, this.#positionOf(slot));

      return;
    }

    const positionMs = this.#positionOf(slot);

    if (status.control !== stream.reported) {
      if (status.control === "paused") {
        if (stream.reported === null) return;
        this.#emit({ type: "time", positionMs });
        this.#reportPaused(stream);

        return;
      }

      stream.reported = status.control;
      this.#emit({ type: status.control });
    }

    if (status.control !== "playing" || stream.seeking !== null) return;

    if (positionMs > slot.recoveredAtMs + RECOVERED_MS) slot.recoveries = 0;
    this.#emit({ type: "time", positionMs });
  }

  #onFailure(slot: Slot, stream: Stream): void {
    if (isLive(stream)) {
      void this.#recover(slot, stream.reported !== "paused");

      return;
    }

    this.#fail("unsupported", stream.status?.error ?? "The stream did not start");
  }

  #onFinished(slot: Slot, stream: Stream, positionMs: number): void {
    if (!isLive(stream) && endedEarly(positionMs, stream.status?.durationMs ?? 0)) {
      if (stream.reported !== "paused") stream.output.play();

      return;
    }

    stream.reported = "paused";

    if (isLive(stream) && endedEarly(positionMs, slot.source?.durationMs ?? 0)) {
      void this.#recover(slot, true);

      return;
    }

    this.#advance(slot);
  }

  #fail(reason: EngineErrorReason, message: string): void {
    this.#emit({ type: "error", reason, message });
  }

  #advance(finished: Slot): void {
    const next = this.#idleSlot();
    const source = next.source;

    if (source === null) {
      this.#emit({ type: "time", positionMs: this.#positionOf(finished) });
      this.#emit({ type: "ended" });

      return;
    }

    (next.stream ?? this.#openStream(next, source.url, 0)).output.play();
    this.#current = 1 - this.#current;
    this.#showLockScreen();
    this.#emit({ type: "advanced", key: source.key });
    this.#emit({ type: "time", positionMs: 0 });
    this.#release(finished);
  }

  async #recover(slot: Slot, play: boolean): Promise<void> {
    if (slot.reopening !== null || slot.source === null) return;
    const positionMs = this.#positionOf(slot);
    const reopening = { positionMs, play, abort: new AbortController() };

    if (slot.recoveries >= MAX_RECOVERIES) {
      await this.#settleFailure(slot, reopening, false);

      return;
    }

    slot.recoveries += 1;
    slot.recoveredAtMs = positionMs;
    await this.#reopen(slot, reopening);
  }

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

    stream.reported = reopening.play ? "waiting" : "paused";
    const ready = await this.#whenReady(stream, OPEN_TIMEOUT_MS, reopening.abort.signal);

    if (slot.reopening !== reopening) return;

    if (!ready) {
      this.#releaseStream(slot);
      await this.#settleFailure(slot, reopening, true);

      return;
    }

    const wanted = streamStartFor(reopening.positionMs);

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
