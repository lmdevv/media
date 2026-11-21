import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceSettingsSaves } from "./device-settings";

type Patch = Parameters<ConstructorParameters<typeof DeviceSettingsSaves>[0]>[0];

/** A core that records each save and never answers it. */
const core = () => {
  const sent: Array<Patch> = [];

  const save = async (patch: Patch): Promise<never> => {
    sent.push(patch);
    throw new Error("The core is away");
  };

  return { sent, save };
};

describe("DeviceSettingsSaves", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves the last volume once it stops changing for half a second", async () => {
    const { sent, save } = core();
    const saves = new DeviceSettingsSaves(save, true);

    saves.volume(0.2);
    await vi.advanceTimersByTimeAsync(300);
    saves.volume(0.4);
    await vi.advanceTimersByTimeAsync(499);

    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([{ volume: 0.4 }]);
  });

  it("plays the volume chosen here over the core's answers until the core answers with it", () => {
    const saves = new DeviceSettingsSaves(core().save, true);

    saves.volume(0.4);

    expect(saves.volumeOf(0.8)).toBe(0.4);
    expect(saves.volumeOf(0.4)).toBe(0.4);
    expect(saves.volumeOf(0.6)).toBe(0.6);
  });

  it("saves the quality as the core's tier", () => {
    const { sent, save } = core();
    const saves = new DeviceSettingsSaves(save, true);

    saves.quality("lossless");
    saves.quality("data-saver");

    expect(sent).toEqual([{ streamQuality: "original" }, { streamQuality: "low" }]);
  });

  it("saves nothing while the core keeps no settings for this device", async () => {
    const { sent, save } = core();
    const saves = new DeviceSettingsSaves(save, false);

    saves.volume(0.4);
    saves.quality("high");
    await vi.runAllTimersAsync();

    expect(sent).toEqual([]);
    expect(saves.volumeOf(0.8)).toBe(0.8);
  });

  it("decides whether to save a volume when its save is due", async () => {
    const { sent, save } = core();
    const saves = new DeviceSettingsSaves(save, false);

    saves.volume(0.4);
    saves.keepsDevice(true);
    await vi.runAllTimersAsync();

    expect(sent).toEqual([{ volume: 0.4 }]);
  });
});
