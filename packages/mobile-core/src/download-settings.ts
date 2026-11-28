import { Effect, Option, Schema } from "effect";
import { useSyncExternalStore } from "react";

import type { Keychain } from "./keychain";

/** The download settings an app keeps on this phone for itself. */
export interface DownloadSettings {
  /** Transfers only on Wi-Fi; on mobile data downloads wait. */
  readonly wifiOnly: boolean;
}

/** Settings before anyone changed them: Wi-Fi only. */
export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { wifiOnly: true };

const Stored = Schema.fromJsonString(
  Schema.Struct({
    wifiOnly: Schema.optionalKey(
      Schema.Boolean.pipe(
        Schema.catchDecoding(() => Effect.succeedSome(DEFAULT_DOWNLOAD_SETTINGS.wifiOnly)),
      ),
    ),
  }),
);

const decodeStored = Schema.decodeUnknownOption(Stored);

/** The settings kept in `text`, with defaults for anything missing or unreadable. */
export const parseDownloadSettings = (text: string | null): DownloadSettings => ({
  ...DEFAULT_DOWNLOAD_SETTINGS,
  ...Option.getOrElse(decodeStored(text), () => ({})),
});

/** The settings as the JSON they are kept as. */
export const serializeDownloadSettings = (settings: DownloadSettings): string =>
  JSON.stringify({ wifiOnly: settings.wifiOnly });

/** An app's download settings, kept in its keychain, that screens and the downloads read. */
export interface DownloadSettingsStore {
  readonly read: () => DownloadSettings;
  /** Changes some settings and keeps them in the keychain. */
  readonly update: (change: Partial<DownloadSettings>) => void;
  /** Calls `listener` after every change. Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** The download settings kept at `key` in `keychain`, read once now. */
export const downloadSettingsStore = (keychain: Keychain, key: string): DownloadSettingsStore => {
  let current = parseDownloadSettings(keychain.read(key));
  const listeners = new Set<() => void>();

  return {
    read: () => current,
    update: (change) => {
      current = { wifiOnly: change.wifiOnly ?? current.wifiOnly };
      keychain.write(key, serializeDownloadSettings(current));

      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The settings in `store`, re-rendering when they change. */
export const useDownloadSettingsOf = (store: DownloadSettingsStore): DownloadSettings =>
  useSyncExternalStore(store.subscribe, store.read, store.read);
