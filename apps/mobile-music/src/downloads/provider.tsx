import { useAllPages } from "@media/mobile-core/pages";
import { streamUrl } from "@media/player/source-resolver";
import { chooseStreamProfile } from "@media/player/stream-quality";
import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformStatus } from "@media/sdk/react";
import { isFailure } from "@media/mobile-core/failure";
import { lastPerson } from "@media/mobile-core/sign-in";
import { Equal, Option, Schema } from "effect";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
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

import { appKeychains } from "@/lib/keychains";
import { asTrackId } from "@/lib/models";
import type { UserId } from "@/lib/models";
import { useReadSettled } from "@/lib/platform";
import { useServer } from "@/session/connection";

import { expoTransfer } from "./expo-transfer";
import { openVault, wipeVaults } from "./expo-vault";
import type { ExpoVault } from "./expo-vault";
import { manifestOf } from "./manifest";
import type { CoreKept, PinRead } from "./manifest";
import { freedBytesOf, offlineLibrary } from "./sync/library";
import type { OfflineLibrary } from "./sync/library";
import { LyricsChange, LyricsRevision, OfflineLyrics } from "./sync/models";
import type {
  DownloadManifest,
  DownloadPin,
  DownloadTarget,
  StreamProfile,
  TrackId,
} from "./sync/models";
import type { HeldLyrics, SyncPolicy } from "./sync/plan";
import { canToggleDownload, downloadStatus, trackDownloadState } from "./sync/status";
import type { DownloadStatus } from "./sync/status";
import { DownloadSync, EMPTY_DOWNLOADS } from "./sync/sync";
import type {
  DownloadsCore,
  DownloadsSnapshot,
  DownloadUsage,
  LocalCopy,
  LocalLyrics,
  PinDetails,
  TrackDownloadState,
} from "./sync/sync";

const PAGE_ROWS = 200;

/**
 * The download quality: `high` keeps AAC 320 kbps copies, `lossless` keeps the original where
 * iOS plays it. The core keeps it per device as `standard` and `high` (ADR 0019).
 */
export type DownloadQuality = "high" | "lossless";

const qualityOfSetting = (setting: "standard" | "high"): DownloadQuality =>
  setting === "high" ? "lossless" : "high";

const settingOfQuality = (quality: DownloadQuality): "standard" | "high" =>
  quality === "lossless" ? "high" : "standard";

/**
 * Whether iOS plays a MIME type (from `codecMimeType`) as it is: AVPlayer decodes AAC, ALAC, MP3,
 * FLAC, and WAV, but not Ogg (Vorbis or Opus).
 */
const playsOnIos = (mimeType: string): boolean =>
  ["audio/mp4", "audio/flac", "audio/mpeg", "audio/wav"].some((type) => mimeType.startsWith(type));

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
  readonly find: (trackId: string) => LocalCopy | null;
  /** The copy at `uri` failed to play: stop offering it, and fetch it again if it is broken. */
  readonly discard: (trackId: string, uri: string) => void;
}

/** The Downloads settings (D16). */
interface DownloadSettings {
  readonly quality: DownloadQuality;
  /** Saves the quality; songs already here keep theirs, and the next fetch uses the new one. */
  readonly setQuality: (quality: DownloadQuality) => void;
  readonly usage: DownloadUsage;
  /** How many downloads this phone keeps, finished or not, songs or none. */
  readonly downloads: number;
  /** Removes every download from this phone; the core hears when it answers. */
  readonly removeAll: () => Promise<void>;
}

interface Downloads {
  readonly sync: DownloadSync | null;
  readonly copies: DownloadedCopies;
  readonly quality: DownloadQuality;
  readonly setQuality: (quality: DownloadQuality) => void;
  /** Tells the sync whether the server answers; the screens below the session phase know. */
  readonly setOnline: (online: boolean) => void;
}

const DownloadsContext = createContext<Downloads | null>(null);

const shutdowns = new Map<string, () => Promise<void>>();

/**
 * Deletes every download kept for the server at `origin`, for any account: after its sync has
 * stopped and its vault closed, so no transfer still in flight writes a file back.
 */
export const wipeDownloads = async (origin: string): Promise<void> => {
  await shutdowns.get(origin)?.();
  await wipeVaults(origin);
};

const subscribeToNothing = (): (() => void) => () => undefined;

