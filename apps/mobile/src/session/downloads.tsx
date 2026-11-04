import { Profile } from "@media/contracts/models/profiles";
import { useAuth, useCommandQuery, useMoviesRuntime } from "@media/sdk/react";
import { Option, Schema } from "effect";
import { Directory, Paths } from "expo-file-system";
import * as Network from "expo-network";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { deviceId, deviceName } from "@/lib/device";
import { accountFolder } from "@/lib/downloads/files";
import { downloadFor } from "@/lib/downloads/model";
import type { DownloadRecord, NetworkNow } from "@/lib/downloads/model";
import { readValue, writeValue } from "@/lib/secure-storage";

import { useActiveProfile } from "./active-profile";
import { DownloadEngine } from "./download-engine";
import type { DownloadsSnapshot } from "./download-engine";
import { useDownloadSettings } from "./download-settings";
import { useServer } from "./connection";
import { useProfileChoice } from "./profile-choice";

const DownloadsContext = createContext<DownloadEngine | null>(null);

const serverKey = (mediaUrl: string): string => mediaUrl.replace(/[^\w.-]/gu, "_");

const accountKey = (mediaUrl: string): string => `movies.downloads.account.${serverKey(mediaUrl)}`;

const profileKey = (mediaUrl: string): string => `movies.downloads.profile.${serverKey(mediaUrl)}`;

const StoredProfile = Schema.fromJsonString(Profile);

const decodeProfile = Schema.decodeUnknownOption(StoredProfile);

const encodeProfile = Schema.encodeSync(StoredProfile);

const rememberedProfiles = new Map<string, Profile | null>();

const profileListeners = new Set<() => void>();

const subscribeProfiles = (listener: () => void): (() => void) => {
  profileListeners.add(listener);

  return () => {
    profileListeners.delete(listener);
  };
};

const rememberedOf = (mediaUrl: string): Profile | null => {
  const known = rememberedProfiles.get(mediaUrl);

  if (known !== undefined) return known;
  const read = Option.getOrNull(decodeProfile(readValue(profileKey(mediaUrl))));

  rememberedProfiles.set(mediaUrl, read);

  return read;
};

/** Remembers the profile on screen, so its downloads can be shown when the server is unreachable. */
export const rememberProfile = (mediaUrl: string, profile: Profile): void => {
  writeValue(profileKey(mediaUrl), encodeProfile(profile));
  rememberedProfiles.set(mediaUrl, profile);

  for (const listener of profileListeners) listener();
};

/**
 * The profile to show downloads for while the server cannot be reached: the one last used on this
 * server, when this iPhone is still signed in and still has it chosen. Null otherwise, so signing
 * out, or choosing no profile, keeps downloads out of reach.
 */
export const useOfflineProfile = (): Profile | null => {
  const { mediaUrl } = useServer();
  const { status } = useAuth();
  const { profileId } = useProfileChoice();
  const read = () => rememberedOf(mediaUrl);
  const remembered = useSyncExternalStore(subscribeProfiles, read, read);

  return status === "signedIn" && remembered !== null && remembered.id === profileId
    ? remembered
    : null;
};

const networkOf = (state: Network.NetworkState): NetworkNow => ({
  connected: state.isConnected === true,
  wifi:
    state.type === Network.NetworkStateType.WIFI ||
    state.type === Network.NetworkStateType.ETHERNET,
});

/** Runs the downloads engine of the signed-in account for the screens below. */
export function DownloadsProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useMoviesRuntime();
  const { mediaUrl } = useServer();
  const { status } = useAuth();
  const viewer = useCommandQuery("account.viewer", status === "signedIn" ? {} : "skip");
  const confirmed = viewer.status === "success" ? viewer.data.user.id : null;
  const [remembered] = useState(() => readValue(accountKey(mediaUrl)));
  const userId = status === "signedIn" ? (confirmed ?? remembered) : null;
  const settings = useDownloadSettings();
  const [engine, setEngine] = useState<DownloadEngine | null>(null);
  const [initialSettings] = useState(settings);

  useEffect(() => {
    if (confirmed !== null) writeValue(accountKey(mediaUrl), confirmed);
  }, [confirmed, mediaUrl]);

  useEffect(() => {
    if (userId === null) {
      setEngine(null);

      return undefined;
    }

    const created = new DownloadEngine(runtime, {
      folder: new Directory(Paths.document, accountFolder(mediaUrl, userId)),
      mediaUrl,
      deviceId: deviceId(),
      deviceName: deviceName(),
      settings: initialSettings,
    });

    setEngine(created);

    return () => created.dispose();
  }, [runtime, mediaUrl, userId, initialSettings]);

  useEffect(() => {
    if (engine !== null && confirmed !== null && confirmed === userId) engine.start();
  }, [engine, confirmed, userId]);

  useEffect(() => {
    engine?.setSettings(settings);
  }, [engine, settings]);

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
  /** Null while no account is signed in here. */
  readonly engine: DownloadEngine | null;
  readonly snapshot: DownloadsSnapshot | null;
}

/** The downloads engine and its state, or nulls while no account is signed in here. */
export const useDownloads = (): Downloads => {
  const engine = useContext(DownloadsContext);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? subscribeNothing,
    () => engine?.getSnapshot() ?? null,
  );

  return { engine, snapshot };
};

/**
 * One download of the profile on screen by its ID, with the engine that keeps it; null when it
 * has no such download.
 */
export const useDownload = (
  id: string | null,
): { readonly engine: DownloadEngine; readonly download: DownloadRecord } | null => {
  const { engine, snapshot } = useDownloads();
  const { profile } = useActiveProfile();
  const download = snapshot === null ? undefined : downloadFor(snapshot.store, id, profile.id);

  return engine === null || download === undefined ? null : { engine, download };
};
