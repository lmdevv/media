/**
 * Downloads on this iPhone. `DownloadsProvider` opens the signed-in account's vault, runs a
 * `DownloadSync` over it, and feeds it what the server says: this phone's downloads, each one's
 * manifest, and whether the server answers. Screens use the hooks below and never see pins,
 * manifests, revisions, or files.
 */
import type { DeviceId, DownloadPinId, TrackId, UserId } from "@music/commands/ids";
import type { HeldLyrics } from "@music/commands/lyrics";
import type { DownloadTarget } from "@music/commands/models";
import {
  canToggleDownload,
  downloadStatus,
  freedBytesOf,
  DownloadSync,
  EMPTY_DOWNLOADS,
  offlineLibrary,
  trackDownloadState,
} from "@music/sdk/downloads";
import type {
  DownloadsSnapshot,
  DownloadStatus,
  DownloadUsage,
  LocalCopy,
  LocalLyrics,
  OfflineLibrary,
  SyncPolicy,
  TrackDownloadState,
} from "@music/sdk/downloads";
import { makeMusicClient } from "@music/sdk/client";
import { useReadSettled } from "@music/sdk/react";
import type { SessionStore, StoredSessions } from "@music/player/session-router";
import { chooseStreamProfile } from "@music/player/stream-quality";
import { useConvex, useConvexAuth, useConvexConnectionState } from "convex/react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { expoTransfer } from "./expo-transfer";
import { openVault, wipeVaults } from "./expo-vault";
import type { ExpoVault } from "./expo-vault";
import { loadDownloadQuality, loadPhoneId, saveDownloadQuality } from "../player/native-host";
import type { DownloadQuality } from "../player/native-host";
import { playsOnIos } from "../player/player-state";
import { loadAccount, saveAccount } from "../lib/account-memory";
import { mediaUrl } from "../lib/media-url";
import type { ServerOrigin } from "../lib/server";
import { useConnection } from "../session/connection";
import { useServerReach } from "../session/server-reach";

/** What a song, album, or playlist row offers for its download. */
interface DownloadView {
  readonly status: DownloadStatus;
  /** Whether `toggle` does anything now: adding needs the server; removing works offline. */
  readonly canToggle: boolean;
  /** Space removing it frees: its songs here that no other download keeps. */
  readonly freedBytes: number;
  /** Downloads it, or removes it, cancelling what is still to come. */
  readonly toggle: () => Promise<void>;
  /** Tries its failed songs again now. */
  readonly retry: () => void;
}

/** The songs on this phone, as the player plays them. */
export interface DownloadedCopies {
  /** The copy of a song on this phone, or null; read when called. */
  readonly find: (trackId: TrackId) => LocalCopy | null;
  /** The copy at `uri` failed to play: stop offering it, and fetch it again if it is broken. */
  readonly discard: (trackId: TrackId, uri: string) => void;
}

/** The Downloads settings (D16). */
interface DownloadSettings {
  readonly quality: DownloadQuality;
  /** Saves the quality; songs already here keep theirs, and the next fetch uses the new one. */
  readonly setQuality: (quality: DownloadQuality) => void;
  readonly usage: DownloadUsage;
  /** How many downloads this phone keeps, finished or not, songs or none. */
  readonly downloads: number;
  /** Removes every download from this phone; the server hears when it answers. */
  readonly removeAll: () => Promise<void>;
}

interface Downloads {
  readonly sync: DownloadSync | null;
  /** Stable for the provider's lifetime, whichever vault is open. */
  readonly copies: DownloadedCopies;
  readonly quality: DownloadQuality;
  readonly setQuality: (quality: DownloadQuality) => void;
  /** The account's session store; a new one when the account changes. */
  readonly sessions: SessionStore;
}

/** What a session store holds when no vault is open. */
const NOTHING_STORED: StoredSessions = { local: null, server: null };

const DownloadsContext = createContext<Downloads | null>(null);

/**
 * How to stop each server's sync and close its vault, so a wipe never races a fetch still
 * writing. Kept until the shutdown has ended, so a wipe that starts meanwhile waits for it.
 */
const shutdowns = new Map<ServerOrigin, () => Promise<void>>();

/**
 * Deletes every download kept for the server at `origin`, for any account: after its sync has
 * stopped and its vault closed, so no transfer still in flight writes a file back.
 */
