import type { PlayerEvent } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { StallVerdict, checked, watching } from "./stall-watchdog";
import { NATIVE_SEEKER, VideoPort, withinBuffer } from "./video-port";
import type { NativeStatus, NativeVideo, NativeVideoEvents } from "./video-port";

type Listeners = { [Name in keyof NativeVideoEvents]: Set<NativeVideoEvents[Name]> };

class TestVideo implements NativeVideo {
  playbackRate = 1;
  playing = false;
  status: NativeStatus = "idle";
  bufferedPosition = 0;
  released = false;
  /** AVPlayer starts playing a moment after `play`, as its events reach JS later. */
  startsLater = false;
  readonly #listeners: Listeners = {
    playingChange: new Set(),
    statusChange: new Set(),
    playToEnd: new Set(),
    timeUpdate: new Set(),
  };
  /** AVPlayer was asked to play while it had no data, so it plays once it has. */
  #waitingToPlay = false;
  #currentTime = 0;
  /** The time AVPlayer reads after its next read. */
  #turnsTo: number | null = null;

  /** expo-video reads AVPlayer's time afresh on every access. */
  get currentTime(): number {
    const seconds = this.#currentTime;

    if (this.#turnsTo !== null) {
      this.#currentTime = this.#turnsTo;
      this.#turnsTo = null;
    }

    return seconds;
  }

  set currentTime(seconds: number) {
    this.#currentTime = seconds;
    this.#turnsTo = null;
  }

  /** AVPlayer's time turns to `seconds` right after its next read, as it can turn invalid. */
  turnsAfterNextRead(seconds: number): void {
    this.#turnsTo = seconds;
  }

  play(): void {
    this.#use();

    if (this.status === "loading" || this.startsLater) {
      this.#waitingToPlay = true;

      return;
    }

    this.#setPlaying(true);
  }

  pause(): void {
    this.#use();
    this.#waitingToPlay = false;
    this.#setPlaying(false);
  }

  addListener<Name extends keyof NativeVideoEvents>(
    event: Name,
    listener: NativeVideoEvents[Name],
  ) {
    const set: Set<NativeVideoEvents[Name]> = this.#listeners[event];

    set.add(listener);

    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  firePlaying(isPlaying: boolean): void {
    for (const listener of this.#listeners.playingChange) listener({ isPlaying });
  }

  fireStatus(status: NativeStatus): void {
    for (const listener of this.#listeners.statusChange) listener({ status });
  }

  fireEnd(): void {
    for (const listener of this.#listeners.playToEnd) listener();
  }

  /** AVPlayer's periodic time report, at `seconds`. */
  fireTime(seconds: number): void {
    this.currentTime = seconds;

    for (const listener of this.#listeners.timeUpdate) {
      listener({
        currentTime: seconds,
        currentLiveTimestamp: null,
        currentOffsetFromLive: null,
        bufferedPosition: this.bufferedPosition,
      });
    }
  }

  /** AVPlayer stalls for data: `waitingToPlay` makes expo-video report loading, then not playing. */
  stall(): void {
    this.status = "loading";
    this.fireStatus("loading");
    this.#waitingToPlay = true;
    this.#setPlaying(false);
  }

  /** AVPlayer starts playing as `play` asked, when `startsLater` or loading held it back. */
  start(): void {
    if (this.#waitingToPlay) {
      this.#waitingToPlay = false;
      this.#setPlaying(true);
    }
  }

  /** AVPlayer has data again: expo-video reports it ready, and AVPlayer plays if it was waiting to. */
  ready(): void {
    this.status = "readyToPlay";
    this.fireStatus("readyToPlay");
    this.start();
  }

  listenerCount(): number {
    return Object.values(this.#listeners).reduce((total, set) => total + set.size, 0);
  }

  /** expo-video reports a playing change only when `isPlaying` changes. */
  #setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.firePlaying(playing);
  }

  #use(): void {
    if (this.released) throw new Error("released");
  }
}

class TestClock {
  ms = 0;
  readonly now = (): number => this.ms;
}

const playFor = (video: TestVideo, clock: TestClock, seconds: number): void => {
  for (let step = 0; step < seconds * 4; step += 1) {
    clock.ms += 250;
    video.fireTime(video.currentTime + 0.25);
  }
};

const portOn = (video: TestVideo, seeker = NATIVE_SEEKER): VideoPort => {
  const port = new VideoPort();

  port.attach(video, { positionMs: 0, durationMs: null, seeker });

  return port;
};

const recorded = (port: VideoPort): Array<PlayerEvent> => {
  const events: Array<PlayerEvent> = [];

  port.subscribe((event) => events.push(event));

  return events;
};

describe("VideoPort", () => {
  it("reports AVPlayer's position, play, pause, and end", async () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    port.attach(video, { positionMs: 0, durationMs: null, seeker: NATIVE_SEEKER });

    const events = recorded(port);

    await port.play();
    clock.ms += 12_500;
    video.currentTime = 12.5;
    expect(port.positionMs()).toBe(12_500);
    expect(port.isPaused()).toBe(false);
    port.pause();
    expect(port.isPaused()).toBe(true);
    video.fireEnd();
    expect(events).toStrictEqual(["playing", "paused", "ended"]);
  });

  it("follows pauses from outside the app's controls", () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    video.play();
    video.pause();
    expect(events).toStrictEqual(["playing", "paused"]);
    expect(port.getState().playing).toBe(false);
  });

  it("counts a stall while meant to play as buffering", async () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    await port.play();
    video.fireStatus("loading");
    expect(port.isBuffering()).toBe(true);
    expect(events).toContain("waiting");
    video.fireStatus("readyToPlay");
    expect(port.isBuffering()).toBe(false);
  });

  it("seeks directly where AVPlayer reaches", () => {
    const video = new TestVideo();
    const port = portOn(video);
    const events = recorded(port);

    port.seek(42_000);
    expect(video.currentTime).toBe(42);
    expect(events).toStrictEqual(["seeked"]);
  });

  it("holds a moved stream's target until the move lands", async () => {
    const video = new TestVideo();
    const landings: Array<() => void> = [];

    const port = portOn(video, {
      reaches: () => false,
      move: (positionMs) =>
        new Promise((resolve) => {
          landings.push(() => {
            video.currentTime = positionMs / 1000;
            resolve();
          });
        }),
    });

    const events = recorded(port);

    await port.play();
    port.seek(3_600_000);
    // Reloading the stream pauses AVPlayer; that is not the viewer's pause.
    video.pause();
    expect(port.positionMs()).toBe(3_600_000);
    expect(port.isBuffering()).toBe(true);
    expect(port.isPaused()).toBe(false);
    // A seek the media service must transcode toward may take as long as a new stream.
    expect(port.settling()).toBe(true);
    landings[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toStrictEqual(["playing", "waiting", "seeked"]);
    expect(port.positionMs()).toBe(3_600_000);
    expect(port.settling()).toBe(false);
  });

  it("drops a move a newer seek replaced", async () => {
    const video = new TestVideo();
    const signals: Array<AbortSignal> = [];

    const port = portOn(video, {
      reaches: (positionMs) => positionMs < 10_000,
      move: (_positionMs, signal) => {
        signals.push(signal);

        return Promise.resolve();
      },
    });

    const events = recorded(port);

    port.seek(60_000);
    port.seek(5_000);
    await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
    expect(port.positionMs()).toBe(5_000);
    expect(events).toStrictEqual(["waiting", "seeked"]);
  });

  it("reports a loading stream's start, without its pauses", () => {
    const video = new TestVideo();
    const port = new VideoPort();
    const events = recorded(port);

    port.attach(video, { positionMs: 600_000, durationMs: null, seeker: NATIVE_SEEKER });
    video.pause();
    expect(port.positionMs()).toBe(600_000);
    expect(events).toStrictEqual([]);
    video.currentTime = 600;
    video.play();
    expect(events).toStrictEqual(["playing"]);
  });

  it("moves to the next stream's player and plays it as the viewer wanted", async () => {
    const first = new TestVideo();
    const next = new TestVideo();
    const port = portOn(first);
    const events = recorded(port);

    await port.play();
    port.attach(next, { positionMs: 1_200_000, durationMs: null, seeker: NATIVE_SEEKER });
    first.pause();
    expect(next.playing).toBe(true);
    expect(events).toStrictEqual(["playing", "playing"]);
    next.currentTime = 1201;
    expect(port.positionMs()).toBe(1_201_000);
  });

  it("keeps the last position after disposal without touching the released player", () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    port.attach(video, { positionMs: 0, durationMs: null, seeker: NATIVE_SEEKER });
    video.play();
    playFor(video, clock, 90);
    port.dispose();
    video.released = true;
    video.currentTime = 0;
    expect(port.positionMs()).toBe(90_000);
    expect(port.isPaused()).toBe(true);
    port.pause();
    port.seek(5);
    expect(video.listenerCount()).toBe(0);
  });
});

