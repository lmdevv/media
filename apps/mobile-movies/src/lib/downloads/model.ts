import { StartedPlayback } from "@media/contracts/models/playback";
import type { PlatformSdk } from "@media/sdk/promise";
import { Data, Option, Schema, Struct } from "effect";

import { formatRuntime } from "../format";
import { sortedBy } from "../sorted-by";
import { formatBytes, formatPercent } from "../owner-format";

const TitleId = Schema.String.pipe(Schema.brand("Id<titles>"));

const EpisodeId = Schema.String.pipe(Schema.brand("Id<episodes>"));

const FileId = Schema.String.pipe(Schema.brand("Id<mediaFiles>"));

/** A movies file on the core, which names a download (`{ kind: "file", id }`). */
export type FileId = typeof FileId.Type;

const DownloadPhase = Schema.Literals([
  "queued",
  "waitingForWifi",
  "preparing",
  "downloading",
  "ready",
  "interrupted",
  "noSpace",
  "expired",
]);

type DownloadPhase = typeof DownloadPhase.Type;

const KeptSubtitle = Schema.Struct({
  id: Schema.String,
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  forced: Schema.Boolean,
  default: Schema.Boolean,
  hearingImpaired: Schema.Boolean,
});

interface KeptSubtitle extends Schema.Schema.Type<typeof KeptSubtitle> {}

/**
 * What the player needs of a download offline, as `movies.play.start` described its file: the
 * episode, the file with its probe, and where the person had stopped when it was downloaded.
 */
const KeptPlayback = Schema.Struct({
  episode: StartedPlayback.fields.episode,
  file: StartedPlayback.fields.file,
  resumePositionMs: StartedPlayback.fields.resumePositionMs,
});

/** What the player needs of a download offline. */
export interface KeptPlayback extends Schema.Schema.Type<typeof KeptPlayback> {}

const decodeKeptPlayback = Schema.decodeUnknownOption(KeptPlayback);

/** What `movies.play.start` answers. */
export type CoreStart = Awaited<ReturnType<PlatformSdk["movies"]["play"]["start"]>>;

/**
 * The kept playback of `start`, the core's answer to `movies.play.start` for the download's file;
 * none when the media contracts do not describe it. The core lists only files on disk, so the
 * file is never missing.
 */
export const keptPlaybackOf = (
  start: Pick<CoreStart, "episode" | "file" | "resumePositionMs">,
): Option.Option<KeptPlayback> =>
  decodeKeptPlayback({
    episode: start.episode,
    file: { ...start.file, missing: false },
    resumePositionMs: start.resumePositionMs,
  });

const Delivery = Schema.Struct({
  sizeBytes: Schema.Finite,
  container: Schema.Literals(["mp4", "mov"]),
  durationMs: Schema.Finite,
  videoCodec: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  audio: Schema.NullOr(
    Schema.Struct({ streamIndex: Schema.Int, codec: Schema.String, channels: Schema.Int }),
  ),
  subtitles: Schema.Array(KeptSubtitle),
});

/** What the media service delivers for a download. */
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

/** One movie or episode file downloaded, or being downloaded, by the person the store is for. */
export const DownloadRecord = Schema.Struct({
  /** The file, which names the download to the core as `{ kind: "file", id }`. */
  id: FileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /** The movie's name, or the show's for an episode. */
  titleName: Schema.String,
  /** The movie's runtime; an episode's comes with its playback. */
  runtimeMs: Schema.NullOr(Schema.Finite),
  /** The title's artwork path (`/artwork/<key>?ticket=…`): its backdrop, else its poster. */
  artwork: Schema.NullOr(Schema.String),
  /** Whether `core.downloads.add` took it, so the core's list speaks for it. */
  added: Schema.Boolean,
  /** Milliseconds since the epoch. */
  addedAt: Schema.Finite,
  phase: DownloadPhase,
  /** How far the media service is in preparing it, from 0 to 1. */
  prepared: Schema.Finite,
  receivedBytes: Schema.Finite,
  /** The size to download: the media service's estimate while preparing, then the exact size. */
  totalBytes: Schema.NullOr(Schema.Finite),
  /** The core's revision of the file this copy, or its transfer, holds. */
  revision: Schema.NullOr(Schema.String),
  delivery: Schema.NullOr(Delivery),
  playback: Schema.NullOr(KeptPlayback),
  /** When the ticket in a paused transfer's URL expires; a later resume starts over. */
  ticketExpiresAt: Schema.NullOr(Schema.Finite),
  /** A paused transfer's saved state, to resume it without starting over. */
  resume: Schema.NullOr(Schema.String),
  /** Why it was interrupted, as people read it. */
  error: Schema.NullOr(Schema.String),
  /** Where this iPhone last stopped playing it. */
  positionMs: Schema.Finite,
});

