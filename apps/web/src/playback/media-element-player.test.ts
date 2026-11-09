import type { PlayerEvent } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import type { MediaElementLike, StreamSeeker, TimeRangesLike } from "./media-element-player";
import { MediaElementPlayer, isBuffered } from "./media-element-player";

const ranges = (spans: ReadonlyArray<readonly [number, number]>): TimeRangesLike => ({
  length: spans.length,
  start: (index) => spans[index]?.[0] ?? 0,
  end: (index) => spans[index]?.[1] ?? 0,
});

class FakeMediaElement extends EventTarget implements MediaElementLike {
  #time = 0;
  /** Every position set, and whether the element was paused then. */
  readonly seeks: Array<{ readonly seconds: number; readonly paused: boolean }> = [];
  playbackRate = 1;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 4;
  buffered: TimeRangesLike = ranges([]);
  refuse: "allowed" | "NotAllowedError" | "AbortError" = "allowed";

  get currentTime(): number {
    return this.#time;
  }

  set currentTime(seconds: number) {
    this.#time = seconds;
    this.seeks.push({ seconds, paused: this.paused });
  }

  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /** Starts a seek to `seconds` as the browser reports one: seeking, with its target as the time. */
  startSeek(seconds: number): void {
    this.currentTime = seconds;
    this.seeking = true;
    this.fire("seeking");
  }

  /** Ends the seek at `seconds`, where the browser put it, before its `seeked` event dispatches. */
  land(seconds: number): void {
    this.#time = seconds;
    this.seeking = false;
    this.readyState = 4;
  }

  play(): Promise<void> {
    if (this.refuse !== "allowed") {
      return Promise.reject(new DOMException("play() refused", this.refuse));
    }

    this.paused = false;
    this.fire("playing");

    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.fire("pause");
  }
}

const recording = (player: MediaElementPlayer): Array<PlayerEvent> => {
  const events: Array<PlayerEvent> = [];

  player.subscribe((event) => events.push(event));

  return events;
};