const emptySnapshot = (): DownloadsSnapshot => EMPTY_DOWNLOADS;

const policyFor = (quality: DownloadQuality): SyncPolicy => ({
  profileFor: (track) => chooseStreamProfile(quality, track.codec, playsOnIos),
});

const coreFor = (platform: PlatformSdk, mediaUrl: string): DownloadsCore => ({
  keep: async (trackId) => {
    await platform.core.downloads.add({ item: { kind: "track", id: trackId } });
  },
  release: async (trackId) => {
    await platform.core.downloads.remove({ item: { kind: "track", id: trackId } });
  },
  ticket: async (trackId: TrackId, profile: StreamProfile) => {
    const fetched = await platform.core.downloads.fetch({ item: { kind: "track", id: trackId } });

    if (fetched.state !== "available") {
      throw new Error(
        fetched.state === "gone"
          ? "The song is no longer on the server"
          : "This song can’t be downloaded to this device any more",
      );
    }

    return {
      url: streamUrl(mediaUrl, trackId, fetched.ticket, profile),
      revision: fetched.revision,
    };
  },
  resolveUrl: (url) => (url.startsWith("/") ? `${mediaUrl}${url}` : url),
});

type KeptRow = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["list"]>>["page"][number];

const keptOf = (rows: ReadonlyArray<KeptRow>): ReadonlyMap<TrackId, KeptRow> => {
  const kept = new Map<TrackId, KeptRow>();

  for (const row of rows) if (row.item.kind === "track") kept.set(row.item.id, row);

  return kept;
};

function PinWatcher({
  sync,
  pin,
  kept,
}: {
  readonly sync: DownloadSync;
  readonly pin: DownloadPin;
  readonly kept: CoreKept;
}) {
  const read = usePinRead(pin.target);
  const offered = useRef<DownloadManifest | null>(null);

  useEffect(() => {
    if (read === null) return;
    const manifest = manifestOf(pin, read, kept);

    if (offered.current !== null && Equal.equals(manifest, offered.current)) return;
    offered.current = manifest;
    sync.offerManifest(pin.id, manifest);
  }, [sync, pin, read, kept]);

  return null;
}

/**
 * What the core says a download holds now: its song, album, or playlist and its songs, once
 * every page arrived; null while it loads, or after a failure that is not a refusal.
 */
const usePinRead = (target: DownloadTarget): PinRead | null => {
  const platform = usePlatform();
  const music = platform.music;

  const track = useReadSettled(
    music.tracks.get,
    target.kind === "track" ? { trackId: target.id } : "skip",
  );

  const album = useReadSettled(
    music.albums.get,
    target.kind === "album" ? { albumId: target.id } : "skip",
  );

  const albumTracks = useAllPages(
    music.albums.tracks,
    target.kind === "album" ? (paginationOpts) => ({ albumId: target.id, paginationOpts }) : "skip",
    PAGE_ROWS,
  );

  const playlist = useReadSettled(
    music.playlists.get,
    target.kind === "playlist" ? { playlistId: target.id } : "skip",
  );

  const items = useAllPages(
    music.playlists.items,
    target.kind === "playlist"
      ? (paginationOpts) => ({ playlistId: target.id, paginationOpts })
      : "skip",
    PAGE_ROWS,
  );

  return useMemo((): PinRead | null => {
    if (target.kind === "track") {
      if (track === undefined) return null;

      return track instanceof Error ? refusedOrNull(track) : { kind: "track", track };
    }

    if (target.kind === "album") {
      if (album === undefined) return null;

      if (album instanceof Error) return refusedOrNull(album);

      if (albumTracks.status !== "ready" || albumTracks.next.kind !== "done") return null;

      return { kind: "album", album: album.album, tracks: albumTracks.rows };
    }

    if (playlist === undefined) return null;

    if (playlist instanceof Error) return refusedOrNull(playlist);

    if (items.status !== "ready" || items.next.kind !== "done") return null;

    return { kind: "playlist", playlist, entries: items.rows };
  }, [target.kind, track, album, albumTracks, playlist, items]);
};

/** A read the core refused, as for an album now gone, makes the download unavailable. */
const refusedOrNull = (cause: Error): PinRead | null =>
  isFailure(cause, "NotFound") || isFailure(cause, "Forbidden") ? { kind: "unavailable" } : null;

