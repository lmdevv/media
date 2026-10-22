import { DeviceId } from "@music/commands/ids";
import type { DeviceKind } from "@music/commands/models";
import { Option, Schema } from "effect";

/** How this browser introduces itself in the device list. */
export interface DeviceDescription {
  /** A readable name such as "Firefox on macOS" or "Safari on iPhone". */
  readonly name: string;
  readonly kind: DeviceKind;
}

const browserName = (userAgent: string): string => {
  if (/Edg(e|A|iOS)?\//u.test(userAgent)) return "Edge";

  if (/OPR\/|Opera/u.test(userAgent)) return "Opera";

  if (/Firefox\/|FxiOS\//u.test(userAgent)) return "Firefox";

  if (/SamsungBrowser\//u.test(userAgent)) return "Samsung Internet";

  if (/Chrome\/|CriOS\//u.test(userAgent)) return "Chrome";

  if (/Safari\//u.test(userAgent)) return "Safari";

  return "Browser";
};

const platformName = (userAgent: string, maxTouchPoints: number): string => {
  if (/iPhone|iPod/u.test(userAgent)) return "iPhone";

  // iPadOS 13+ reports a Mac user agent; touch support gives it away.
  if (/iPad/u.test(userAgent) || (/Macintosh/u.test(userAgent) && maxTouchPoints > 1)) {
    return "iPad";
  }

  if (/Android/u.test(userAgent)) return "Android";

  if (/CrOS/u.test(userAgent)) return "ChromeOS";

  if (/Macintosh|Mac OS X/u.test(userAgent)) return "macOS";

  if (/Windows/u.test(userAgent)) return "Windows";

  if (/Linux/u.test(userAgent)) return "Linux";

  return "the web";
};

/**
 * Names this browser and decides its kind from `navigator.userAgent` and
 * `navigator.maxTouchPoints`. Touch phones (iPhone, Android with a mobile user agent) are
 * `phone`; tablets and computers are `web`.
 */
export const describeDevice = (userAgent: string, maxTouchPoints: number): DeviceDescription => {
  const platform = platformName(userAgent, maxTouchPoints);

  const phone = platform === "iPhone" || (platform === "Android" && /Mobile/u.test(userAgent));

  return { name: `${browserName(userAgent)} on ${platform}`, kind: phone ? "phone" : "web" };
};

/** The part of `localStorage` the player uses; a native app passes its own key-value store. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

const DEVICE_ID_KEY = "music.deviceId";

const decodeDeviceId = Schema.decodeUnknownOption(DeviceId);

/**
 * The stable device ID of this browser profile, kept in `localStorage` (or a native app's store).
 * Creates one with `generate` on first use. When storage is unavailable (blocked or private mode)
 * the ID lasts for this page only.
 */
export const loadDeviceId = (storage: KeyValueStorage | null, generate: () => string): DeviceId => {
  const stored = decodeDeviceId(readItem(storage, DEVICE_ID_KEY));

  if (Option.isSome(stored)) return stored.value;

  const created = DeviceId.make(generate());
  writeItem(storage, DEVICE_ID_KEY, created);

  return created;
};

/**
 * The browser's `localStorage`, or null where there is none (outside a browser) or where reading it
 * throws: with cookies blocked, Chrome throws on the `localStorage` getter itself.
 */
export const browserStorage = (): Storage | null => {
  try {
    return "localStorage" in globalThis ? globalThis.localStorage : null;
  } catch {
    return null;
  }
};

/** Reads a key, treating a storage that throws (blocked cookies, Safari private mode) as empty. */
export const readItem = (storage: KeyValueStorage | null, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/** Writes a key, ignoring a storage that throws: the value then lasts for this page only. */
export const writeItem = (storage: KeyValueStorage | null, key: string, value: string): void => {
  try {
    storage?.setItem(key, value);
  } catch {
    // Storage is full or blocked; the caller keeps the value in memory.
  }
};
