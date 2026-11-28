import { downloadSettingsStore, useDownloadSettingsOf } from "@media/mobile-core/download-settings";
import type { DownloadSettings } from "@media/mobile-core/download-settings";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";

import type { DownloadQuality } from "@/lib/downloads/settings";
import { appKeychains } from "@/lib/keychains";

const store = downloadSettingsStore(appKeychains().own, "movies.downloads.settings");

/** Changes some settings and keeps them in the keychain. */
export const updateDownloadSettings = store.update;

/** Download Settings this iPhone keeps, re-rendering when they change. */
export const useDownloadSettings = (): DownloadSettings => useDownloadSettingsOf(store);

/** The person's download quality on this device, which the core keeps and downloads use. */
export interface DownloadQualitySetting {
  /** Null until the core answers, or while it cannot be reached. */
  readonly quality: DownloadQuality | null;
  /** Keeps a new quality for downloads added from now on. */
  readonly choose: (quality: DownloadQuality) => Promise<void>;
}

/** The person's download quality on this device, from the core's settings. */
export const useDownloadQuality = (): DownloadQualitySetting => {
  const platform = usePlatform();
  const settings = usePlatformQuery(platform.core.settings.get);

  return {
    quality: settings.status === "success" ? (settings.data.device?.downloadQuality ?? null) : null,
    choose: async (quality) => {
      await platform.core.settings.set({ downloadQuality: quality });
    },
  };
};
