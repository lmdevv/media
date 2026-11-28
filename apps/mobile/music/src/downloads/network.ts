import { downloadSettingsStore } from "@media/mobile-core/download-settings";
import type { DownloadSettingsStore } from "@media/mobile-core/download-settings";
import { requireNativeModule } from "expo";
import type { EventEmitter } from "expo";

import { appKeychains } from "@/lib/keychains";

import type { NetworkReading } from "./sync/transfer-gate";

interface NetworkCostModule extends EventEmitter<{
  readonly onChange: (reading: NetworkReading) => void;
}> {
  /** The last network iOS reported, or null before its first report. */
  readonly current: () => NetworkReading | null;
}

let networkCost: NetworkCostModule | null = null;

/** The NetworkCost module in `@media/mobile-core`, loaded on first use. */
const networkModule = (): NetworkCostModule => {
  networkCost ??= requireNativeModule<NetworkCostModule>("NetworkCost");

  return networkCost;
};

/** The network the phone uses now, as iOS last reported it; null before its first report. */
export const readNetwork = (): NetworkReading | null => networkModule().current();

/** Calls `listener` with each network iOS reports. Returns the unsubscribe function. */
export const subscribeNetwork = (listener: (reading: NetworkReading) => void): (() => void) => {
  const subscription = networkModule().addListener("onChange", listener);

  return () => {
    subscription.remove();
  };
};

let settings: DownloadSettingsStore | null = null;

/** Music's download settings on this phone, read from its keychain on first use. */
export const downloadSettings = (): DownloadSettingsStore => {
  settings ??= downloadSettingsStore(appKeychains().own, "music.downloads.settings");

  return settings;
};
