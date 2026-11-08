import { DeviceId, ProfileId } from "@media/contracts/ids";
import { LogLevel, Option, Schema } from "effect";

import { QualityChoice } from "@/playback/quality";

import { randomUuid } from "@media/ui/lib/secure-context";

const PROFILE_KEY = "movies.profile";

const DEVICE_KEY = "movies.device";

const QUALITY_KEY = "movies.quality.v1";

const LOG_LEVEL_KEY = "movies.logLevel";

const decodeProfileId = Schema.decodeUnknownOption(ProfileId);

const decodeDeviceId = Schema.decodeUnknownOption(DeviceId);

const decodeQuality = Schema.decodeUnknownOption(QualityChoice);

const decodeLogLevel = Schema.decodeUnknownOption(Schema.Literals(LogLevel.values));

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null): void => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows, quotas); the choice then lasts for this visit.
  }
};

/**
 * The SDK console level a developer chose on this browser with
 * `localStorage.setItem("movies.logLevel", "Debug")`; the SDK's default when unset.
 */
export const loadLogLevel = (): LogLevel.LogLevel | undefined =>
  Option.getOrUndefined(decodeLogLevel(read(LOG_LEVEL_KEY)));

/** The profile last chosen on this browser, if any. */
export const loadProfileChoice = (): ProfileId | null =>
  Option.getOrNull(decodeProfileId(read(PROFILE_KEY)));

/** Remembers (or forgets, with null) the profile chosen on this browser. */
export const saveProfileChoice = (profileId: ProfileId | null): void => {
  write(PROFILE_KEY, profileId);
};

/**
 * This browser's device ID: one playback session and one room seat per device. Made once and
 * kept; without storage it lasts for this visit.
 */
export const loadDeviceId = (): DeviceId =>
  Option.getOrElse(decodeDeviceId(read(DEVICE_KEY)), () => {
    const created = DeviceId.make(`web-${randomUuid()}`);

    write(DEVICE_KEY, created);

    return created;
  });

/** The stream quality last chosen in the player on this browser; `auto` when none. */
export const loadQualityChoice = (): QualityChoice =>
  Option.getOrElse(decodeQuality(read(QUALITY_KEY)), () => "auto" as const);

/** Remembers the stream quality chosen on this browser. */
export const saveQualityChoice = (choice: QualityChoice): void => {
  write(QUALITY_KEY, choice);
};

/** Browser names by user-agent pattern, most specific first (Edge and Chrome also say Safari). */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//u, "Edge"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
];

/** Systems by user-agent pattern; iPhones and iPads also say Mac OS X. */
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone|iPad/u, "iOS"],
  [/Mac OS X/u, "macOS"],
  [/Android/u, "Android"],
  [/Windows/u, "Windows"],
];

const firstMatch = (
  agent: string,
  patterns: ReadonlyArray<readonly [RegExp, string]>,
  fallback: string,
): string => patterns.find(([pattern]) => pattern.test(agent))?.[1] ?? fallback;

/** A name for this device in session lists, such as `Chrome on macOS`. */
export const deviceName = (): string => {
  const agent = navigator.userAgent;

  return `${firstMatch(agent, BROWSERS, "Browser")} on ${firstMatch(agent, SYSTEMS, "Linux")}`;
};
