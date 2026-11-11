import type { PlayerEvent, PlayerPort } from "@media/sdk/effect";
import { Playback } from "@media/sdk/effect";
import { Brand } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoreStart, PlayCommands } from "./play-session";
import { reportProgress } from "./progress-reporter";
import type { ReportedStart } from "./progress-reporter";

type Report = Parameters<PlayCommands["report"]>[0];

type Receipt = Awaited<ReturnType<PlayCommands["report"]>>;

/** A player whose position and pause state the test sets, and whose events it fires. */
class FakePlayer implements PlayerPort {
  position = 0;
  paused = true;
  readonly #listeners = new Set<(event: PlayerEvent) => void>();

  positionMs = (): number => this.position;
  isPaused = (): boolean => this.paused;
  isBuffering = (): boolean => false;
  playbackRate = (): number => 1;
  setPlaybackRate = (): void => undefined;
  seek = (positionMs: number): void => {
    this.position = positionMs;
  };
  play = (): Promise<void> => {
    this.paused = false;

    return Promise.resolve();
  };
  pause = (): void => {
    this.paused = true;
  };
  subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

const fileId = Brand.nominal<CoreStart["file"]["id"]>()("file1");

const start: ReportedStart = {
  file: { id: fileId },
  playbackId: "playback-1",
  startedAt: 1_762_000_000_000,
};

/** `movies.play.report` that records each report and answers as `answer` says. */
const recordingReports = (answer: (report: Report) => Promise<Receipt>) => {
  const sent: Array<Report> = [];

  const report: PlayCommands["report"] = (args) => {
    sent.push(args);

    return answer(args);
  };

  return { report, sent };
};

const applied = (): Promise<Receipt> => Promise.resolve({ applied: true, watched: false });

const events = (sent: ReadonlyArray<Report>) => sent.map((each) => [each.event, each.positionMs]);

const startOf = (player: FakePlayer, report: PlayCommands["report"]) =>
  reportProgress(report, start, player);

describe("reportProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every ten seconds while playing, with the start's playback and time", async () => {
    const player = new FakePlayer();
    const { report, sent } = recordingReports(applied);
    const stop = startOf(player, report);

    await vi.advanceTimersByTimeAsync(Playback.PROGRESS_INTERVAL_MS);
    expect(sent).toEqual([]);

    player.paused = false;
    player.position = 12_345.6;
    await vi.advanceTimersByTimeAsync(Playback.PROGRESS_INTERVAL_MS);
    player.position = 22_400;
    await vi.advanceTimersByTimeAsync(Playback.PROGRESS_INTERVAL_MS);

    expect(sent).toEqual([
      {
        fileId,
        positionMs: 12_346,
        event: "tick",
        playbackId: "playback-1",
        startedAt: 1_762_000_000_000,
      },
      {
        fileId,
        positionMs: 22_400,
        event: "tick",
        playbackId: "playback-1",
        startedAt: 1_762_000_000_000,
      },
    ]);

    await stop();
  });

  it("reports pause, resume, seek, and end as they happen, and nothing for a stall", async () => {
    const player = new FakePlayer();
    const { report, sent } = recordingReports(applied);
    const stop = startOf(player, report);

    player.position = 1_000;
    player.emit("playing");
    player.emit("waiting");
    player.position = 5_000;
    player.emit("seeked");
    player.emit("paused");
    player.position = 60_000;
    player.emit("ended");

    expect(events(sent)).toEqual([
      ["resume", 1_000],
      ["seek", 5_000],
      ["pause", 5_000],
      ["ended", 60_000],
    ]);

    await stop();
  });

  it("reports where playback stopped once, and nothing after", async () => {
    const player = new FakePlayer();
    const { report, sent } = recordingReports(applied);
    const stop = startOf(player, report);

    player.paused = false;
    player.position = 42_000;
    await Promise.all([stop(), stop()]);

    player.emit("paused");
    await vi.advanceTimersByTimeAsync(Playback.PROGRESS_INTERVAL_MS * 3);

    expect(events(sent)).toEqual([["pause", 42_000]]);
  });

  it("skips a report that fails and carries the position in the next one", async () => {
    const player = new FakePlayer();

    const { report, sent } = recordingReports((args) =>
      args.event === "seek" ? Promise.reject(new Error("offline")) : applied(),
    );

    const stop = startOf(player, report);

    player.position = 5_000;
    player.emit("seeked");
    player.paused = false;
    await vi.advanceTimersByTimeAsync(Playback.PROGRESS_INTERVAL_MS);

    expect(events(sent)).toEqual([
      ["seek", 5_000],
      ["tick", 5_000],
    ]);

    await stop();
  });

  it("stops waiting for the last report after two seconds", async () => {
    const player = new FakePlayer();
    const { report } = recordingReports(() => new Promise<Receipt>(() => undefined));
    const stopped = vi.fn();

    void startOf(player, report)().then(stopped);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toHaveBeenCalledOnce();
  });
});
