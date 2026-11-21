import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dayClock } from "./day-clock";

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 10, day, hour, minute).getTime();

describe("dayClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(21, 23, 50));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves to the next day at local midnight and tells its listeners", () => {
    const clock = dayClock(() => Date.now());
    const heard = vi.fn<() => void>();

    clock.subscribe(heard);
    expect(clock.read()).toBe(at(21, 0));

    vi.advanceTimersByTime(9 * 60_000);
    expect(heard).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(clock.read()).toBe(at(22, 0));
    expect(heard).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(24 * 3_600_000);
    expect(clock.read()).toBe(at(23, 0));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("catches up on refresh after a midnight its timer missed", () => {
    let now = at(21, 23, 50);
    const clock = dayClock(() => now);
    const heard = vi.fn<() => void>();

    clock.subscribe(heard);
    now = at(22, 8);
    clock.refresh();

    expect(clock.read()).toBe(at(22, 0));
    expect(heard).toHaveBeenCalledOnce();

    clock.refresh();
    expect(heard).toHaveBeenCalledOnce();
  });

  it("reads the day afresh when someone starts listening", () => {
    const clock = dayClock(() => Date.now());

    vi.setSystemTime(at(22, 0, 5));
    clock.subscribe(() => undefined);

    expect(clock.read()).toBe(at(22, 0));
  });

  it("keeps no timer once its last listener leaves", () => {
    const clock = dayClock(() => Date.now());
    const stop = clock.subscribe(() => undefined);

    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
