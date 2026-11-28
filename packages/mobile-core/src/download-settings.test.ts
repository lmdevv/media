import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOWNLOAD_SETTINGS,
  downloadSettingsStore,
  parseDownloadSettings,
  serializeDownloadSettings,
} from "./download-settings";
import { memoryKeychain } from "./keychain";

describe("download settings", () => {
  it("reads back what it wrote, with defaults for what is missing or unreadable", () => {
    const settings = { wifiOnly: false } as const;

    expect(parseDownloadSettings(serializeDownloadSettings(settings))).toStrictEqual(settings);
    expect(parseDownloadSettings(null)).toStrictEqual(DEFAULT_DOWNLOAD_SETTINGS);
    expect(parseDownloadSettings("not json")).toStrictEqual(DEFAULT_DOWNLOAD_SETTINGS);
    expect(parseDownloadSettings('{"wifiOnly":"no","quality":"high"}')).toStrictEqual(
      DEFAULT_DOWNLOAD_SETTINGS,
    );
    expect(parseDownloadSettings('{"wifiOnly":false,"quality":"high"}')).toStrictEqual({
      wifiOnly: false,
    });
  });

  it("keeps a change in the keychain, tells listeners, and starts from it next launch", () => {
    const keychain = memoryKeychain();
    const store = downloadSettingsStore(keychain, "app.downloads.settings");
    const heard: Array<boolean> = [];
    const stop = store.subscribe(() => heard.push(store.read().wifiOnly));

    expect(store.read()).toStrictEqual(DEFAULT_DOWNLOAD_SETTINGS);
    store.update({ wifiOnly: false });
    stop();
    store.update({});

    expect(heard).toStrictEqual([false]);
    expect(downloadSettingsStore(keychain, "app.downloads.settings").read()).toStrictEqual({
      wifiOnly: false,
    });
    expect(downloadSettingsStore(keychain, "other.key").read()).toStrictEqual(
      DEFAULT_DOWNLOAD_SETTINGS,
    );
  });
});
