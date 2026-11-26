import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { positionTicker, tickerRuns } from "./position-ticker";

const EVERY_MS = 250;

/** A song that moves on with the fake clock while it plays. */
const song = () => {
  let positionMs = 0;
  let playing = false;
  let since = Date.now();

  const read = (): number => (playing ? positionMs + (Date.now() - since) : positionMs);

  return {
    read,
    play: () => {
      positionMs = read();
      since = Date.now();
      playing = true;
    },
    pause: () => {
      positionMs = read();
      playing = false;
    },
    seek: (to: number) => {
      positionMs = to;
      since = Date.now();
    },
  };
};

describe("tickerRuns", () => {
  it("runs only while the position moves, the app is on screen, and someone shows it", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.nat(5), (playing, foreground, readers) => {
        expect(tickerRuns({ playing, foreground, readers })).toBe(
          playing && foreground && readers > 0,
        );
      }),
    );
  });
});

describe("positionTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves the position four times a second for a reader on screen while a song plays", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);
    const heard = vi.fn<() => void>();

    playing.play();
    ticker.update({ playing: true, foreground: true });
    ticker.subscribe(heard);
    vi.advanceTimersByTime(1000);

    expect(heard).toHaveBeenCalledTimes(4);
    expect(ticker.read()).toBe(1000);
  });

  it("sets no timer while nothing plays, the app is away, or no one shows the position", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);

    playing.play();
    ticker.update({ playing: true, foreground: true });
    expect(vi.getTimerCount()).toBe(0);

    const stop = ticker.subscribe(() => undefined);

    expect(vi.getTimerCount()).toBe(1);
    ticker.update({ playing: true, foreground: false });
    expect(vi.getTimerCount()).toBe(0);
    ticker.update({ playing: false, foreground: true });
    expect(vi.getTimerCount()).toBe(0);
    ticker.update({ playing: true, foreground: true });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows where the song is once the app comes back, after playing on in the background", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);
    const heard = vi.fn<() => void>();

    playing.play();
    ticker.update({ playing: true, foreground: true });
    ticker.subscribe(heard);
    ticker.update({ playing: true, foreground: false });
    vi.advanceTimersByTime(180_000);

    expect(heard).not.toHaveBeenCalled();
    ticker.update({ playing: true, foreground: true });

    expect(ticker.read()).toBe(180_000);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("follows a seek made while paused without a timer", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);
    const heard = vi.fn<() => void>();

    ticker.update({ playing: false, foreground: true });
    ticker.subscribe(heard);
    playing.seek(42_000);
    ticker.refresh();

    expect(ticker.read()).toBe(42_000);
    expect(heard).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a new reader the position as it is now, after it moved with no one reading", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);

    playing.play();
    ticker.update({ playing: true, foreground: true });
    vi.advanceTimersByTime(5000);
    ticker.subscribe(() => undefined);

    expect(ticker.read()).toBe(5000);
  });

  it("stays put while paused, so readers hear nothing", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, EVERY_MS);
    const heard = vi.fn<() => void>();

    playing.play();
    ticker.update({ playing: true, foreground: true });
    ticker.subscribe(heard);
    vi.advanceTimersByTime(500);
    playing.pause();
    ticker.update({ playing: false, foreground: true });
    heard.mockClear();
    vi.advanceTimersByTime(10_000);
    ticker.refresh();

    expect(heard).not.toHaveBeenCalled();
    expect(ticker.read()).toBe(500);
  });
});