const decodeLyrics = Schema.decodeUnknownOption(OfflineLyrics);

const makeRevision = Schema.decodeSync(LyricsRevision);

/**
 * Looks up the lyrics of kept songs that keep none yet, all at once, and offers them to the sync.
 * Lyrics found keep their revision, a digest of their JSON.
 */
function LyricsWatcher({
  sync,
  held,
}: {
  readonly sync: DownloadSync;
  readonly held: ReadonlyArray<HeldLyrics>;
}) {
  const platform = usePlatform();

  useEffect(() => {
    const missing = held.filter((song) => song.rev === null);

    if (missing.length === 0) return undefined;
    const stop = new AbortController();

    const lookUp = async ({ trackId }: HeldLyrics): Promise<ReadonlyArray<LyricsChange>> => {
      try {
        const kept = offlineLyricsOf(await platform.music.lyrics.get({ trackId }));
        const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(kept));

        return [
          LyricsChange.cases.Changed.make({ trackId, rev: makeRevision(digest), lyrics: kept }),
        ];
      } catch {
        // The next question asks again.
        return [];
      }
    };

    const look = async (): Promise<void> => {
      const changes = (await Promise.all(missing.map(lookUp))).flat();

      if (!stop.signal.aborted) sync.offerLyrics(changes);
    };

    void look();

    return () => {
      stop.abort();
    };
  }, [platform, sync, held]);

  return null;
}

type TrackLyrics = Awaited<ReturnType<PlatformSdk["music"]["lyrics"]["get"]>>;

/**
 * `lyrics` as a phone without the server shows them: a pending lookup shows the song's own plain
 * words it carries as its fallback, or none.
 */
const offlineLyricsOf = (lyrics: TrackLyrics): OfflineLyrics => {
  if (lyrics.status !== "pending") {
    return Option.getOrElse(decodeLyrics(lyrics), () => ({ status: "none" as const }));
  }

  if (lyrics.fallback === null) return { status: "none" };

  return Option.getOrElse(
    decodeLyrics({ status: "plain", source: "file", main: lyrics.fallback, extras: [] }),
    () => ({ status: "none" as const }),
  );
};

function ServerFeed({ sync }: { readonly sync: DownloadSync }) {
  const platform = usePlatform();

  const listed = useAllPages(
    platform.core.downloads.list,
    (paginationOpts) => ({ paginationOpts }),
    PAGE_ROWS,
  );

  const rows = listed.status === "ready" && listed.next.kind === "done" ? listed.rows : null;
  const kept = useMemo(() => (rows === null ? null : keptOf(rows)), [rows]);
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  useEffect(() => {
    if (kept !== null) sync.offerKept(new Set(kept.keys()));
  }, [sync, kept]);

  if (kept === null) return null;

  return (
    <>
      {snapshot.pins.map(({ pin }) => (
        <PinWatcher key={pin.id} sync={sync} pin={pin} kept={kept} />
      ))}
      {snapshot.lyricsQuestions.map((question) => (
        <LyricsWatcher key={question.key} sync={sync} held={question.held} />
      ))}
    </>
  );
}

/**
 * Whose downloads this phone opens: who is signed in, or while the server has not said, who last
 * signed in to it here. Nobody's while signed out: signing out deletes them.
 */
const useDownloadsAccount = (mediaUrl: string): UserId | null => {
  const platform = usePlatform();
  const status = usePlatformStatus();

  const me = useReadSettled(
    platform.core.auth.sessions.current,
    status === "signedIn" ? {} : "skip",
  );

  const signedIn = me === undefined || me instanceof Error ? null : me.userId;

  if (status === "signedOut") return null;

  return signedIn ?? lastPerson({ own: appKeychains().own, server: mediaUrl })?.userId ?? null;
};

/** The download quality, as the core keeps it for this device, or the last one chosen here. */
const useQuality = (): [DownloadQuality, (quality: DownloadQuality) => void] => {
  const platform = usePlatform();
  const status = usePlatformStatus();
  const settings = useReadSettled(platform.core.settings.get, status === "signedIn" ? {} : "skip");
  const [chosen, setChosen] = useState<DownloadQuality | null>(null);

  const device =
    settings === undefined || settings instanceof Error ? null : (settings.device ?? null);

  const quality = chosen ?? (device === null ? "high" : qualityOfSetting(device.downloadQuality));

  const setQuality = useCallback(
    (next: DownloadQuality) => {
      setChosen(next);
      void platform.core.settings
        .set({ downloadQuality: settingOfQuality(next) })
        .catch(() => undefined);
    },
    [platform],
  );

  return [quality, setQuality];
};

