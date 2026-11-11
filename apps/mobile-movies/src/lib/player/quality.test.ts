import { describe, expect, it } from "vitest";

import { QUALITY_OPTIONS, lowerQuality, qualityCap } from "./quality";

describe("quality", () => {
  it("lists Auto first, then caps from the highest down", () => {
    expect(QUALITY_OPTIONS.map((option) => option.label)).toStrictEqual([
      "Auto",
      "1080p",
      "720p",
      "480p",
    ]);
  });

  it("caps nothing for Auto and the others as the web player's presets do", () => {
    expect(qualityCap("auto")).toBeNull();
    expect(qualityCap("1080p")).toStrictEqual({ maxHeight: 1080, maxBitrate: 10_000_000 });
    expect(qualityCap("720p")).toStrictEqual({ maxHeight: 720, maxBitrate: 4_000_000 });
    expect(qualityCap("480p")).toStrictEqual({ maxHeight: 480, maxBitrate: 2_000_000 });
  });

  it("steps down below the picture playing", () => {
    expect(lowerQuality(2160)).toBe("1080p");
    expect(lowerQuality(1080)).toBe("720p");
    expect(lowerQuality(818)).toBe("720p");
    expect(lowerQuality(720)).toBe("480p");
    expect(lowerQuality(480)).toBeNull();
  });
});
