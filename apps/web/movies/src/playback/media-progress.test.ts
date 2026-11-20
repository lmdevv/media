import { describe, expect, it } from "vitest";

import { mediaProgress } from "./media-progress";
import type { ProgressElement, ProgressPlayer } from "./media-progress";

/** A `<video>` element's events and the parts its progress reads. */
class FakeElement extends EventTarget implements ProgressElement {
  currentTime = 0;
  ranges: ReadonlyArray<readonly [number, number]> = [];

  get buffered(): ProgressElement["buffered"] {
    const { ranges } = this;

    return {
      length: ranges.length,
      start: (index) => ranges[index]?.[0] ?? 0,
      end: (index) => ranges[index]?.[1] ?? 0,
    };
  }
}

/** A player at `positionMs` that tells its subscribers when it starts playing, on `change`. */
const fakePlayer = () => {
  const listeners = new Set<Parameters<ProgressPlayer["subscribe"]>[0]>();
  let positionMs = 0;

  const player: ProgressPlayer = {
    positionMs: () => positionMs,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    player,
    moveTo: (ms: number) => {
      positionMs = ms;
    },
    change: () => {
      for (const listener of listeners) listener("playing");
    },
  };
};

describe("mediaProgress", () => {
  it("reads the player's position in seconds and the buffer ahead of the element", () => {
    const element = new FakeElement();
    const fake = fakePlayer();

    fake.moveTo(42_500);
    element.currentTime = 42.5;
    element.ranges = [[40, 50]];

    const progress = mediaProgress(element, fake.player);

    expect(progress.position.get()).toBe(42.5);
    expect(progress.bufferedAhead.get()).toBe(7.5);
  });

  it("keeps one position for moves too small to see, and takes the next real one", () => {
    const element = new FakeElement();
    const fake = fakePlayer();
    const progress = mediaProgress(element, fake.player);

    fake.moveTo(10_000);
    expect(progress.position.get()).toBe(10);
    fake.moveTo(10_030);
    expect(progress.position.get()).toBe(10);
    fake.moveTo(10_250);
    expect(progress.position.get()).toBe(10.25);
    fake.moveTo(4_000);
    expect(progress.position.get()).toBe(4);
  });

  it("keeps one buffer ahead until it moves by half a second", () => {
    const element = new FakeElement();
    const fake = fakePlayer();

    element.ranges = [[0, 20]];

    const progress = mediaProgress(element, fake.player);

    expect(progress.bufferedAhead.get()).toBe(20);
    element.currentTime = 0.3;
    expect(progress.bufferedAhead.get()).toBe(20);
    element.currentTime = 1;
    expect(progress.bufferedAhead.get()).toBe(19);
  });

  it("tells its followers of the element's media events and the player's changes until they stop", () => {
    const element = new FakeElement();
    const fake = fakePlayer();
    const progress = mediaProgress(element, fake.player);
    const heard: Array<number> = [];

    const stop = progress.position.subscribe(() => heard.push(progress.position.get()));

    fake.moveTo(1_000);
    element.dispatchEvent(new Event("timeupdate"));
    fake.moveTo(30_000);
    fake.change();
    fake.moveTo(31_000);
    element.dispatchEvent(new Event("seeked"));
    stop();
    fake.moveTo(32_000);
    element.dispatchEvent(new Event("timeupdate"));
    fake.change();

    expect(heard).toStrictEqual([1, 30, 31]);
  });
});