/**
 * Keeps the account's downloads on this phone while the app runs, and fetches new ones while the
 * server answers. Mount it inside the platform provider, above the session phase, which opens the
 * app on the downloads when the server is out of reach, and above the player, which plays
 * downloaded songs from their files.
 */
export function DownloadsProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const status = usePlatformStatus();
  const userId = useDownloadsAccount(mediaUrl);
  const [sync, setSync] = useState<DownloadSync | null>(null);
  const [quality, setQuality] = useQuality();
  const chosen = useRef(quality);
  const current = useRef<DownloadSync | null>(null);

  useLayoutEffect(() => {
    chosen.current = quality;
  }, [quality]);

  useLayoutEffect(() => {
    if (userId === null) return undefined;
    let closed = false;
    let created: DownloadSync | null = null;
    let shutting: Promise<void> | null = null;
    const opening = openVault(mediaUrl, userId);

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

    shutdowns.set(mediaUrl, shutdown);

    const run = async (): Promise<void> => {
      let vault: ExpoVault;

      try {
        vault = await opening;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        console.warn(`Downloads are unavailable: the vault didn't open (${reason}).`);

        return;
      }

      if (closed) return;

      const opened = new DownloadSync({
        core: coreFor(platform, mediaUrl),
        vault,
        transfer: expoTransfer,
        policy: () => policyFor(chosen.current),
        now: Date.now,
      });

      created = opened;
      opened.start();
      current.current = opened;
      setSync(opened);
    };

    void run();

    return () => {
      void shutdown().finally(() => {
        if (shutdowns.get(mediaUrl) === shutdown) shutdowns.delete(mediaUrl);
      });
    };
  }, [platform, mediaUrl, userId]);

  const copies = useMemo(
    (): DownloadedCopies => ({
      find: (trackId) => current.current?.localCopy(asTrackId(trackId)) ?? null,
      discard: (trackId, uri) => {
        current.current?.discard(asTrackId(trackId), uri);
      },
    }),
    [],
  );

  const setOnline = useCallback(
    (online: boolean) => {
      sync?.setOnline(online);
    },
    [sync],
  );

  const value = useMemo(
    () => ({ sync, copies, quality, setQuality, setOnline }),
    [sync, copies, quality, setQuality, setOnline],
  );

  return (
    <DownloadsContext value={value}>
      {sync === null || status !== "signedIn" ? null : <ServerFeed sync={sync} />}
      {children}
    </DownloadsContext>
  );
}

const useDownloads = (hook: string): Downloads => {
  const downloads = use(DownloadsContext);

  if (downloads === null) throw new Error(`${hook} must be used inside DownloadsProvider`);

  return downloads;
};

const useSnapshot = (sync: DownloadSync | null): DownloadsSnapshot =>
  useSyncExternalStore(sync?.subscribe ?? subscribeToNothing, sync?.getSnapshot ?? emptySnapshot);

/**
 * Tells the downloads whether the server answers, from below the session phase, which knows.
 * Fetching runs only while it does.
 */
export const useDownloadsReach = (online: boolean): void => {
  const { setOnline } = useDownloads("useDownloadsReach");

  useEffect(() => {
    setOnline(online);
  }, [setOnline, online]);
};

/**
 * The download of a song, album, or playlist on this phone, and the way to switch it. `details`
 * name a new download until its songs are read.
 */
export const useDownload = (target: DownloadTarget, details?: PinDetails): DownloadView => {
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

      await (status.kind === "none"
        ? sync.request(target, details ?? { title: "", subtitle: "", artUrl: null })
        : sync.remove(target));
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
 * Whether this phone holds a copy of `trackId`. Reads only this song's copy, so a row redraws when
 * its own song arrives or goes, not on every download.
 */
export const useTrackHeld = (trackId: TrackId | null): boolean => {
  const { sync } = useDownloads("useTrackHeld");

  return useSyncExternalStore(
    sync?.subscribe ?? subscribeToNothing,
    () => sync !== null && trackId !== null && sync.getSnapshot().copies.has(trackId),
  );
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