/** One movie or episode downloaded, or being downloaded. */
export interface DownloadRecord extends Schema.Schema.Type<typeof DownloadRecord> {}

const PendingProgress = Schema.Struct({
  fileId: FileId,
  positionMs: Schema.Finite,
  durationMs: Schema.Finite,
  playedAt: Schema.Finite,
});

/** Progress made playing a download, waiting to reach the server. */
export interface PendingProgress extends Schema.Schema.Type<typeof PendingProgress> {}

/** Every download of one person on one server, and its unsent progress. */
export const DownloadStore = Schema.Struct({
  downloads: Schema.Array(DownloadRecord),
  pendingProgress: Schema.Array(PendingProgress),
});

/** Every download of one person on one server. */
export interface DownloadStore extends Schema.Schema.Type<typeof DownloadStore> {}

/** A store with nothing in it. */
export const EMPTY_STORE: DownloadStore = { downloads: [], pendingProgress: [] };

const StoredStore = Schema.fromJsonString(DownloadStore);

const StoredEntries = Schema.fromJsonString(
  Schema.Struct({
    downloads: Schema.Array(Schema.Unknown),
    pendingProgress: Schema.Array(Schema.Unknown),
  }),
);

const decodeEntries = Schema.decodeUnknownOption(StoredEntries);

const decodeRecord = Schema.decodeUnknownOption(DownloadRecord);

const decodePending = Schema.decodeUnknownOption(PendingProgress);

/**
 * The store kept in `text`, or an empty one when there is none or it cannot be read. Each entry is
 * read on its own, so one that cannot be read (written by another version) costs only itself.
 */
export const parseStore = (text: string | null): DownloadStore =>
  Option.match(text === null ? Option.none() : decodeEntries(text), {
    onNone: () => EMPTY_STORE,
    onSome: (entries) => ({
      downloads: entries.downloads.flatMap((entry) => Option.toArray(decodeRecord(entry))),
      pendingProgress: entries.pendingProgress.flatMap((entry) =>
        Option.toArray(decodePending(entry)),
      ),
    }),
  });

/** The store as the JSON it is kept as. */
export const serializeStore = Schema.encodeSync(StoredStore);

/** What a new download starts from: the file, its title and episode, and how it is shown. */
export type NewDownload = Pick<
  DownloadRecord,
  "id" | "titleId" | "episodeId" | "titleName" | "runtimeMs" | "artwork"
>;

/** A change to the store. */
export type DownloadEvent = Data.TaggedEnum<{
  /** Queues a download; one already kept for the same file is left as it is. */
  Added: { readonly download: NewDownload; readonly at: number };
  /** `core.downloads.add` took it. */
  Confirmed: { readonly id: string };
  /** `movies.play.start` described its file and episode. */
  Described: { readonly id: string; readonly playback: KeptPlayback };
  Removed: { readonly id: string };
  /** Waits for Wi-Fi (`wifi`), or for its turn again. */
  Waiting: { readonly id: string; readonly wifi: boolean; readonly resume: string | null };
  Preparing: { readonly id: string; readonly progress: number; readonly estimatedBytes: number };
  /** A transfer of `revision` starts from the first byte, with a ticket valid until then. */
  Delivering: {
    readonly id: string;
    readonly delivery: Delivery;
    readonly revision: string;
    readonly ticketExpiresAt: number;
  };
  Received: { readonly id: string; readonly bytes: number };
  Finished: { readonly id: string };
  Interrupted: { readonly id: string; readonly error: string; readonly resume: string | null };
  /** Stopped because this iPhone lacks the space for `totalBytes`. */
  NoSpace: { readonly id: string; readonly totalBytes: number };
  /** Queues an interrupted or stopped download again. */
  Retried: { readonly id: string };
  /** The person may no longer keep it here: its copy is deleted, and it waits for access. */
  Expired: { readonly id: string };
  /** Downloads it again from the first byte: access came back, or the file changed. */
  Refreshed: { readonly id: string };
  /** Played to `positionMs` at `at`; queues the progress for the server. */
  Played: {
    readonly id: string;
    readonly positionMs: number;
    readonly durationMs: number;
    readonly at: number;
  };
  /** The server took (or refused for good) the pending progress of these files. */
  ProgressSent: { readonly sent: ReadonlyArray<PendingProgress> };
}>;

