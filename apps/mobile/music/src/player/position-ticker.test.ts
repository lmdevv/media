import { deviceReports } from "@media/player/connect-devices";
import type { Device } from "@media/player/connect-devices";
import { PlaybackController } from "@media/player/playback-controller";
import type { MusicCommands, QueueEntry, QueueState } from "@media/player/playback-controller";
import type { SourceResolver } from "@media/player/source-resolver";
import { Result } from "effect";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { FakeOutput } from "./fake-output";
import { NativeEngine } from "./native-engine";
import { positionTicker, showPosition, tickerRuns } from "./position-ticker";
import { settle } from "./test-engine";

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

/** A source's changes, told by hand. */
const told = () => {
  const listeners = new Set<() => void>();

  return {
    changes: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    tell: () => {
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
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
    const ticker = positionTicker(playing.read, [], EVERY_MS);
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
    const ticker = positionTicker(playing.read, [], EVERY_MS);

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
    const ticker = positionTicker(playing.read, [], EVERY_MS);
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

  it("reads once, with no timer, when its source says the position jumped while it stands", () => {
    const playing = song();
    const source = told();
    const ticker = positionTicker(playing.read, [source.changes], EVERY_MS);
    const heard = vi.fn<() => void>();

    ticker.update({ playing: false, foreground: true });
    ticker.subscribe(heard);
    playing.seek(42_000);
    source.tell();

    expect(ticker.read()).toBe(42_000);
    expect(heard).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads a jump heard in the background only once the app comes back", () => {
    const playing = song();
    const source = told();
    const ticker = positionTicker(playing.read, [source.changes], EVERY_MS);
    const heard = vi.fn<() => void>();

    ticker.update({ playing: false, foreground: false });
    ticker.subscribe(heard);
    playing.seek(42_000);
    source.tell();

    expect(heard).not.toHaveBeenCalled();
    ticker.update({ playing: false, foreground: true });
    expect(ticker.read()).toBe(42_000);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("hears its sources only while a reader is mounted", () => {
    const playing = song();
    const source = told();
    const ticker = positionTicker(playing.read, [source.changes], EVERY_MS);

    ticker.update({ playing: false, foreground: true });
    expect(source.listening()).toBe(0);

    const stopOne = ticker.subscribe(() => undefined);
    const stopTwo = ticker.subscribe(() => undefined);

    expect(source.listening()).toBe(1);
    stopOne();
    expect(source.listening()).toBe(1);
    stopTwo();
    expect(source.listening()).toBe(0);
  });

  it("gives a new reader the position as it is now, after it moved with no one reading", () => {
    const playing = song();
    const ticker = positionTicker(playing.read, [], EVERY_MS);

    playing.play();
    ticker.update({ playing: true, foreground: true });
    vi.advanceTimersByTime(5000);
    ticker.subscribe(() => undefined);

    expect(ticker.read()).toBe(5000);
  });

  it("stays put while paused, so readers hear nothing", () => {
    const playing = song();
    const source = told();
    const ticker = positionTicker(playing.read, [source.changes], EVERY_MS);
    const heard = vi.fn<() => void>();

    playing.play();
    ticker.update({ playing: true, foreground: true });
    ticker.subscribe(heard);
    vi.advanceTimersByTime(500);
    playing.pause();
    ticker.update({ playing: false, foreground: true });
    heard.mockClear();
    vi.advanceTimersByTime(10_000);
    source.tell();

    expect(heard).not.toHaveBeenCalled();
    expect(ticker.read()).toBe(500);
  });
});

const songA = trackOf("Safe from Harm");

const songB = trackOf("One Love");

const entryOf = (track: Track, itemId: string): QueueEntry<Track> => ({
  itemId,
  autoplay: false,
  track,
});

const queueAt = (current: string): QueueState<Track> => ({
  entries: [entryOf(songA, "1"), entryOf(songB, "2")],
  complete: true,
  current,
  shuffle: false,
  repeat: "off",
  autoplay: false,
});

const LAPTOP = "laptop";

const laptopAt = (trackId: string, positionMs: number, playing = false): Device => ({
  id: LAPTOP,
  name: "Laptop",
  output: { kind: "local" },
  playback: { trackId, playing, positionMs, at: 1_000_000, pending: false },
});

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * The player provider's shown position over this phone's real player and engine, and the reports
 * of the person's laptop, with Now Playing open on screen and nothing moving, so the ticker's
 * timer is off. `offer` lands a list of reports as `useConnect` does, then tells the position
 * which device the screens follow, as the provider does whenever what it shows changes.
 */
const phone = (resume: { readonly itemId: string; readonly positionMs: number } | null = null) => {
  const outputs: Array<FakeOutput> = [];

  const engine = new NativeEngine((url) => {
    const output = new FakeOutput(url, `player-${outputs.length + 1}`);

    outputs.push(output);
    setTimeout(() => {
      output.ready(false, 240_000);
    }, 0);

    return output;
  });

  const commands: MusicCommands = {
    play: async () => ({ current: "1" }),
    track: async (trackId) => (trackId === songB.id ? songB : songA),
    jump: async () => {},
    report: async () => {},
  };

  const sources: SourceResolver = {
    resolve: async (track) =>
      Result.succeed({
        origin: "stream",
        profile: "aac-320",
        renewAt: Number.MAX_SAFE_INTEGER,
        playbackId: `p-${track.id}`,
        source: {
          key: track.id,
          url: `https://media.test/${track.id}`,
          durationMs: track.durationMs,
          finished: true,
        },
      }),
    discard: () => {},
  };

  const clock = { now: 1_000_000 };

  const controller = new PlaybackController(
    commands,
    sources,
    { mse: null, create: () => engine },
    {
      canPlay: () => true,
      now: () => clock.now,
      monotonicNow: () => clock.now,
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      nowPlaying: { setHandlers: () => {}, show: () => {}, commanded: () => {} },
      resume: { load: () => resume, save: () => {} },
    },
  );

  stops.push(controller.start());

  const reports = deviceReports();

  const shown = showPosition(
    controller,
    { playbackOf: reports.playbackOf, serverNow: () => clock.now },
    EVERY_MS,
  );

  const heard: Array<number> = [];
  let following: string | null = null;

  shown.ticker.update({ playing: false, foreground: true });
  stops.push(
    shown.ticker.subscribe(() => {
      heard.push(shown.ticker.read());
    }),
  );

  const view = (): void => {
    const playback = following === null ? null : reports.playbackOf(following);
    const track = playback?.trackId === songB.id ? songB : songA;

    shown.follow(following === null ? null : { deviceId: following, durationMs: track.durationMs });
  };

  let shownKey = "";

  return {
    controller,
    shown,
    heard,
    offer: (devices: ReadonlyArray<Device>): void => {
      reports.offer(devices);

      // The provider re-renders, and tells the position, when what a device plays changes.
      const key = JSON.stringify(
        devices.map(({ id, playback }) => [id, playback?.trackId, playback?.playing]),
      );

      if (key === shownKey) return;
      shownKey = key;
      view();
    },
    follow: (deviceId: string | null): void => {
      following = deviceId;
      view();
    },
  };
};

describe("the shown position with Now Playing open and the ticker off", () => {
  it("moves to a seek made here while paused", async () => {
    const here = phone();

    here.controller.sync(queueAt("1"));
    await settle();
    here.controller.seek(42_000);
    await settle();

    expect(here.shown.ticker.read()).toBe(42_000);
    expect(here.heard.at(-1)).toBe(42_000);
  });

  it("moves to a seek made on the followed device while it is paused", () => {
    const here = phone();

    here.follow(LAPTOP);
    here.offer([laptopAt(songA.id, 26_000)]);
    expect(here.shown.ticker.read()).toBe(26_000);

    here.offer([laptopAt(songA.id, 0)]);

    expect(here.shown.ticker.read()).toBe(0);
    expect(here.heard.at(-1)).toBe(0);
  });

  it("moves to where the followed device plays from and pauses at", () => {
    const here = phone();

    here.follow(LAPTOP);
    here.offer([laptopAt(songA.id, 10_000)]);
    here.offer([laptopAt(songA.id, 12_000, true)]);
    expect(here.shown.ticker.read()).toBe(12_000);

    here.shown.ticker.update({ playing: true, foreground: true });
    here.offer([laptopAt(songA.id, 15_000)]);
    here.shown.ticker.update({ playing: false, foreground: true });

    expect(here.shown.ticker.read()).toBe(15_000);
  });

  it("moves to the start of the next song in the queue played here", async () => {
    const here = phone();

    here.controller.sync(queueAt("1"));
    await settle();
    here.controller.seek(42_000);
    await settle();
    here.controller.sync(queueAt("2"));
    await settle();

    expect(here.shown.ticker.read()).toBe(0);
  });

  it("moves to where another song on the followed device stands", () => {
    const here = phone();

    here.follow(LAPTOP);
    here.offer([laptopAt(songA.id, 26_000)]);
    here.offer([laptopAt(songB.id, 3000)]);

    expect(here.shown.ticker.read()).toBe(3000);
  });

  it("moves between this phone and the followed device as each takes playback", async () => {
    const here = phone();

    here.controller.sync(queueAt("1"));
    await settle();
    here.controller.seek(30_000);
    await settle();
    here.follow(LAPTOP);
    here.offer([laptopAt(songA.id, 26_000)]);
    expect(here.shown.ticker.read()).toBe(26_000);

    here.follow(null);
    expect(here.shown.ticker.read()).toBe(30_000);

    here.offer([laptopAt(songA.id, 31_000)]);
    here.follow(LAPTOP);
    expect(here.shown.ticker.read()).toBe(31_000);
  });

  it("shows the place the app saved last when it launches", async () => {
    const here = phone({ itemId: "2", positionMs: 95_000 });

    here.controller.sync(queueAt("2"));
    await settle();

    expect(here.shown.ticker.read()).toBe(95_000);
  });

  it("shows where a load moved here from another device starts", async () => {
    const here = phone();

    here.controller.sync(queueAt("2"));
    await settle();
    here.controller.playCurrentAt(songB.id, 61_000, false);
    await settle();

    expect(here.shown.ticker.read()).toBe(61_000);
  });
});
