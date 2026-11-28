import { lastPerson } from "@media/mobile-core/sign-in";
import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { Paths } from "expo-file-system";
import * as Network from "expo-network";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";

import { accountFolder } from "@/lib/downloads/files";
import { appKeychains } from "@/lib/keychains";
import { downloadFor } from "@/lib/downloads/model";
import type { DownloadRecord, NetworkNow } from "@/lib/downloads/model";
import { prepareDownloads } from "@/lib/downloads/storage";

import { useServer } from "./connection";
import { DownloadEngine } from "./download-engine";
import type { DownloadsSnapshot } from "./download-engine";
import { useDownloadSettings } from "./download-settings";
import { expoDisk, expoRoot } from "./expo-disk";
import type { Person } from "./me";

const DownloadsContext = createContext<DownloadEngine | null>(null);

/**
 * The person to show downloads for while the server cannot be reached: the one this app last
 * signed in as on this server, as its own keychain records them, while the app is still signed
 * in. Null otherwise, so signing out keeps downloads out of reach.
 */
export const useOfflinePerson = (): Person | null => {
  const { mediaUrl } = useServer();
  const signedIn = usePlatformStatus() === "signedIn";

  return useMemo(
    () => (signedIn ? lastPerson({ own: appKeychains().own, server: mediaUrl }) : null),
    [signedIn, mediaUrl],
  );
};

const networkOf = (state: Network.NetworkState): NetworkNow => ({
  connected: state.isConnected === true,
  wifi:
    state.type === Network.NetworkStateType.WIFI ||
    state.type === Network.NetworkStateType.ETHERNET,
});

/**
 * Runs the downloads engine of the person signed in here for the screens below: from who the core
 * says is signed in, else, while it cannot be reached, who this app last signed in as. The engine
 * starts working only once the core confirms the person on this phone's device. Whenever the person changes, signed out
 * included, it first prepares the downloads: excludes them from backup and finishes the removals
 * of anyone who signed out here.
 */
export function DownloadsProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const status = usePlatformStatus();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  // The core keeps downloads per device and refuses a session on none, so the engine starts only
  // once the core itself says the session is on this phone's device: a saved answer is not enough.
  const confirmed =
    status === "signedIn" && me.status === "success" && me.saved !== true && me.data.device !== null
      ? me.data.userId
      : null;

  const last = useOfflinePerson();
  const userId = confirmed ?? last?.userId ?? null;
  const settings = useDownloadSettings();
  const [engine, setEngine] = useState<DownloadEngine | null>(null);
  const [initialSettings] = useState(settings);

  useEffect(() => {
    prepareDownloads(expoRoot(Paths.document));

    if (userId === null) {
      setEngine(null);

      return undefined;
    }

    const created = new DownloadEngine(platform, {
      disk: expoDisk(Paths.document, accountFolder(mediaUrl, userId)),
      mediaUrl,
      settings: initialSettings,
    });

    setEngine(created);

    return () => created.dispose();
  }, [platform, mediaUrl, userId, initialSettings]);

  useEffect(() => {
    if (engine !== null && confirmed !== null && confirmed === userId) engine.start();
  }, [engine, confirmed, userId]);

  useEffect(() => {
    engine?.setSettings(settings);
  }, [engine, settings]);

  useEffect(() => {
    if (engine === null) return undefined;
    engine.setForeground(AppState.currentState !== "background");

    const subscription = AppState.addEventListener("change", (state) =>
      engine.setForeground(state !== "background"),
    );

    return () => subscription.remove();
  }, [engine]);

  useEffect(() => {
    if (engine === null) return undefined;
    const apply = (state: Network.NetworkState) => engine.setNetwork(networkOf(state));
    const subscription = Network.addNetworkStateListener(apply);

    void Network.getNetworkStateAsync()
      .then(apply)
      .catch(() => undefined);

    return () => subscription.remove();
  }, [engine]);

  return <DownloadsContext.Provider value={engine}>{children}</DownloadsContext.Provider>;
}

const subscribeNothing = (): (() => void) => () => undefined;

/** The downloads engine and its state. */
export interface Downloads {
  /** Null while no one is signed in here. */
  readonly engine: DownloadEngine | null;
  readonly snapshot: DownloadsSnapshot | null;
}

/** The downloads engine and its state, or nulls while no one is signed in here. */
export const useDownloads = (): Downloads => {
  const engine = useContext(DownloadsContext);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? subscribeNothing,
    () => engine?.getSnapshot() ?? null,
  );

  return { engine, snapshot };
};

/** Whether this phone holds a download ready to play for the person signed in here. */
export const useHasDownloads = (): boolean => {
  const engine = useContext(DownloadsContext);

  return useSyncExternalStore(
    engine?.subscribe ?? subscribeNothing,
    () =>
      engine?.getSnapshot().store.downloads.some((download) => download.phase === "ready") === true,
  );
};

/** One download by its ID, with the engine that keeps it; null when there is no such download. */
export const useDownload = (
  id: string | null,
): { readonly engine: DownloadEngine; readonly download: DownloadRecord } | null => {
  const { engine, snapshot } = useDownloads();
  const download = snapshot === null ? undefined : downloadFor(snapshot.store, id);

  return engine === null || download === undefined ? null : { engine, download };
};