/** Constructors and matchers for `DownloadEvent`. */
export const DownloadEvent = Data.taggedEnum<DownloadEvent>();

const update = (
  store: DownloadStore,
  id: string,
  change: (download: DownloadRecord) => DownloadRecord,
): DownloadStore => ({
  downloads: store.downloads.map((download) => (download.id === id ? change(download) : download)),
  pendingProgress: store.pendingProgress,
});

/** What a download holds before its first byte: no copy, no transfer, no revision. */
const NOTHING_KEPT = {
  prepared: 0,
  receivedBytes: 0,
  totalBytes: null,
  revision: null,
  delivery: null,
  ticketExpiresAt: null,
  resume: null,
  error: null,
} as const;

/** The store after `event`. */
export const reduce = (store: DownloadStore, event: DownloadEvent): DownloadStore =>
  DownloadEvent.$match(event, {
    Added: ({ download, at }) => {
      if (store.downloads.some((existing) => existing.id === download.id)) return store;

      const added: DownloadRecord = {
        ...download,
        ...NOTHING_KEPT,
        added: false,
        addedAt: at,
        phase: "queued",
        playback: null,
        positionMs: 0,
      };

      return { downloads: [...store.downloads, added], pendingProgress: store.pendingProgress };
    },
    Confirmed: ({ id }) =>
      update(store, id, (download) => Struct.assign(download, { added: true })),
    Described: ({ id, playback }) =>
      update(store, id, (download) => Struct.assign(download, { playback })),
    Removed: ({ id }) => ({
      downloads: store.downloads.filter((download) => download.id !== id),
      pendingProgress: store.pendingProgress,
    }),
    Waiting: ({ id, wifi, resume }) =>
      update(store, id, (download) =>
        download.phase === "ready" || download.phase === "expired"
          ? download
          : Struct.assign(download, {
              phase: wifi ? "waitingForWifi" : "queued",
              resume,
              error: null,
            } as const),
      ),
    Preparing: ({ id, progress, estimatedBytes }) =>
      update(store, id, (download) =>
        Struct.assign(download, {
          phase: "preparing",
          prepared: progress,
          totalBytes: estimatedBytes,
          error: null,
        } as const),
      ),
    Delivering: ({ id, delivery, revision, ticketExpiresAt }) =>
      update(store, id, (download) =>
        Struct.assign(download, {
          phase: "downloading",
          prepared: 1,
          receivedBytes: 0,
          totalBytes: delivery.sizeBytes,
          revision,
          delivery,
          ticketExpiresAt,
          error: null,
        } as const),
      ),
    Received: ({ id, bytes }) =>
      update(store, id, (download) => Struct.assign(download, { receivedBytes: bytes })),
    Finished: ({ id }) =>
      update(store, id, (download) =>
        Struct.assign(download, {
          phase: "ready",
          receivedBytes: download.totalBytes ?? download.receivedBytes,
          ticketExpiresAt: null,
          resume: null,
          error: null,
        } as const),
      ),
    Interrupted: ({ id, error, resume }) =>
      update(store, id, (download) =>
        Struct.assign(download, { phase: "interrupted", error, resume } as const),
      ),
    NoSpace: ({ id, totalBytes }) =>
      update(store, id, (download) =>
        Struct.assign(download, {
          phase: "noSpace",
          totalBytes,
          receivedBytes: 0,
          resume: null,
        } as const),
      ),
    Retried: ({ id }) =>
      update(store, id, (download) =>
        download.phase === "interrupted" || download.phase === "noSpace"
          ? Struct.assign(download, { phase: "queued", error: null } as const)
          : download,
      ),
    Expired: ({ id }) =>
      update(store, id, (download) =>
        Struct.assign(download, { ...NOTHING_KEPT, phase: "expired" } as const),
      ),
    Refreshed: ({ id }) =>
      update(store, id, (download) =>
        Struct.assign(download, { ...NOTHING_KEPT, phase: "queued" } as const),
      ),
    Played: ({ id, positionMs, durationMs, at }) => {
      const played = store.downloads.find((download) => download.id === id);

      if (played === undefined) return store;

      const pending: PendingProgress = { fileId: played.id, positionMs, durationMs, playedAt: at };

      return {
        downloads: store.downloads.map((download) =>
          download.id === id ? Struct.assign(download, { positionMs }) : download,
        ),
        pendingProgress: [
          ...store.pendingProgress.filter((entry) => entry.fileId !== pending.fileId),
          pending,
        ],
      };
    },
    ProgressSent: ({ sent }) => ({
      downloads: store.downloads,
      pendingProgress: store.pendingProgress.filter(
        (entry) =>
          !sent.some((done) => done.fileId === entry.fileId && done.playedAt >= entry.playedAt),
      ),
    }),
  });