export const wipeDownloads = async (origin: ServerOrigin): Promise<void> => {
  await shutdowns.get(origin)?.();
  await wipeVaults(origin);
};

const subscribeToNothing = (): (() => void) => () => undefined;

const emptySnapshot = (): DownloadsSnapshot => EMPTY_DOWNLOADS;

/** The profile each new download is fetched in. */
const policyFor = (quality: DownloadQuality): SyncPolicy => ({
  profileFor: (track) => chooseStreamProfile(quality, track.codec, playsOnIos),
});

/** Reads one download's manifest and hands it to the sync. Renders nothing. */
function PinWatcher({
  sync,
  pinId,
}: {
  readonly sync: DownloadSync;
  readonly pinId: DownloadPinId;
}) {
  // Settled: a download removed elsewhere answers `not_found` until the list catches up.
  const manifest = useReadSettled("downloads.manifest", { pinId });

  useEffect(() => {
    if (manifest !== undefined && !(manifest instanceof Error)) sync.offerManifest(pinId, manifest);
  }, [sync, pinId, manifest]);

  return null;
}

/** Reads how one batch of kept songs' lyrics changed and hands it to the sync. Renders nothing. */
function LyricsWatcher({
  sync,
  held,
}: {
  readonly sync: DownloadSync;
  readonly held: ReadonlyArray<HeldLyrics>;
}) {
  const changes = useReadSettled("downloads.lyrics", { held: [...held] });

  useEffect(() => {
    if (changes !== undefined && !(changes instanceof Error)) sync.offerLyrics(changes);
  }, [sync, changes]);

  return null;
}

/**
 * Feeds `sync` this phone's downloads, the manifest of each, and how their songs' lyrics changed.
 * Renders nothing visible, and again only when the downloads or the lyrics questions change.
 */
function ServerFeed({
  sync,
  deviceId,
}: {
  readonly sync: DownloadSync;
  readonly deviceId: DeviceId;
}) {
  const { isWebSocketConnected } = useConvexConnectionState();
  const listed = useReadSettled("downloads.list", { deviceId });

  const lyricsQuestions = useSyncExternalStore(
    sync.subscribe,
    () => sync.getSnapshot().lyricsQuestions,
  );

  const pins = useMemo(
    () =>
      listed === undefined || listed instanceof Error
        ? null
        : (listed.find((device) => device.deviceId === deviceId)?.pins ?? []),
    [listed, deviceId],
  );

  useEffect(() => {
    sync.setOnline(isWebSocketConnected);
  }, [sync, isWebSocketConnected]);

  useEffect(() => {
    if (pins !== null) sync.offerPins(pins);
  }, [sync, pins]);

  return (
    <>
      {(pins ?? []).map((pin) => (
        <PinWatcher key={pin.id} sync={sync} pinId={pin.id} />
      ))}
      {lyricsQuestions.map((question) => (
        <LyricsWatcher key={question.key} sync={sync} held={question.held} />
      ))}
    </>
  );
}

/**
 * The account whose downloads this phone opens: the one signed in, else the one last signed in to
 * this server, so a launch with no connection still opens its downloads. Signing out forgets it.
 */
const useDownloadsAccount = (origin: ServerOrigin): UserId | null => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const account = useReadSettled("account.me", isAuthenticated ? {} : "skip");
  const signedIn = account === undefined || account instanceof Error ? null : account.id;
  const signedOut = !isLoading && !isAuthenticated;
  const [known, setKnown] = useState(() => loadAccount(origin));
  // Signed out, the account is gone: whoever signs in next waits for the server to say who.
  const next = signedOut ? null : (signedIn ?? known);

  if (next !== known) setKnown(next);

  useEffect(() => {
    if (signedIn !== null) saveAccount(origin, signedIn);
  }, [origin, signedIn]);

  return next;
};

/**
 * Keeps the account's downloads on this phone while the app runs, and fetches new ones while the
 * server answers. Mount it inside the Convex provider, above the session phase, which opens the
 * app on the downloads when the server is out of reach, and above the player, which plays
 * downloaded songs from their files.
 */