const manualSeeker = (element: FakeMediaElement, reachable: (ms: number) => boolean) => {
  const moves: Array<{ readonly target: number; readonly land: () => void }> = [];

  const seeker: StreamSeeker = {
    reaches: reachable,
    move: (target, signal) =>
      new Promise<void>((resolve) => {
        moves.push({
          target,
          land: () => {
            if (!signal.aborted) {
              element.currentTime = target / 1000;
              element.fire("seeked");
            }

            resolve();
          },
        });
      }),
  };

  return { seeker, moves };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MediaElementPlayer", () => {
  it("maps element events to player events", () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const events = recording(player);

    for (const type of ["playing", "pause", "seeked", "waiting", "ended"]) element.fire(type);

    expect(events).toStrictEqual(["playing", "paused", "seeked", "waiting", "ended"]);
  });

  it("counts a stall only while the element is starved", () => {
    const element = new FakeMediaElement();
    const events = recording(new MediaElementPlayer(element));

    element.fire("stalled");
    element.readyState = 2;
    element.fire("stalled");

    expect(events).toStrictEqual(["waiting"]);
  });

  it("reports buffering while playing without enough data, not while paused", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    expect(player.isBuffering()).toBe(false);

    element.readyState = 2;
    expect(player.isBuffering()).toBe(true);

    element.pause();
    expect(player.isBuffering()).toBe(false);
  });

  it("reads and sets position and rate in milliseconds", () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    element.currentTime = 12.5;
    expect(player.positionMs()).toBe(12_500);

    player.seek(30_000);
    expect(element.currentTime).toBe(30);

    player.setPlaybackRate(1.05);
    expect(player.playbackRate()).toBe(1.05);
  });

  it("starts a seek again when a pause interrupts it before the first frame", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    element.readyState = 1;
    element.startSeek(11.9);
    element.pause();

    expect(element.seeks).toStrictEqual([
      { seconds: 11.9, paused: false },
      { seconds: 11.9, paused: true },
    ]);
    expect(player.isPaused()).toBe(true);
  });

  it("starts a seek again when it landed at 0 before the pause that interrupted it arrived", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    element.readyState = 1;
    element.startSeek(11.9);
    element.land(0);
    element.pause();
    element.fire("seeked");

    expect(element.seeks).toStrictEqual([
      { seconds: 11.9, paused: false },
      { seconds: 11.9, paused: true },
    ]);
  });

  it("leaves a seek alone when the pause comes once a frame shows, or after the seek", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    element.startSeek(11.9);
    player.pause();

    await player.play();
    element.land(11.9);
    element.fire("seeked");
    element.readyState = 1;
    player.pause();

    expect(element.seeks).toStrictEqual([{ seconds: 11.9, paused: false }]);
  });

  it("forgets a seek its stream dropped, so a pause on the next stream stays put", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    element.readyState = 1;
    element.startSeek(11.9);
    element.fire("emptied");
    element.land(0);
    element.pause();

    expect(element.seeks).toStrictEqual([{ seconds: 11.9, paused: false }]);
  });

  it("rejects play only when the browser refuses it", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    element.refuse = "AbortError";
    await expect(player.play()).resolves.toBeUndefined();

    element.refuse = "NotAllowedError";
    await expect(player.play()).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("holds the target position while a stream seek lands, then reports one seek", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const { seeker, moves } = manualSeeker(element, () => false);
    const events = recording(player);

    player.setSeeker(seeker);
    await player.play();
    player.seek(600_000);

    expect(player.positionMs()).toBe(600_000);
    expect(player.isBuffering()).toBe(true);
    expect(moves.map((move) => move.target)).toStrictEqual([600_000]);

    moves[0]?.land();
    await settle();

    expect(player.isBuffering()).toBe(false);
    expect(player.positionMs()).toBe(600_000);
    expect(events).toStrictEqual(["playing", "waiting", "seeked"]);
  });

  it("reports what was asked for while a stream move empties the element", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const { seeker, moves } = manualSeeker(element, () => false);

    player.setSeeker(seeker);
    await player.play();
    player.seek(600_000);
    // A new generation re-creates the MediaSource, which pauses the element without an event.
    element.paused = true;

    expect(player.isPaused()).toBe(false);
    expect(player.isBuffering()).toBe(true);
    expect(player.wantsToPlay()).toBe(true);

    player.pause();

    expect(player.isPaused()).toBe(true);
    expect(player.isBuffering()).toBe(false);
    expect(player.wantsToPlay()).toBe(false);

    moves[0]?.land();
    await settle();

    expect(player.isPaused()).toBe(true);
  });

  it("drops a stream move in flight when another stream takes over", () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const { seeker } = manualSeeker(element, () => false);

    player.setSeeker(seeker);
    element.currentTime = 42;
    player.seek(600_000);
    player.setSeeker(manualSeeker(element, () => true).seeker);

    expect(player.positionMs()).toBe(42_000);
  });

  it("lets a newer seek replace a stream seek still in flight", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const { seeker, moves } = manualSeeker(element, (ms) => ms < 60_000);
    const events = recording(player);

    player.setSeeker(seeker);
    player.seek(600_000);
    player.seek(5_000);

    expect(player.positionMs()).toBe(5_000);

    moves[0]?.land();
    await settle();

    expect(player.positionMs()).toBe(5_000);
    expect(events).toStrictEqual(["waiting"]);
  });

  it("stops listening once disposed", () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);
    const events = recording(player);

    player.dispose();
    element.fire("playing");

    expect(events).toStrictEqual([]);
  });

  it("keeps reporting where it stopped, paused, after the element is reused", async () => {
    const element = new FakeMediaElement();
    const player = new MediaElementPlayer(element);

    await player.play();
    element.currentTime = 1_234.5;
    player.dispose();
    // Detaching the stream rewinds the element.
    element.currentTime = 0;

    expect(player.positionMs()).toBe(1_234_500);
    expect(player.isPaused()).toBe(true);
    expect(player.isBuffering()).toBe(false);
  });
});

describe("isBuffered", () => {
  it("finds a position inside any range, with half a second of slack before it", () => {
    const buffered = ranges([
      [0, 30],
      [100, 130],
    ]);

    expect(isBuffered(buffered, 15)).toBe(true);
    expect(isBuffered(buffered, 99.6)).toBe(true);
    expect(isBuffered(buffered, 60)).toBe(false);
    expect(isBuffered(buffered, 131)).toBe(false);
  });
});