/** The person's downloads, oldest first, as C19 lists them. */
export const downloadsOf = (store: DownloadStore): ReadonlyArray<DownloadRecord> =>
  sortedBy(store.downloads, (left, right) => left.addedAt - right.addedAt);

/** Download `id`, or none. */
export const downloadFor = (store: DownloadStore, id: string | null): DownloadRecord | undefined =>
  store.downloads.find((download) => download.id === id);

/** One entry of the core's list of what this device keeps, as the sync reads it. */
export type ListedDownload =
  | { readonly id: FileId; readonly state: "available"; readonly revision: string }
  | { readonly id: FileId; readonly state: "expired" }
  | { readonly id: FileId; readonly state: "gone" };

/** What the device does to follow the core's list. */
export interface SyncPlan {
  /** Downloads the person may no longer keep: their copies are deleted, and they show expired. */
  readonly expire: ReadonlyArray<FileId>;
  /** Downloads to fetch again: access came back, or the file has a new revision. */
  readonly refresh: ReadonlyArray<FileId>;
  /** Downloads whose file or library is gone: their copies are deleted, and `remove` is called. */
  readonly drop: ReadonlyArray<FileId>;
  /** Downloads the core no longer lists for this device: their copies are deleted. */
  readonly purge: ReadonlyArray<FileId>;
  /** Listed items this device holds nothing of: `remove` frees them. */
  readonly forget: ReadonlyArray<FileId>;
}

/**
 * How the device follows `listed`, every page of the core's list. Only a download in `addedBefore`
 * (the ones the core had taken when the list was first read) is purged for being unlisted, so one
 * added while the pages were read is never mistaken for one the core dropped.
 */
export const planSync = (
  store: DownloadStore,
  listed: ReadonlyArray<ListedDownload>,
  addedBefore: ReadonlySet<string>,
): SyncPlan => {
  const entries = new Map(listed.map((entry) => [entry.id, entry]));
  const expire: Array<FileId> = [];
  const refresh: Array<FileId> = [];
  const drop: Array<FileId> = [];
  const purge: Array<FileId> = [];

  for (const download of store.downloads) {
    const entry = entries.get(download.id);

    if (entry === undefined) {
      if (download.added && addedBefore.has(download.id)) purge.push(download.id);
    } else if (entry.state === "gone") {
      drop.push(download.id);
    } else if (entry.state === "expired") {
      if (download.phase !== "expired") expire.push(download.id);
    } else if (
      download.phase === "expired" ||
      (download.phase === "ready" && download.revision !== entry.revision)
    ) {
      refresh.push(download.id);
    }
  }

  const kept = new Set(store.downloads.map((download) => download.id));

  return {
    expire,
    refresh,
    drop,
    purge,
    forget: listed.flatMap((entry) => (kept.has(entry.id) ? [] : [entry.id])),
  };
};

const bytesKept = (download: DownloadRecord): number =>
  download.phase === "ready" ? (download.totalBytes ?? 0) : download.receivedBytes;

/** What a list of downloads adds up to. */
export interface DownloadSummary {
  /** `3 Items`. */
  readonly items: string;
  /** `2.4 GB`. */
  readonly size: string;
  readonly bytes: number;
}

