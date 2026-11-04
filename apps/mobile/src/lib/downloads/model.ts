import {
  EpisodeId,
  MediaFileId,
  PlaybackSessionId,
  ProfileId,
  TitleId,
} from "@media/contracts/ids";
import { DownloadQuality } from "@media/contracts/media-playback";
import { Episode, MediaFile } from "@media/contracts/models/catalog";
import { Milliseconds } from "@media/contracts/units";
import { Data, Effect, Option, Schema, Struct } from "effect";

import { formatRuntime } from "../format";
import { sortedBy } from "../sorted-by";
import { formatBytes, formatPercent } from "../owner-format";

const DownloadPhase = Schema.Literals([
  "queued",
  "waitingForWifi",
  "preparing",
  "downloading",
  "ready",
  "interrupted",
  "noSpace",
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

const KeptPlayback = Schema.Struct({
  episode: Schema.NullOr(Episode),
  file: MediaFile,
  resumePositionMs: Milliseconds,
});

interface KeptPlayback extends Schema.Schema.Type<typeof KeptPlayback> {}

const Delivery = Schema.Struct({
  fileId: MediaFileId,
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

/** One movie or episode downloaded, or being downloaded, by one profile. */
export const DownloadRecord = Schema.Struct({
  /** `downloadIdOf` its profile, title, and episode. */
  id: Schema.String,
  profileId: ProfileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  /** The version asked for; null lets the server choose. */
  fileId: Schema.NullOr(MediaFileId),
  quality: DownloadQuality,
  /** The movie's name, or the show's for an episode. */
  titleName: Schema.String,
  episodeName: Schema.NullOr(Schema.String),
  seasonNumber: Schema.NullOr(Schema.Int),
  episodeNumber: Schema.NullOr(Schema.Int),
  runtimeMs: Schema.NullOr(Schema.Finite),
  /** Artwork key of its picture: the episode's still, else the backdrop, else the poster. */
  artwork: Schema.NullOr(Schema.String),
  /** Milliseconds since the epoch. */
  addedAt: Schema.Finite,
  phase: DownloadPhase,
  /** How far the media service is in preparing it, from 0 to 1. */
  prepared: Schema.Finite,
  receivedBytes: Schema.Finite,
  /** The size to download: the media service's estimate while preparing, then the exact size. */
  totalBytes: Schema.NullOr(Schema.Finite),
  delivery: Schema.NullOr(Delivery),
  playback: Schema.NullOr(KeptPlayback),
  /** The download session its transfer runs in, which a paused transfer resumes in. */
  sessionId: Schema.NullOr(PlaybackSessionId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
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
  profileId: ProfileId,
  titleId: TitleId,
  episodeId: Schema.NullOr(EpisodeId),
  fileId: MediaFileId,
  positionMs: Schema.Finite,
  durationMs: Schema.Finite,
  playedAt: Schema.Finite,
});

/** Progress made playing a download, waiting to reach the server. */
export interface PendingProgress extends Schema.Schema.Type<typeof PendingProgress> {}

/** Every download of one account on one server, and its unsent progress. */
export const DownloadStore = Schema.Struct({
  downloads: Schema.Array(DownloadRecord),
  pendingProgress: Schema.Array(PendingProgress),
});

/** Every download of one account on one server. */
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

/** The ID of a profile's download of a movie (`episodeId` null) or an episode. */
export const downloadIdOf = (
  profileId: ProfileId,
  titleId: TitleId,
  episodeId: EpisodeId | null,
): string => [profileId, titleId, episodeId ?? "movie"].join("-");

/** What a new download starts from: the item, its version, and how it is shown. */
export type NewDownload = Pick<
  DownloadRecord,
  | "profileId"
  | "titleId"
  | "episodeId"
  | "fileId"
  | "quality"
  | "titleName"
  | "episodeName"
  | "seasonNumber"
  | "episodeNumber"
  | "runtimeMs"
  | "artwork"
>;

/** A change to the store. */
export type DownloadEvent = Data.TaggedEnum<{
  /** Queues a download; one already kept for the same item is left as it is. */
  Added: { readonly download: NewDownload; readonly at: number };
  Removed: { readonly id: string };
  /** Removes every download of `profileId`. */
  RemovedAll: { readonly profileId: ProfileId };
  /** Waits for Wi-Fi (`wifi`), or for its turn again. */
  Waiting: { readonly id: string; readonly wifi: boolean; readonly resume: string | null };
  /** Its download session started; kept so a later run ends it when it cannot carry on in it. */
  SessionStarted: { readonly id: string; readonly sessionId: PlaybackSessionId };
  Preparing: { readonly id: string; readonly progress: number; readonly estimatedBytes: number };
  /** A transfer starts from the first byte. */
  Delivering: {
    readonly id: string;
    readonly delivery: Delivery;
    readonly playback: KeptPlayback;
    readonly sessionId: PlaybackSessionId;
  };
  Received: { readonly id: string; readonly bytes: number };
  Finished: { readonly id: string };
  Interrupted: { readonly id: string; readonly error: string; readonly resume: string | null };
  /** Stopped because this iPhone lacks the space for `totalBytes`. */
  NoSpace: { readonly id: string; readonly totalBytes: number };
  /** Queues an interrupted or stopped download again. */
  Retried: { readonly id: string };
  /** Played to `positionMs` at `at`; queues the progress for the server. */
  Played: {
    readonly id: string;
    readonly positionMs: number;
    readonly durationMs: number;
    readonly at: number;
  };
  /** The server took (or refused for good) the pending progress of these items. */
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

const sameItem = (left: PendingProgress, right: PendingProgress): boolean =>
  left.profileId === right.profileId &&
  left.titleId === right.titleId &&
  left.episodeId === right.episodeId;

/** The store after `event`. */
export const reduce = (store: DownloadStore, event: DownloadEvent): DownloadStore =>
  DownloadEvent.$match(event, {
    Added: ({ download, at }) => {
      const id = downloadIdOf(download.profileId, download.titleId, download.episodeId);

      if (store.downloads.some((existing) => existing.id === id)) return store;

      const added: DownloadRecord = {
        ...download,
        id,
        addedAt: at,
        phase: "queued",
        prepared: 0,
        receivedBytes: 0,
        totalBytes: null,
        delivery: null,
        playback: null,
        sessionId: null,
        resume: null,
        error: null,
        positionMs: 0,
      };

      return { downloads: [...store.downloads, added], pendingProgress: store.pendingProgress };
    },
    Removed: ({ id }) => ({
      downloads: store.downloads.filter((download) => download.id !== id),
      pendingProgress: store.pendingProgress,
    }),
    RemovedAll: ({ profileId }) => ({
      downloads: store.downloads.filter((download) => download.profileId !== profileId),
      pendingProgress: store.pendingProgress,
    }),
    Waiting: ({ id, wifi, resume }) =>
      update(store, id, (download) =>
        download.phase === "ready"
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
    SessionStarted: ({ id, sessionId }) =>
      update(store, id, (download) => Struct.assign(download, { sessionId })),
    Delivering: ({ id, delivery, playback, sessionId }) =>
      update(store, id, (download) =>
        Struct.assign(download, {
          phase: "downloading",
          prepared: 1,
          receivedBytes: 0,
          totalBytes: delivery.sizeBytes,
          delivery,
          playback,
          sessionId,
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
    Played: ({ id, positionMs, durationMs, at }) => {
      const played = store.downloads.find((download) => download.id === id);
      const fileId = played?.delivery?.fileId;

      if (played === undefined || fileId === undefined) return store;

      const pending: PendingProgress = {
        profileId: played.profileId,
        titleId: played.titleId,
        episodeId: played.episodeId,
        fileId,
        positionMs,
        durationMs,
        playedAt: at,
      };

      return {
        downloads: store.downloads.map((download) =>
          download.id === id ? Struct.assign(download, { positionMs }) : download,
        ),
        pendingProgress: [
          ...store.pendingProgress.filter((entry) => !sameItem(entry, pending)),
          pending,
        ],
      };
    },
    ProgressSent: ({ sent }) => ({
      downloads: store.downloads,
      pendingProgress: store.pendingProgress.filter(
        (entry) => !sent.some((done) => sameItem(done, entry) && done.playedAt >= entry.playedAt),
      ),
    }),
  });

/** A profile's downloads, oldest first, as C19 lists them. */
export const downloadsOf = (
  store: DownloadStore,
  profileId: ProfileId,
): ReadonlyArray<DownloadRecord> =>
  sortedBy(
    store.downloads.filter((download) => download.profileId === profileId),
    (left, right) => left.addedAt - right.addedAt,
  );

/**
 * Download `id` when profile `profileId` made it, else none: a download opens and plays only for
 * the profile that downloaded it. The account is the store's own, one store per account folder.
 */
export const downloadFor = (
  store: DownloadStore,
  id: string | null,
  profileId: ProfileId,
): DownloadRecord | undefined =>
  store.downloads.find((download) => download.id === id && download.profileId === profileId);

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
};

/** `Ready to Play`, `Downloading · 64%`, `Waiting for Wi-Fi`, and the other states. */
export const statusOf = (download: DownloadRecord): string => STATUSES[download.phase](download);

/** A row's heading: the movie's name, or `3. Who Is Alive?` for an episode. */
export const headingOf = (download: DownloadRecord): string =>
  download.episodeName === null
    ? download.titleName
    : download.episodeNumber === null
      ? download.episodeName
      : `${download.episodeNumber}. ${download.episodeName}`;

/** A row's second line: the status, after the show's name for an episode. */
export const lineOf = (download: DownloadRecord): string =>
  download.episodeName === null
    ? statusOf(download)
    : `${download.titleName} · ${statusOf(download)}`;

/** `Season 2, Episode 3 · 53m` for an episode, the runtime for a movie (H17). */
export const factsOf = (download: DownloadRecord): string =>
  [
    download.seasonNumber === null || download.episodeNumber === null
      ? null
      : `Season ${download.seasonNumber}, Episode ${download.episodeNumber}`,
    download.runtimeMs === null ? null : formatRuntime(download.runtimeMs),
  ]
    .filter((part) => part !== null)
    .join(" · ");

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