const MINUTES_36 = 36 * 60;

const EPISODE_MS = 47 * 60 * 1000;

const playingAt = (seconds: number) => {
  const clock = new TestClock();
  const video = new TestVideo();
  const port = new VideoPort(clock.now);
  const events = recorded(port);

  port.attach(video, {
    positionMs: seconds * 1000,
    durationMs: EPISODE_MS,
    seeker: NATIVE_SEEKER,
  });
  video.currentTime = seconds;
  void port.play();
  playFor(video, clock, 10);

  return { clock, video, port, events };
};

describe("VideoPort when the stream vanishes", () => {
  it("keeps the position it played to when AVPlayer skips the missing segments to the end", async () => {
    const { clock, video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    // Every segment answers 404: AVPlayer races to the end of the playlist and calls it the end.
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000);
    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();

    expect(reached).toBeCloseTo((MINUTES_36 + 10) * 1000, -2);
    expect(port.positionMs()).toBe(reached);
    expect(port.getState().positionSeconds * 1000).toBe(reached);
    expect(events).not.toContain("ended");
    // AVPlayer's stop before its end looks like any pause, until the end shows it was not one.
    expect(events.at(-1)).toBe("waiting");
    expect(port.wantsToPlay()).toBe(true);
    expect(port.isBuffering()).toBe(true);

    await port.play();
    expect(port.positionMs()).toBe(reached);
    expect(video.currentTime).not.toBe(0);
  });

  it("treats an end AVPlayer reports far from the media's end as a lost stream", () => {
    const { video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    // AVPlayer gives up on the playlist without moving its clock.
    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();

    expect(events).not.toContain("ended");
    expect(port.positionMs()).toBe(reached);
    expect(port.isBuffering()).toBe(true);
  });

  it("keeps the position it played to when the native player resets to zero", () => {
    const { clock, video, port, events } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    video.stall();
    clock.ms += 250;
    video.fireTime(0);
    video.currentTime = 0.126;

    expect(port.positionMs()).toBe(reached);
    expect(port.getState().positionSeconds * 1000).toBe(reached);
    expect(events).not.toContain("paused");
    expect(port.isPaused()).toBe(false);
    expect(port.isBuffering()).toBe(true);
  });

  it("counts a stall as buffering, not as the viewer pausing", () => {
    const { port, video, events } = playingAt(600);

    video.stall();

    expect(events).toContain("waiting");
    expect(events).not.toContain("paused");
    expect(port.wantsToPlay()).toBe(true);
    expect(port.isPaused()).toBe(false);
  });

  it("still ends at the real end, and plays from the start after it", async () => {
    const { clock, video, port, events } = playingAt(EPISODE_MS / 1000 - 10);

    video.playing = false;
    video.firePlaying(false);
    video.fireEnd();
    expect(events.at(-1)).toBe("ended");
    expect(port.getState().ended).toBe(true);

    clock.ms += 1_000;
    await port.play();
    expect(video.currentTime).toBe(0);
  });

  it("follows a jump AVPlayer makes on its own once it plays on from there", () => {
    const { clock, video, port } = playingAt(600);

    // A seek from the lock screen moves AVPlayer without the app.
    clock.ms += 250;
    video.fireTime(1_500);
    expect(port.positionMs()).toBeCloseTo(610_000, -3);

    playFor(video, clock, 4);
    expect(port.positionMs()).toBeCloseTo(1_504_000, -3);
  });

  it("counts no loading time as played", () => {
    const clock = new TestClock();
    const video = new TestVideo();
    const port = new VideoPort(clock.now);

    video.status = "loading";
    port.attach(video, { positionMs: 600_000, durationMs: EPISODE_MS, seeker: NATIVE_SEEKER });
    void port.play();
    video.currentTime = 600;
    clock.ms += 30_000;
    video.ready();
    clock.ms += 250;
    video.fireTime(630);

    expect(port.positionMs()).toBe(600_000);
  });

  it("takes a pause right after a jump from the lock screen as the viewer's", () => {
    const { clock, video, port, events } = playingAt(600);

    clock.ms += 250;
    video.fireTime(615);
    clock.ms += 500;
    video.pause();

    expect(events.at(-1)).toBe("paused");
    expect(port.wantsToPlay()).toBe(false);
    expect(port.isBuffering()).toBe(false);

    clock.ms += 60_000;
    video.play();
    playFor(video, clock, 3);
    expect(port.positionMs()).toBeCloseTo(618_000, -3);
  });

  it("never follows a reset player that sits at zero", () => {
    const { clock, video, port } = playingAt(MINUTES_36);
    const reached = port.positionMs();

    video.stall();

    for (let tick = 0; tick < 120; tick += 1) {
      clock.ms += 250;
      video.fireTime(0);
    }

    expect(port.positionMs()).toBe(reached);
  });
});

const recoversAfterFirstLimit = (port: VideoPort, clock: TestClock): boolean => {
  const watch = watching(port.positionMs(), clock.ms);

  const [, verdict] = checked(watch, {
    atMs: clock.ms + 15_000,
    positionMs: port.positionMs(),
    intended: port.wantsToPlay(),
    loading: port.settling(),
  });

  return StallVerdict.$is("Recover")(verdict);
};

describe("VideoPort with the lock screen and stalls", () => {
  it("ends after a seek from the lock screen to the last seconds", () => {
    const { clock, video, port, events } = playingAt(600);

    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000 - 2);
    playFor(video, clock, 2);
    video.pause();
    video.fireEnd();

    expect(events.at(-1)).toBe("ended");
    expect(port.getState().ended).toBe(true);
    expect(port.isBuffering()).toBe(false);
    expect(port.positionMs()).toBe(EPISODE_MS);
  });

  it("ends after a seek from the lock screen to the last half second", () => {
    const { clock, video, port, events } = playingAt(600);

    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000 - 0.5);
    playFor(video, clock, 0.5);
    video.pause();
    video.fireEnd();

    expect(events.at(-1)).toBe("ended");
    expect(port.positionMs()).toBe(EPISODE_MS);
  });

  it("ends after a seek from the lock screen to the last half second at double speed", () => {
    const { clock, video, events } = playingAt(600);

    video.playbackRate = 2;
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000 - 0.5);
    clock.ms += 125;
    video.fireTime(EPISODE_MS / 1000 - 0.25);
    clock.ms += 125;
    video.fireTime(EPISODE_MS / 1000);
    video.pause();
    video.fireEnd();

    expect(events.at(-1)).toBe("ended");
  });

  it("never ends at a skip to the end while AVPlayer is not playing", () => {
    const { clock, video, port, events } = playingAt(600);
    const reached = port.positionMs();

    // The stream vanishes in a stall: AVPlayer skips the last failing segments without playing them.
    video.stall();
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000);
    video.fireEnd();

    expect(events).not.toContain("ended");
    expect(port.getState().ended).toBe(false);
    expect(port.positionMs()).toBe(reached);
    expect(port.wantsToPlay()).toBe(true);
    expect(port.isBuffering()).toBe(true);
  });

  it("never ends at a short skip to the end at double speed", () => {
    const { clock, video, port, events } = playingAt(600);

    video.playbackRate = 2;
    clock.ms += 10;
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 10;
    video.fireTime(EPISODE_MS / 1000);
    video.pause();
    video.fireEnd();

    expect(events).not.toContain("ended");
    expect(port.positionMs()).toBeCloseTo(610_000, -3);
  });

  it("never ends at a skip that races to the end in short steps while AVPlayer plays", () => {
    const { clock, video, port, events } = playingAt(600);

    // Each failing segment moves AVPlayer a second and a half on in ten milliseconds.
    for (let seconds = 2_700; seconds <= EPISODE_MS / 1000; seconds += 1.5) {
      clock.ms += 10;
      video.fireTime(seconds);
    }

    video.pause();
    video.fireEnd();

    expect(events).not.toContain("ended");
    expect(port.positionMs()).toBeCloseTo(610_000, -3);
  });

  it.each([0.5, 0.75, 1, 1.25, 1.5, 2])(
    "ends after a seek from the lock screen to the last second at %s times speed",
    (rate) => {
      const { clock, video, port } = playingAt(600);

      video.playbackRate = rate;
      clock.ms += 250;
      video.fireTime(EPISODE_MS / 1000 - 1);

      for (let report = 0; report < 4; report += 1) {
        clock.ms += 250 / rate;
        video.fireTime(video.currentTime + 0.25);
      }

      video.pause();
      video.fireEnd();

      expect(port.getState().ended).toBe(true);
    },
  );

  it("ends after a seek from the lock screen to the last half second at 1.5 times speed", () => {
    const { clock, video, port } = playingAt(600);

    video.playbackRate = 1.5;
    video.fireTime(EPISODE_MS / 1000 - 0.5);
    clock.ms += 250 / 1.5;
    video.fireTime(EPISODE_MS / 1000 - 0.25);
    // The last quarter second plays without a time report; AVPlayer's stop is the next sighting.
    clock.ms += 250 / 1.5;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
  });

  it("ends after a seek from the lock screen to the last second when the viewer slows down", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(2);
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 400;
    video.fireTime(EPISODE_MS / 1000 - 0.2);
    port.setPlaybackRate(0.5);
    clock.ms += 400;
    video.fireTime(EPISODE_MS / 1000);
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
    expect(port.positionMs()).toBe(EPISODE_MS);
  });

  it("ends when the viewer slows down between AVPlayer's time reports in the last second", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(2);
    video.fireTime(EPISODE_MS / 1000 - 0.6);
    clock.ms += 200;
    video.currentTime = EPISODE_MS / 1000 - 0.2;
    port.setPlaybackRate(0.5);
    clock.ms += 400;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
  });

  it("keeps the media a lock-screen seek played when AVPlayer reads zero as the speed changes", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(0.5);
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 1_200;
    video.fireTime(EPISODE_MS / 1000 - 0.4);
    // expo-video reads AVPlayer's NaN time as zero.
    video.currentTime = 0;
    port.setPlaybackRate(2);
    clock.ms += 200;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
  });

  it("keeps the media a lock-screen seek played when AVPlayer's time turns zero as the speed changes", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(2);
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 400;
    video.currentTime = EPISODE_MS / 1000 - 0.2;
    // expo-video reads AVPlayer's NaN time as zero.
    video.turnsAfterNextRead(0);
    port.setPlaybackRate(0.5);
    clock.ms += 400;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
    expect(port.positionMs()).toBe(EPISODE_MS);
  });

  it("ends at the real end when AVPlayer's time turns zero as it ends", () => {
    const { video, port } = playingAt(EPISODE_MS / 1000 - 10);

    video.pause();
    video.turnsAfterNextRead(0);
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
    expect(port.positionMs()).toBe(EPISODE_MS);
  });

  it("keeps the media a lock-screen seek played when AVPlayer reports no valid time", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(0.5);
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 1_200;
    video.fireTime(EPISODE_MS / 1000 - 0.4);
    clock.ms += 250;
    video.fireTime(Number.NaN);
    clock.ms += 550;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
  });

  it("keeps the media a lock-screen seek played when AVPlayer reads zero as it stalls", () => {
    const { clock, video, port } = playingAt(600);

    port.setPlaybackRate(0.5);
    video.fireTime(EPISODE_MS / 1000 - 1);
    clock.ms += 1_200;
    video.fireTime(EPISODE_MS / 1000 - 0.4);
    video.currentTime = 0;
    video.stall();
    video.currentTime = EPISODE_MS / 1000 - 0.4;
    video.ready();
    clock.ms += 800;
    video.currentTime = EPISODE_MS / 1000;
    video.pause();
    video.fireEnd();

    expect(port.getState().ended).toBe(true);
  });

  it("keeps the viewer's pause in the app when a vanished stream ends just after it", () => {
    const { clock, video, port } = playingAt(600);

    port.pause();
    clock.ms += 250;
    video.fireTime(EPISODE_MS / 1000);
    video.fireEnd();

    expect(port.wantsToPlay()).toBe(false);
    expect(port.isBuffering()).toBe(false);
    expect(recoversAfterFirstLimit(port, clock)).toBe(false);
  });

  it("shows where AVPlayer paused, between its time reports", () => {
    const { clock, video, port } = playingAt(600);

    clock.ms += 200;
    video.currentTime = 610.2;
    video.pause();

    expect(port.getState().positionSeconds).toBeCloseTo(610.2, 3);
  });

  it("shows where AVPlayer paused when its time turns zero as it pauses", () => {
    const { clock, video, port } = playingAt(600);

    clock.ms += 200;
    video.currentTime = 610.2;
    video.turnsAfterNextRead(0);
    video.pause();

    expect(port.getState().positionSeconds).toBeCloseTo(610.2, 3);
  });

  it("counts no stalled time toward where AVPlayer could have played", () => {
    const { clock, video, port } = playingAt(600);
    const reached = port.positionMs();

    video.stall();
    clock.ms += 10_000;
    video.fireTime(620);

    expect(port.positionMs()).toBe(reached);
    expect(port.getState().positionSeconds * 1000).toBe(reached);
  });

  it("counts no paused time toward where AVPlayer could have played", () => {
    const { clock, video, port } = playingAt(600);
    const reached = port.positionMs();

    video.pause();
    clock.ms += 60_000;
    video.fireTime(640);
    expect(port.positionMs()).toBe(reached);

    // Played on from there, the jump is the viewer's, as a seek from the lock screen is.
    video.play();
    playFor(video, clock, 3);
    expect(port.positionMs()).toBeCloseTo(643_000, -3);
  });

  it("keeps recovering a stall that stands ready without AVPlayer playing on", () => {
    const { clock, video, port } = playingAt(600);
    let watch = watching(port.positionMs(), clock.ms);
    let recovered = false;

    // expo-video reports ready once AVPlayer is likely to keep up, whether or not it plays on. A
    // pause from the lock screen during a stall reports the same, so the watchdog resumes it too.
    video.stall();
    video.status = "readyToPlay";
    video.fireStatus("readyToPlay");

    for (let second = 1; second <= 15; second += 1) {
      clock.ms += 1_000;

      const [next, verdict] = checked(watch, {
        atMs: clock.ms,
        positionMs: port.positionMs(),
        intended: port.wantsToPlay(),
        loading: port.settling(),
      });

      watch = next;
      recovered = StallVerdict.$is("Recover")(verdict);
    }

    expect(port.wantsToPlay()).toBe(true);
    expect(recovered).toBe(true);
  });

  it("takes no pause from a stall the viewer paused in the app, once they play again", () => {
    const { clock, video, port, events } = playingAt(600);

    video.stall();
    port.pause();
    video.ready();
    clock.ms += 10_000;
    video.startsLater = true;
    void port.play();
    video.start();

    expect(events.at(-1)).toBe("playing");
    expect(events.filter((event) => event === "paused")).toStrictEqual([]);
    expect(port.wantsToPlay()).toBe(true);
  });

  it("keeps playing intended when AVPlayer plays on after a stall", () => {
    const { clock, video, port, events } = playingAt(600);

    video.stall();
    clock.ms += 5_000;
    video.ready();
    clock.ms += 5_000;

    expect(events).not.toContain("paused");
    expect(port.wantsToPlay()).toBe(true);
  });

  it("still recovers a stalled player that reset, even once it stands ready", () => {
    const { clock, video, port } = playingAt(MINUTES_36);

    video.stall();
    clock.ms += 250;
    video.fireTime(0);
    video.currentTime = 0.126;
    video.pause();
    video.ready();
    clock.ms += 5_000;

    expect(port.wantsToPlay()).toBe(true);
    expect(recoversAfterFirstLimit(port, clock)).toBe(true);
  });

  it("still recovers a lost stream, even once it stands ready", () => {
    const { clock, video, port } = playingAt(MINUTES_36);

    video.pause();
    video.fireEnd();
    video.stall();
    video.pause();
    video.ready();
    clock.ms += 5_000;

    expect(port.wantsToPlay()).toBe(true);
    expect(recoversAfterFirstLimit(port, clock)).toBe(true);
  });
});

describe("withinBuffer", () => {
  it("reaches from a little behind the playhead to what is buffered", () => {
    expect(withinBuffer(100, 130, 0, 120)).toBe(true);
    expect(withinBuffer(100, 130, 0, 80)).toBe(true);
    expect(withinBuffer(100, 130, 0, 130.4)).toBe(true);
    expect(withinBuffer(100, 130, 0, 140)).toBe(false);
    expect(withinBuffer(100, 130, 0, 60)).toBe(false);
    expect(withinBuffer(100, 0, 0, 100)).toBe(false);
  });

  it("holds nothing before the generation playing began", () => {
    expect(withinBuffer(2400, 2430, 2400, 2390)).toBe(false);
    expect(withinBuffer(2420, 2450, 2400, 2405)).toBe(true);
  });
});