export function DownloadsProvider({ children }: { readonly children: ReactNode }) {
  const convex = useConvex();
  const { origin } = useConnection();
  const { isAuthenticated } = useConvexAuth();
  const userId = useDownloadsAccount(origin);
  const deviceId = useMemo(() => loadPhoneId(), []);
  const [sync, setSync] = useState<DownloadSync | null>(null);
  const [quality, setStoredQuality] = useState(loadDownloadQuality);
  // The sync reads the policy at every plan, so a new quality applies from the next fetch.
  const chosen = useRef(quality);
  const current = useRef<DownloadSync | null>(null);
  // Each account's vault while it is open, so a session store reaches only its own account's.
  const vaults = useRef(new Map<UserId, Promise<ExpoVault>>());

  // A layout effect, so the vault is opening before any child's effect (the player's session
  // router) asks it for the session it stored.
  useLayoutEffect(() => {
    if (userId === null) return undefined;
    let closed = false;
    let created: DownloadSync | null = null;
    let shutting: Promise<void> | null = null;
    const opening = openVault(origin, userId);
    vaults.current.set(userId, opening);

    /** Stops the sync, waiting for its fetches to end, then closes the vault. Once. */
    const shutdown = (): Promise<void> => {
      shutting ??= (async () => {
        closed = true;
        current.current = null;
        setSync(null);
        await created?.stop();
        const vault = await opening.catch(() => null);
        await vault?.close();
      })();

      return shutting;
    };

    shutdowns.set(origin, shutdown);

    const run = async (): Promise<void> => {
      let vault: ExpoVault;

      try {
        vault = await opening;
      } catch (error) {
        // The phone streams as before; downloads come back when the app opens the vault again.
        const reason = error instanceof Error ? error.message : "unknown error";
        console.warn(`Downloads are unavailable: the vault didn't open (${reason}).`);

        return;
      }

      if (closed) return;

      const opened = new DownloadSync({
        client: makeMusicClient(convex),
        vault,
        transfer: expoTransfer,
        deviceId,
        policy: () => policyFor(chosen.current),
        resolveUrl: (url) => mediaUrl(origin, url),
        now: Date.now,
      });

      created = opened;
      opened.start();
      current.current = opened;
      setSync(opened);
    };

    void run();

    return () => {
      if (vaults.current.get(userId) === opening) vaults.current.delete(userId);
      void shutdown().finally(() => {
        if (shutdowns.get(origin) === shutdown) shutdowns.delete(origin);
      });
    };
  }, [convex, origin, userId, deviceId]);

  const copies = useMemo(
    (): DownloadedCopies => ({
      find: (trackId) => current.current?.localCopy(trackId) ?? null,
      discard: (trackId, uri) => {
        current.current?.discard(trackId, uri);
      },
    }),
    [],
  );

  const setQuality = useCallback((next: DownloadQuality) => {
    saveDownloadQuality(next);
    chosen.current = next;
    setStoredQuality(next);
  }, []);

  // Bound to this account: a player built for it, even one left running past a sign-out, never
  // reads or writes another account's session. Without a vault open, nothing is stored.
  const sessions = useMemo((): SessionStore => {
    const vault = async (): Promise<ExpoVault | null> => {
      const opening = userId === null ? undefined : vaults.current.get(userId);

      try {
        return (await opening) ?? null;
      } catch {
        return null;
      }
    };

    return {
      load: async () => (await vault())?.session.load() ?? NOTHING_STORED,
      saveLocal: async (state) => {
        await (await vault())?.session.saveLocal(state);
      },
      saveServer: async (state) => {
        await (await vault())?.session.saveServer(state);
      },
    };
  }, [userId]);

  const value = useMemo(
    () => ({ sync, copies, sessions, quality, setQuality }),
    [sync, copies, sessions, quality, setQuality],
  );

  return (
    <DownloadsContext value={value}>
      {sync === null || !isAuthenticated ? null : <ServerFeed sync={sync} deviceId={deviceId} />}
      {children}
    </DownloadsContext>
  );
}

const useDownloads = (hook: string): Downloads => {
  const downloads = use(DownloadsContext);

  if (downloads === null) throw new Error(`${hook} must be used inside DownloadsProvider`);

  return downloads;
};

/** The current snapshot; the empty one until the vault opens. */
const useSnapshot = (sync: DownloadSync | null): DownloadsSnapshot =>
  useSyncExternalStore(sync?.subscribe ?? subscribeToNothing, sync?.getSnapshot ?? emptySnapshot);

