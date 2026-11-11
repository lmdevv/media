import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { useSyncExternalStore } from "react";

import { parseDownloadSettings, serializeDownloadSettings } from "@/lib/downloads/settings";
import type { DownloadQuality, DownloadSettings } from "@/lib/downloads/settings";
import { readValue, writeValue } from "@/lib/secure-storage";

const KEY = "movies.downloads.settings";

let current: DownloadSettings = parseDownloadSettings(readValue(KEY));

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const read = (): DownloadSettings => current;

/** Changes some settings and keeps them in the keychain. */
export const updateDownloadSettings = (change: Partial<DownloadSettings>): void => {
  current = { wifiOnly: change.wifiOnly ?? current.wifiOnly };
  writeValue(KEY, serializeDownloadSettings(current));

  for (const listener of listeners) listener();
};

/** Download Settings this iPhone keeps, re-rendering when they change. */
export const useDownloadSettings = (): DownloadSettings =>
  useSyncExternalStore(subscribe, read, read);

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
