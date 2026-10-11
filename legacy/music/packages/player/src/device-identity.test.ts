import { describe, expect, it } from "vitest";

import { describeDevice, loadDeviceId } from "./device-identity";

const agents = {
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("describeDevice", () => {
  it.each([
    [agents.macFirefox, 0, "Firefox on macOS", "web"],
    [agents.macSafari, 0, "Safari on macOS", "web"],
    [agents.macSafari, 5, "Safari on iPad", "web"],
    [agents.iphoneSafari, 5, "Safari on iPhone", "phone"],
    [agents.iphoneChrome, 5, "Chrome on iPhone", "phone"],
    [agents.androidChrome, 5, "Chrome on Android", "phone"],
    [agents.androidTablet, 10, "Chrome on Android", "web"],
    [agents.windowsEdge, 0, "Edge on Windows", "web"],
    [agents.linuxChrome, 0, "Chrome on Linux", "web"],
    ["curl/8.0", 0, "Browser on the web", "web"],
  ])("names %s (touch %d) as %s", (userAgent, touch, name, kind) => {
    expect(describeDevice(userAgent, touch)).toEqual({ name, kind });
  });
});

/** A `Storage` held in memory, as `localStorage` behaves within one page. */
class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

describe("loadDeviceId", () => {
  it("creates an ID once and keeps returning it", () => {
    const storage = new MemoryStorage();
    let calls = 0;

    const generate = (): string => {
      calls += 1;

      return `device-${calls}`;
    };

    expect(loadDeviceId(storage, generate)).toBe("device-1");
    expect(loadDeviceId(storage, generate)).toBe("device-1");
    expect(calls).toBe(1);
  });

  it("replaces a corrupt stored value", () => {
    const storage = new MemoryStorage();
    storage.setItem("music.deviceId", "");

    expect(loadDeviceId(storage, () => "fresh")).toBe("fresh");
  });

  it("still returns an ID without storage", () => {
    expect(loadDeviceId(null, () => "ephemeral")).toBe("ephemeral");
  });
});
