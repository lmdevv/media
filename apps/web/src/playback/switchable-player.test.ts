import type { PlayerEvent, PlayerPort } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { SwitchablePlayer } from "./switchable-player";

class RecordingPlayer implements PlayerPort {
  readonly commands: Array<string> = [];
  position = 0;
  paused = true;
  readonly #listeners = new Set<(event: PlayerEvent) => void>();

  emit(event: PlayerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  readonly positionMs = (): number => this.position;
  readonly isPaused = (): boolean => this.paused;
  readonly isBuffering = (): boolean => false;
  readonly playbackRate = (): number => 1;

  readonly setPlaybackRate = (rate: number): void => {
    this.commands.push(`rate ${String(rate)}`);
  };

  readonly seek = (positionMs: number): void => {
    this.commands.push(`seek ${String(positionMs)}`);
  };

  readonly play = (): Promise<void> => {
    this.commands.push("play");

    return Promise.resolve();
  };

  readonly pause = (): void => {
    this.commands.push("pause");
  };

  readonly subscribe = (listener: (event: PlayerEvent) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
}

describe("SwitchablePlayer", () => {
  it("sends commands to and reports events from the current target only", async () => {
    const local = new RecordingPlayer();
    const remote = new RecordingPlayer();
    const player = new SwitchablePlayer(local);
    const events: Array<PlayerEvent> = [];

    player.subscribe((event) => events.push(event));
    local.position = 12_000;
    expect(player.positionMs()).toBe(12_000);

    player.switchTo(remote);
    remote.position = 30_000;
    remote.paused = false;
    local.emit("paused");
    remote.emit("playing");
    player.seek(45_000);
    await player.play();

    expect(player.target).toBe(remote);
    expect(player.positionMs()).toBe(30_000);
    expect(player.isPaused()).toBe(false);
    expect(events).toStrictEqual(["playing"]);
    expect(remote.commands).toStrictEqual(["seek 45000", "play"]);
    expect(local.commands).toStrictEqual([]);
    expect(local.listeners).toBe(0);

    player.switchTo(local);
    local.emit("seeked");
    remote.emit("ended");
    expect(events).toStrictEqual(["playing", "seeked"]);
  });
});