/** The download of a song, album, or playlist on this phone, and the way to switch it. */
export const useDownload = (target: DownloadTarget): DownloadView => {
  const { sync } = useDownloads("useDownload");
  const snapshot = useSnapshot(sync);
  const status = downloadStatus(snapshot, target);
  const canToggle = canToggleDownload(snapshot, status);

  return {
    status,
    canToggle,
    freedBytes: freedBytesOf(snapshot, target),
    toggle: async () => {
      if (sync === null || !canToggle) return;

      await (status.kind === "none" ? sync.request(target) : sync.remove(target));
    },
    retry: () => {
      sync?.retry(target);
    },
  };
};

/** What this phone holds or is getting for one song, and how to try it again once it failed. */
interface TrackDownload {
  readonly state: TrackDownloadState | "none";
  readonly retry: () => void;
}

/**
 * The download of one song, for its row's glyph; `none` for a song that isn't a real track. Reads
 * only this song's state, so a row redraws when its own song changes, not on every download.
 */
export const useTrackDownload = (trackId: TrackId | null): TrackDownload => {
  const { sync } = useDownloads("useTrackDownload");

  const state = useSyncExternalStore(sync?.subscribe ?? subscribeToNothing, () =>
    sync === null || trackId === null ? "none" : trackDownloadState(sync.getSnapshot(), trackId),
  );

  return {
    state,
    retry: () => {
      if (trackId !== null) sync?.retry({ kind: "track", id: trackId });
    },
  };
};

/** Everything on this phone: each download, the albums, playlists, and songs, and their space. */
export const useDownloadsLibrary = (): OfflineLibrary => {
  const { sync } = useDownloads("useDownloadsLibrary");
  const snapshot = useSnapshot(sync);

  return useMemo(() => offlineLibrary(snapshot), [snapshot]);
};

/** Download quality, the space downloads take, and removing them all. */
export const useDownloadSettings = (): DownloadSettings => {
  const { sync, quality, setQuality } = useDownloads("useDownloadSettings");
  const { usage, pins } = useSnapshot(sync);

  return {
    quality,
    setQuality,
    usage,
    downloads: pins.length,
    removeAll: async () => {
      await sync?.removeAll();
    },
  };
};

/**
 * The songs on this phone, for the player, which plays a downloaded song from its file, online
 * too. Stable, and reads the vault when called.
 */
export const useLocalCopies = (): DownloadedCopies => useDownloads("useLocalCopies").copies;

/**
 * Whether a song can play now: always while the server answers, else only when this phone holds
 * it; never offline for a row that isn't a real track. Rows of songs it can't play dim, and say
 * "Not downloaded" (D13). Reads only this song's copy, so a row redraws when its own song arrives
 * or goes, not on every download.
 */
export const useTrackReachable = (trackId: TrackId | null): boolean => {
  const { sync } = useDownloads("useTrackReachable");
  const online = useServerReach() === "online";

  const held = useSyncExternalStore(
    sync?.subscribe ?? subscribeToNothing,
    () => sync !== null && trackId !== null && sync.getSnapshot().copies.has(trackId),
  );

  return online || held;
};

/**
 * The lyrics this phone keeps with a downloaded song, what shows with no server: null for none,
 * `loading` while they are read from the vault. Reads only this song's lyrics, so it redraws when
 * they change, not on every download.
 */
export const useDownloadedLyrics = (trackId: TrackId | null): LocalLyrics => {
  const { sync } = useDownloads("useDownloadedLyrics");

  const kept = useSyncExternalStore(sync?.subscribe ?? subscribeToNothing, () =>
    sync === null || trackId === null ? null : sync.localLyrics(trackId),
  );

  useEffect(() => {
    if (kept === "loading" && trackId !== null) sync?.loadLyrics(trackId);
  }, [sync, trackId, kept]);

  return kept;
};

/**
 * Whether this phone holds a downloaded song of the account it opened: what a launch with no
 * connection can play. False until the vault opens.
 */
export const useHasDownloads = (): boolean => {
  const { sync } = useDownloads("useHasDownloads");

  return useSyncExternalStore(
    sync?.subscribe ?? subscribeToNothing,
    () => sync !== null && sync.getSnapshot().copies.size > 0,
  );
};

/**
 * Where the player keeps its playback session across launches: the open vault's database, so it
 * belongs to the account whose downloads it plays and goes with them on sign-out. A new store for
 * each account: build the player again when it changes.
 */
export const useSessionStore = (): SessionStore => useDownloads("useSessionStore").sessions;
