import { Option, Schema } from "effect";

import { QualityChoice } from "@/playback/quality";

const QUALITY_KEY = "movies.quality.v1";

const decodeQuality = Schema.decodeUnknownOption(QualityChoice);

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows, quotas); the choice then lasts for this visit.
  }
};

/** The stream quality last chosen in the player on this browser; `auto` when none. */
export const loadQualityChoice = (): QualityChoice =>
  Option.getOrElse(decodeQuality(read(QUALITY_KEY)), () => "auto" as const);

/** Remembers the stream quality chosen on this browser. */
export const saveQualityChoice = (choice: QualityChoice): void => {
  write(QUALITY_KEY, choice);
};
