import { describe, expect, it } from "vitest";

import {
  QUALITY_OPTIONS,
  parseQualityChoice,
  qualityCap,
  qualityOfSetting,
  qualitySetting,
} from "./quality";

describe("quality choice", () => {
  it("offers Auto and Original without a cap, and caps the rest by height and bitrate", () => {
    expect(QUALITY_OPTIONS.map((option) => option.label)).toStrictEqual([
      "Auto",
      "Original",
      "1080p",
      "720p",
      "480p",
    ]);
    expect(qualityCap("auto")).toBeUndefined();
    expect(qualityCap("original")).toBeUndefined();
    expect(qualityCap("720p")).toStrictEqual({ maxHeight: 720, maxBitrate: 4_000_000 });
  });

  it("reads only known choices back", () => {
    expect(parseQualityChoice("480p")).toBe("480p");
    expect(parseQualityChoice("4k")).toBeUndefined();
  });

  it("keeps every choice in the device's stream quality setting and reads it back", () => {
    expect(QUALITY_OPTIONS.map((option) => qualitySetting(option.id))).toStrictEqual([
      "auto",
      "original",
      "high",
      "standard",
      "low",
    ]);
    expect(
      QUALITY_OPTIONS.map((option) => qualityOfSetting(qualitySetting(option.id))),
    ).toStrictEqual(QUALITY_OPTIONS.map((option) => option.id));
  });
});
