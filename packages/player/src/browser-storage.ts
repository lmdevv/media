import { Option, Schema } from "effect";

import type { PlayerSettings, ResumePoint } from "./playback-controller";
import { streamQualities } from "./stream-quality";
import type { StreamQuality } from "./stream-quality";

const QUALITY_KEY = "music.streamQuality";

const VOLUME_KEY = "music.volume";

const RESUME_KEY = "music.resume.v1";

/** The part of `Storage` the player uses. */
interface KeyValueStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

/**
 * The browser's `localStorage`, or null where there is none (outside a browser) or where reading it
 * throws: with cookies blocked, Chrome throws on the `localStorage` getter itself.
 */
export const browserStorage = (): KeyValueStorage | null => {
  try {
    return "localStorage" in globalThis ? globalThis.localStorage : null;
  } catch {
    return null;
  }
};

/** Reads a key, treating a storage that throws (blocked cookies, Safari private mode) as empty. */
const readItem = (storage: KeyValueStorage | null, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/** Writes a key, or removes it for null, ignoring a storage that throws: the value then lasts for this page only. */
const writeItem = (storage: KeyValueStorage | null, key: string, value: string | null): void => {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {}
};

const Volume = Schema.FiniteFromString.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

const decodeVolume = Schema.decodeUnknownOption(Volume);

const ResumeJson = Schema.fromJsonString(
  Schema.Struct({
    itemId: Schema.String,
    positionMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

const decodeResume = Schema.decodeUnknownOption(ResumeJson);

const encodeResume = Schema.encodeSync(ResumeJson);

/**
 * What this browser chose the last time, for a session whose settings the core cannot keep for
 * this device, or before they load: old music kept quality and volume per browser.
 */
export const browserSettings = (
  storage: KeyValueStorage | null,
  gapless: boolean,
): PlayerSettings => {
  const quality = readItem(storage, QUALITY_KEY);

  return {
    quality: streamQualities.find((known) => known === quality) ?? "lossless",
    volume: Option.getOrElse(decodeVolume(readItem(storage, VOLUME_KEY)), () => 1),
    gapless,
  };
};

/** Remembers the quality chosen on this browser. */
export const saveBrowserQuality = (
  storage: KeyValueStorage | null,
  quality: StreamQuality,
): void => {
  writeItem(storage, QUALITY_KEY, quality);
};

/** Remembers the volume chosen on this browser. */
export const saveBrowserVolume = (storage: KeyValueStorage | null, volume: number): void => {
  writeItem(storage, VOLUME_KEY, String(volume));
};

/** Where this browser left the playing song, kept across page loads as old music's server kept it. */
export const browserResume = (storage: KeyValueStorage | null) => ({
  load: (): ResumePoint | null => Option.getOrNull(decodeResume(readItem(storage, RESUME_KEY))),
  save: (point: ResumePoint | null): void => {
    writeItem(storage, RESUME_KEY, point === null ? null : encodeResume(point));
  },
});
