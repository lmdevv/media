import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOWNLOAD_SETTINGS,
  parseDownloadSettings,
  qualityLabel,
  serializeDownloadSettings,
} from "./settings";

describe("download settings", () => {
  it("reads back what it wrote, with defaults for what is missing or unreadable", () => {
    const settings = { wifiOnly: false } as const;

    expect(parseDownloadSettings(serializeDownloadSettings(settings))).toStrictEqual(settings);
    expect(parseDownloadSettings(null)).toStrictEqual(DEFAULT_DOWNLOAD_SETTINGS);
    expect(parseDownloadSettings('{"wifiOnly":"no","quality":"high"}')).toStrictEqual(
      DEFAULT_DOWNLOAD_SETTINGS,
    );
    expect(parseDownloadSettings('{"wifiOnly":false,"quality":"high"}')).toStrictEqual({
      wifiOnly: false,
    });
    expect(qualityLabel("high")).toBe("High");
  });
});