/** `3 Items` and `2.4 GB`, above C19's rows and beside H18's Storage Used. */
export const summaryOf = (downloads: ReadonlyArray<DownloadRecord>): DownloadSummary => {
  const bytes = downloads.reduce((total, download) => total + bytesKept(download), 0);

  return {
    items: `${downloads.length} ${downloads.length === 1 ? "Item" : "Items"}`,
    size: formatBytes(bytes),
    bytes,
  };
};

/** How far the transfer is, from 0 to 1; null before the size is known. */
export const transferFraction = (download: DownloadRecord): number | null =>
  download.totalBytes === null || download.totalBytes <= 0 || download.delivery === null
    ? null
    : Math.min(1, download.receivedBytes / download.totalBytes);

const STATUSES: Readonly<Record<DownloadPhase, (download: DownloadRecord) => string>> = {
  ready: () => "Ready to Play",
  downloading: (download) => `Downloading · ${formatPercent(transferFraction(download) ?? 0)}`,
  preparing: (download) =>
    download.prepared > 0 ? `Preparing · ${formatPercent(download.prepared)}` : "Preparing",
  queued: () => "Queued",
  waitingForWifi: () => "Waiting for Wi-Fi",
  interrupted: () => "Download interrupted",
  noSpace: () => "Not enough space",
  expired: () => "Expired",
};

/** `Ready to Play`, `Downloading · 64%`, `Waiting for Wi-Fi`, and the other states. */
export const statusOf = (download: DownloadRecord): string => STATUSES[download.phase](download);

const episodeOf = (download: DownloadRecord): KeptPlayback["episode"] =>
  download.playback?.episode ?? null;

/** The episode's name, else the movie's or show's. */
export const nameOf = (download: DownloadRecord): string =>
  episodeOf(download)?.name ?? download.titleName;

/** The artwork path of a download's picture: the episode's still, else the title's. */
export const pictureOf = (download: DownloadRecord): string | null =>
  episodeOf(download)?.still ?? download.artwork;

/** A row's heading: the movie's name, or `3. Who Is Alive?` for an episode. */
export const headingOf = (download: DownloadRecord): string => {
  const episode = episodeOf(download);

  return episode === null ? download.titleName : `${episode.episodeNumber}. ${episode.name}`;
};

/** A row's second line: the status, after the show's name for an episode. */
export const lineOf = (download: DownloadRecord): string =>
  episodeOf(download) === null
    ? statusOf(download)
    : `${download.titleName} · ${statusOf(download)}`;

/** `Season 2, Episode 3 · 53m` for an episode, the runtime for a movie (H17). */
export const factsOf = (download: DownloadRecord): string => {
  const episode = episodeOf(download);
  const runtimeMs = episode === null ? download.runtimeMs : episode.runtimeMs;

  return [
    episode === null ? null : `Season ${episode.seasonNumber}, Episode ${episode.episodeNumber}`,
    runtimeMs === null ? null : formatRuntime(runtimeMs),
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** `Downloaded · 720p · 842 MB`, under Play Download (H17). */
export const keptLine = (download: DownloadRecord): string =>
  [
    "Downloaded",
    download.delivery === null ? null : `${download.delivery.height}p`,
    formatBytes(bytesKept(download)),
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** The network as a transfer sees it. */
export interface NetworkNow {
  readonly connected: boolean;
  readonly wifi: boolean;
}

/** Whether a transfer may run now under Wi-Fi Only. */
export const mayTransfer = (network: NetworkNow, wifiOnly: boolean): boolean =>
  network.connected && (network.wifi || !wifiOnly);

/**
 * The next download to work on: the oldest queued or waiting one not already `running`; null when
 * none is.
 */
export const nextToRun = (
  store: DownloadStore,
  running: ReadonlySet<string> = new Set(),
): DownloadRecord | null =>
  sortedBy(
    store.downloads.filter(
      (download) =>
        (download.phase === "queued" || download.phase === "waitingForWifi") &&
        !running.has(download.id),
    ),
    (left, right) => left.addedAt - right.addedAt,
  )[0] ?? null;

const SPACE_RESERVE_BYTES = 500_000_000;

/** Bytes to free before `neededBytes` more fit beside `freeBytes`, keeping the reserve; 0 when they fit. */
export const spaceShortfall = (neededBytes: number, freeBytes: number): number =>
  Math.max(0, neededBytes + SPACE_RESERVE_BYTES - freeBytes);
