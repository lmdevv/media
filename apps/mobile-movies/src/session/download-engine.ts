import { PlaybackSessionId } from "@media/contracts/ids";
import type { PrepareDownloadResponse } from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import { EpochMillis } from "@media/contracts/units";
import { Downloads } from "@media/sdk/effect";
import type { PlatformSdk } from "@media/sdk/promise";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import type { DownloadPauseState } from "expo-file-system";

import { artworkUrl } from "@/lib/artwork";
import {
  ARTWORK_FILE,
  STORE_FILE,
  itemFolder,
  subtitleFile,
  videoFile,
} from "@/lib/downloads/files";
import {
  DOWNLOAD_STOPPED,
  DownloadStep,
  SERVER_UNAVAILABLE,
  afterDownloadFailure,
  failureLine,
} from "@/lib/downloads/failures";
import {
  DownloadEvent,
  keptPlaybackOf,
  mayTransfer,
  nextToRun,
  parseStore,
  pictureOf,
  planSync,
  reduce,
  serializeStore,
  spaceShortfall,
} from "@/lib/downloads/model";
import type {
  Delivery,
  DownloadRecord,
  DownloadStore,
  FileId,
  KeptPlayback,
  ListedDownload,
  NetworkNow,
  NewDownload,
  PendingProgress,
  SyncPlan,
} from "@/lib/downloads/model";
import type { DownloadSettings } from "@/lib/downloads/settings";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";

type DownloadReady = Extract<PrepareDownloadResponse, { readonly _tag: "Ready" }>;

type Fetched = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["fetch"]>>;

/** A `download` ticket for the current revision of a file, from `core.downloads.fetch`. */
type Ticket = Extract<Fetched, { readonly state: "available" }>;

type ListPage = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["list"]>>;

type ListRow = ListPage["page"][number];

/** Everything the screens read. */
export interface DownloadsSnapshot {
  readonly store: DownloadStore;
  readonly settings: DownloadSettings;
  readonly network: NetworkNow;
}

/** Where an engine keeps its files and which server it downloads from. */
export interface EngineOptions {
  /** The person's folder, `downloads/<server>/<person>` under the documents folder. */
  readonly folder: Directory;
  readonly mediaUrl: string;
  readonly settings: DownloadSettings;
}

/**
 * A byte count from expo-file-system as a number. Its iOS module answers an `Int64`, which Expo
 * hands over as a BigInt although it is typed as a number, and no sum with a number survives one.
 */
const byteCount = (value: number | bigint): number => Number(value);

/** The phone's free space in bytes. */
const freeSpace = (): number => byteCount(Paths.availableDiskSpace);

/** Rows asked for per page of `core.downloads.list`, the most it answers. */
const LIST_PAGE_SIZE = 200;

const PREPARE_EVERY_MS = 3_000;

const BUSY_RETRY_MS = 10_000;

const STALL_AFTER_MS = 20_000;

const STALL_CHECK_MS = 5_000;

const HEALTH_TIMEOUT_MS = 5_000;

/** A ticket closer than this to expiring is replaced before the media service is asked. */
const TICKET_MARGIN_MS = 60_000;

const MAX_RUNS = 2;

const MAX_RESTARTS = 3;

const SAVE_EVERY_MS = 2_000;

const SHOW_EVERY_MS = 500;

const DownloadPauseStateJson = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.String,
    fileUri: Schema.String,
    isDirectory: Schema.Boolean,
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    resumeData: Schema.NonEmptyString,
  }),
);

const decodePauseState = Schema.decodeUnknownOption(DownloadPauseStateJson);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** `run`'s result, or what it rejected with: the core's commands reject with tagged failures. */
const attempt = async <A>(run: () => Promise<A>): Promise<Result.Result<A, unknown>> => {
  try {
    return Result.succeed(await run());
  } catch (cause) {
    return Result.fail(cause);
  }
};

const itemOf = (id: FileId) => ({ kind: "file", id }) as const;

const listedOf = ({ item, ...row }: ListRow): ReadonlyArray<ListedDownload> => {
  if (item.kind !== "file") return [];

  if (row.state === "available") {
    return [{ id: item.id, state: "available", revision: row.revision }];
  }

  return [
    row.state === "expired" ? { id: item.id, state: "expired" } : { id: item.id, state: "gone" },
  ];
};

/**
 * The media service's view of a download with `ticket`: its playback API reads only the ticket and
 * the server's address, and takes the file and episode `movies.play.start` described.
 */
const startedOf = (
  download: DownloadRecord,
  playback: KeptPlayback,
  ticket: Ticket,
  mediaUrl: string,
): StartedPlayback => ({
  sessionId: PlaybackSessionId.make(`download-${download.id}`),
  titleId: playback.file.titleId,
  episodeId: playback.file.episodeId,
  episode: playback.episode,
  file: playback.file,
  token: ticket.ticket,
  tokenExpiresAt: EpochMillis.make(ticket.expiresAt),
  mediaBaseUrl: mediaUrl,
  resumePositionMs: playback.resumePositionMs,
});

/** Asks the media service to make a download ready (`POST /api/downloads/prepare`). */
const prepareDownload = async (
  started: StartedPlayback,
  quality: Ticket["quality"],
): Promise<Result.Result<PrepareDownloadResponse, unknown>> => {
  try {
    return await Effect.runPromise(
      Effect.result(Downloads.prepare(started, IOS_CAPABILITIES, quality, Option.none())),
    );
  } catch (cause) {
    return Result.fail(cause);
  }
};

interface Active {
  readonly id: string;
  task: DownloadTask | null;
  cancelled: boolean;
  /** Paused for Wi-Fi Only: the task's own promise resolves with null. */
  pausing: boolean;
}

interface Preparation {
  /** The ticket to ask with; null fetches one. */
  readonly ticket: Ticket | null;
  readonly restarts: number;
}

const deliveryOf = (ready: DownloadReady, kept: ReadonlySet<string>): Delivery => ({
  sizeBytes: ready.sizeBytes,
  container: ready.container === "mov" ? "mov" : "mp4",
  durationMs: Math.round(ready.durationSeconds * 1000),
  videoCodec: ready.video.codec,
  width: ready.video.width,
  height: ready.video.height,
  audio: ready.audio ?? null,
  subtitles: ready.subtitles.flatMap((subtitle) =>
    kept.has(subtitle.id)
      ? [
          {
            id: subtitle.id,
            language: subtitle.language ?? null,
            title: subtitle.title ?? null,
            forced: subtitle.forced,
            default: subtitle.default,
            hearingImpaired: subtitle.hearingImpaired,
          },
        ]
      : [],
  ),
});

/**
 * Keeps and downloads one person's downloads on one server, following the core's list of what
 * this device keeps (ADR 0019). Create it, then `dispose` it.
 */
export class DownloadEngine {
  readonly #platform: PlatformSdk;
  readonly #options: EngineOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: DownloadsSnapshot;
  readonly #active = new Map<string, Active>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #artwork = new Map<string, string | null>();
  /**
   * Downloads the core's list may drop: those it has listed, and those added in an earlier run.
   * One added in this run but not listed yet is never purged for being missing.
   */
  readonly #settled: Set<string>;
  #list: ReturnType<PlatformSdk["core"]["downloads"]["list"]["watch"]> | null = null;
  #unfollowList: (() => void) | null = null;
  #syncing = false;
  #syncNext: ListPage | null = null;
  #sending = false;
  #started = false;
  #disposed = false;

  constructor(platform: PlatformSdk, options: EngineOptions) {
    this.#platform = platform;
    this.#options = options;

    const stored = parseStore(this.#readStore());

    const settled = stored.downloads.reduce(
      (store, download) =>
        download.phase === "preparing" || download.phase === "downloading"
          ? reduce(
              store,
              DownloadEvent.Waiting({ id: download.id, wifi: false, resume: download.resume }),
            )
          : store,
      stored,
    );

    this.#settled = new Set(
      stored.downloads.filter((download) => download.added).map((download) => download.id),
    );

    this.#snapshot = {
      store: settled,
      settings: options.settings,
      network: { connected: false, wifi: false },
    };
  }

  /** The current state; a new object after every change. */
  readonly getSnapshot = (): DownloadsSnapshot => this.#snapshot;

  /** Calls `listener` after every change; returns the function that stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Starts working, once the person is confirmed signed in here: follows the core's list, runs the
   * first download in line, and sends any progress waiting for the server. Until then the engine
   * only shows what is kept.
   */
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#followList();
    this.#pump();
    void this.sendProgress();
  }

  /** Stops every transfer for good, keeping what was saved; the engine does nothing after. */
  dispose(): void {
    this.#disposed = true;
    this.#unfollowList?.();
    clearTimeout(this.#showTimer);
    this.#save();

    for (const active of this.#active.values()) active.task?.cancel();
  }

  /** Queues a download; one already kept for the same file stays as it is. */
  add(download: NewDownload): void {
    this.#dispatch(DownloadEvent.Added({ download, at: Date.now() }));
    this.#pump();
  }

  /** Queues an interrupted or stopped download again (Retry Download). */
  retry(id: string): void {
    this.#dispatch(DownloadEvent.Retried({ id }));
    this.#pump();
  }

  /**
   * Cancels a download or removes a kept one, deleting its files (Remove, Cancel Download), and
   * tells the core. A refusal or a server out of reach leaves the core's row, which the next
   * reading of the list removes again.
   */
  async remove(id: string): Promise<void> {
    const download = this.#find(id);

    this.#discard(id);
    this.#pump();

    if (download !== undefined) void this.#forget(download.id);

    await Promise.resolve();
  }

  /** Removes every download (Remove All Downloads). */
  async removeAll(): Promise<void> {
    await Promise.all(this.#snapshot.store.downloads.map((download) => this.remove(download.id)));
  }

  /** Records where a download was played to, and sends it on when the server is reachable. */
  played(id: string, positionMs: number, durationMs: number): void {
    this.#dispatch(
      DownloadEvent.Played({
        id,
        positionMs: Math.max(0, Math.round(positionMs)),
        durationMs: Math.max(0, Math.round(durationMs)),
        at: Date.now(),
      }),
    );
    void this.sendProgress();
  }

  /** Applies new settings: a transfer pauses when Wi-Fi Only now forbids it. */
  setSettings(settings: DownloadSettings): void {
    this.#snapshot = { ...this.#snapshot, settings };
    this.#notify();
    this.#reconsider();
  }

  /** Applies a network change: transfers pause off Wi-Fi under Wi-Fi Only, and resume on it. */
  setNetwork(network: NetworkNow): void {
    this.#snapshot = { ...this.#snapshot, network };
    this.#notify();
    this.#reconsider();

    if (!network.connected) return;
    void this.sendProgress();
    const listed = this.#list?.getSnapshot();

    if (listed?.status === "error") listed.retry();
  }

  /** The kept video of `download`, or null before it is ready. */
  videoUri(download: DownloadRecord): string | null {
    if (download.phase !== "ready" || download.delivery === null) return null;

    return new File(this.#itemDirectory(download.id), videoFile(download.delivery.container)).uri;
  }

  /** The kept WebVTT file of a subtitle track. */
  subtitleUri(download: DownloadRecord, trackId: string): string {
    return new File(this.#itemDirectory(download.id), subtitleFile(trackId)).uri;
  }

  /** The kept picture of `download`, or null when there is none yet. */
  artworkUri(download: DownloadRecord): string | null {
    const known = this.#artwork.get(download.id);

    if (known !== undefined) return known;
    const file = new File(this.#itemDirectory(download.id), ARTWORK_FILE);
    const uri = file.exists ? file.uri : null;

    this.#artwork.set(download.id, uri);

    return uri;
  }

  /**
   * Sends the progress played offline with `movies.play.reportOffline`; what the server took or
   * refused for good leaves the queue.
   */
  async sendProgress(): Promise<void> {
    const pending = this.#snapshot.store.pendingProgress;

    if (!this.#started || this.#sending || pending.length === 0) return;

    if (!this.#snapshot.network.connected) return;
    this.#sending = true;

    try {
      const sent = await this.#sendFrom(pending, []);

      if (sent.length > 0) this.#dispatch(DownloadEvent.ProgressSent({ sent }));
    } finally {
      this.#sending = false;
    }
  }

  async #sendFrom(
    pending: ReadonlyArray<PendingProgress>,
    sent: ReadonlyArray<PendingProgress>,
  ): Promise<ReadonlyArray<PendingProgress>> {
    const [entry, ...rest] = pending;

    if (entry === undefined) return sent;

    const result = await attempt(() =>
      this.#platform.movies.play.reportOffline({
        fileId: entry.fileId,
        positionMs: entry.positionMs,
        durationMs: entry.durationMs,
        playedAt: entry.playedAt,
        sentAt: Date.now(),
      }),
    );

    if (Result.isFailure(result) && Predicate.isTagged(result.failure, "TransportError"))
      return sent;

    const taken =
      Result.isSuccess(result) ||
      Predicate.isTagged(result.failure, "NotFound") ||
      Predicate.isTagged(result.failure, "Forbidden") ||
      Predicate.isTagged(result.failure, "InvalidArgs");

    return this.#sendFrom(rest, taken ? [...sent, entry] : sent);
  }

  /**
   * Follows the first page of the core's list, which Convex sends again whenever what it decides
   * changes, such as a revoked grant; every change reads the whole list and follows it.
   */
  #followList(): void {
    const list = this.#platform.core.downloads.list.watch({
      paginationOpts: { numItems: LIST_PAGE_SIZE, cursor: null },
    });

    this.#list = list;
    this.#unfollowList = list.subscribe(() => {
      const state = list.getSnapshot();

      if (state.status === "success") void this.#sync(state.data);
    });
  }

  /** Follows `first` and the pages after it; a list that changes meanwhile is followed after. */
  async #sync(first: ListPage): Promise<void> {
    if (this.#syncing) {
      this.#syncNext = first;

      return;
    }

    this.#syncing = true;

    try {
      await this.#syncFrom(first);
    } finally {
      this.#syncing = false;
    }

    const next = this.#syncNext;

    this.#syncNext = null;

    if (next !== null && !this.#disposed) await this.#sync(next);
  }

  /** Reads every page after `first`, then follows the whole list; a page that fails changes nothing. */
  async #syncFrom(first: ListPage): Promise<void> {
    const settled = new Set(this.#settled);
    const rows = await this.#rowsAfter(first, first.page);

    if (rows === null || this.#disposed) return;

    const listed = rows.flatMap(listedOf);

    for (const entry of listed) this.#settled.add(entry.id);
    this.#follow(planSync(this.#snapshot.store, listed, settled));
  }

  /** `rows` and the rows of every page after `page`, read in order; null when a page fails. */
  async #rowsAfter(
    page: ListPage,
    rows: ReadonlyArray<ListRow>,
  ): Promise<ReadonlyArray<ListRow> | null> {
    if (page.isDone) return rows;

    const cursor = page.continueCursor;

    const read = await attempt(() =>
      this.#platform.core.downloads.list({
        paginationOpts: { numItems: LIST_PAGE_SIZE, cursor },
      }),
    );

    if (Result.isFailure(read) || this.#disposed) return null;

    return this.#rowsAfter(read.success, [...rows, ...read.success.page]);
  }

  #follow(plan: SyncPlan): void {
    for (const id of plan.expire) this.#expire(id);

    for (const id of plan.refresh) {
      this.#deleteFiles(id);
      this.#dispatch(DownloadEvent.Refreshed({ id }));
    }

    for (const id of plan.drop) this.#drop(id);

    for (const id of plan.purge) this.#discard(id);

    for (const id of plan.forget) void this.#forget(id);

    this.#pump();
  }

  /** The person may no longer keep `id` here: its copy goes, and it shows as expired. */
  #expire(id: string): void {
    this.#stop(id);
    this.#deleteFiles(id);
    this.#dispatch(DownloadEvent.Expired({ id }));
  }

  /** The file or its library is gone: the copy and the core's row go. */
  #drop(id: FileId): void {
    this.#discard(id);
    void this.#forget(id);
  }

  /** Stops a download, deletes its files, and forgets it here. */
  #discard(id: string): void {
    this.#stop(id);
    this.#deleteFiles(id);
    this.#dispatch(DownloadEvent.Removed({ id }));
  }

  async #forget(id: FileId): Promise<void> {
    this.#settled.delete(id);
    await attempt(() => this.#platform.core.downloads.remove({ item: itemOf(id) }));
  }

  #stop(id: string): void {
    const active = this.#active.get(id);

    if (active === undefined) return;
    active.cancelled = true;
    active.task?.cancel();
  }

  #find(id: string): DownloadRecord | undefined {
    return this.#snapshot.store.downloads.find((download) => download.id === id);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #dispatch(event: DownloadEvent, save: "now" | "soon" = "now"): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#snapshot, store: reduce(this.#snapshot.store, event) };

    if (save === "now") {
      this.#notify();
      this.#save();
    } else {
      this.#showTimer ??= setTimeout(() => {
        this.#showTimer = undefined;
        this.#notify();
      }, SHOW_EVERY_MS);
      this.#saveTimer ??= setTimeout(() => this.#save(), SAVE_EVERY_MS);
    }
  }

  #readStore(): string | null {
    try {
      const file = new File(this.#options.folder, STORE_FILE);

      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  }

  #save(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;

    try {
      this.#options.folder.create({ intermediates: true, idempotent: true });
      new File(this.#options.folder, STORE_FILE).writeSync(serializeStore(this.#snapshot.store));
    } catch {}
  }

  #itemDirectory(id: string): Directory {
    return new Directory(this.#options.folder, itemFolder(id));
  }

  #deleteFiles(id: string): void {
    this.#artwork.delete(id);

    try {
      const directory = this.#itemDirectory(id);

      if (directory.exists) directory.delete();
    } catch {}
  }

  #reconsider(): void {
    const { network, settings } = this.#snapshot;

    if (this.#active.size > 0 && !mayTransfer(network, settings.wifiOnly)) {
      const wifi = network.connected && settings.wifiOnly;

      for (const active of this.#active.values()) void this.#pauseForNetwork(active, wifi);

      return;
    }

    this.#pump();
  }

  async #pauseForNetwork(active: Active, wifi: boolean): Promise<void> {
    const task = active.task;

    if (active.pausing) return;
    active.pausing = true;

    if (task === null) {
      const waiting = this.#find(active.id);

      this.#dispatch(
        DownloadEvent.Waiting({ id: active.id, wifi, resume: waiting?.resume ?? null }),
      );

      return;
    }

    const resume = await pauseKeeping(task);

    this.#dispatch(DownloadEvent.Waiting({ id: active.id, wifi, resume }));
  }

  #pump(): void {
    if (!this.#started || this.#active.size >= MAX_RUNS || this.#disposed) return;
    const { store, network, settings } = this.#snapshot;
    const next = nextToRun(store, new Set(this.#active.keys()));

    if (next === null) return;

    if (!mayTransfer(network, settings.wifiOnly)) {
      if (network.connected && settings.wifiOnly) {
        for (const download of store.downloads) {
          if (download.phase === "queued") {
            this.#dispatch(
              DownloadEvent.Waiting({ id: download.id, wifi: true, resume: download.resume }),
            );
          }
        }
      }

      return;
    }

    const active: Active = { id: next.id, task: null, cancelled: false, pausing: false };

    this.#active.set(next.id, active);
    void this.#run(next, active)
      .catch(() => undefined)
      .finally(() => {
        if (this.#active.get(next.id) === active) this.#active.delete(next.id);

        const left = this.#find(next.id);

        if (left?.phase === "queued" && !active.cancelled) {
          this.#dispatch(
            DownloadEvent.Interrupted({ id: next.id, error: SERVER_UNAVAILABLE, resume: null }),
          );
        }

        this.#pump();
      });

    this.#pump();
  }

  #stopped(active: Active): boolean {
    return active.cancelled || active.pausing || this.#disposed;
  }

  #interrupt(active: Active, message: string): void {
    if (active.cancelled) return;
    this.#dispatch(DownloadEvent.Interrupted({ id: active.id, error: message, resume: null }));
  }

  /** Has the core keep the download on this device, at the person's download quality here. */
  async #confirm(download: DownloadRecord, active: Active): Promise<boolean> {
    if (this.#find(download.id)?.added ?? download.added) return true;

    const added = await attempt(() =>
      this.#platform.core.downloads.add({ item: itemOf(download.id) }),
    );

    if (this.#stopped(active)) return false;

    if (Result.isFailure(added)) {
      this.#interrupt(active, failureLine(added.failure));

      return false;
    }

    this.#dispatch(DownloadEvent.Confirmed({ id: download.id }));

    return true;
  }

  /** The file and episode the player needs offline, which `movies.play.start` describes once. */
  async #describe(download: DownloadRecord, active: Active): Promise<KeptPlayback | null> {
    const known = this.#find(download.id)?.playback ?? null;

    if (known !== null) return known;

    const start = await attempt(() =>
      this.#platform.movies.play.start({
        titleId: download.titleId,
        fileId: download.id,
        ...Option.match(Option.fromNullishOr(download.episodeId), {
          onNone: () => ({}),
          onSome: (episodeId) => ({ episodeId }),
        }),
      }),
    );

    if (this.#stopped(active)) return null;

    if (Result.isFailure(start)) {
      this.#interrupt(active, failureLine(start.failure));

      return null;
    }

    const playback = Option.getOrNull(keptPlaybackOf(start.success));

    if (playback === null) {
      this.#interrupt(active, DOWNLOAD_STOPPED);

      return null;
    }

    this.#dispatch(DownloadEvent.Described({ id: download.id, playback }));

    return playback;
  }

  /**
   * A ticket for the file's current revision. A download the person may no longer keep expires,
   * and one whose file is gone is removed; both answer null.
   */
  async #ticket(download: DownloadRecord, active: Active): Promise<Ticket | null> {
    const fetched = await attempt(() =>
      this.#platform.core.downloads.fetch({ item: itemOf(download.id) }),
    );

    if (this.#stopped(active)) return null;

    if (Result.isFailure(fetched)) {
      this.#interrupt(active, failureLine(fetched.failure));

      return null;
    }

    const answer = fetched.success;

    if (answer.state === "available") return answer;

    if (answer.state === "expired") this.#expire(download.id);
    else this.#drop(download.id);

    return null;
  }

  async #prepare(
    download: DownloadRecord,
    playback: KeptPlayback,
    active: Active,
    state: Preparation,
  ): Promise<{ readonly ticket: Ticket; readonly ready: DownloadReady } | null> {
    if (this.#stopped(active)) return null;

    const ticket =
      state.ticket !== null && state.ticket.expiresAt - Date.now() > TICKET_MARGIN_MS
        ? state.ticket
        : await this.#ticket(download, active);

    if (ticket === null) return null;

    const answer = await prepareDownload(
      startedOf(download, playback, ticket, this.#options.mediaUrl),
      ticket.quality,
    );

    if (this.#stopped(active)) return null;

    if (Result.isFailure(answer)) {
      const step = afterDownloadFailure(answer.failure);

      if (DownloadStep.$is("Interrupt")(step) || state.restarts >= MAX_RESTARTS) {
        this.#interrupt(
          active,
          DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE,
        );

        return null;
      }

      if (DownloadStep.$is("Refetch")(step)) {
        return this.#prepare(download, playback, active, {
          ticket: null,
          restarts: state.restarts + 1,
        });
      }

      await sleep(BUSY_RETRY_MS);

      return this.#prepare(download, playback, active, state);
    }

    const response = answer.success;

    if (Predicate.isTagged(response, "Ready")) return { ticket, ready: response };

    const received = this.#find(download.id)?.receivedBytes ?? 0;

    if (spaceShortfall(response.estimatedBytes - received, freeSpace()) > 0) {
      this.#dispatch(
        DownloadEvent.NoSpace({ id: download.id, totalBytes: response.estimatedBytes }),
      );

      return null;
    }

    this.#dispatch(
      DownloadEvent.Preparing({
        id: download.id,
        progress: response.progress,
        estimatedBytes: response.estimatedBytes,
      }),
    );
    await sleep(PREPARE_EVERY_MS);

    return this.#prepare(download, playback, active, { ticket, restarts: state.restarts });
  }

  async #keepCompanions(
    download: DownloadRecord,
    ready: DownloadReady,
    directory: Directory,
  ): Promise<ReadonlySet<string>> {
    const kept = await Promise.all(
      ready.subtitles.map(async (subtitle) => {
        try {
          await File.downloadFileAsync(
            subtitle.url,
            new File(directory, subtitleFile(subtitle.id)),
            {
              idempotent: true,
            },
          );

          return subtitle.id;
        } catch {
          return null;
        }
      }),
    );

    const picture = artworkUrl(this.#options.mediaUrl, pictureOf(download), "card");

    if (picture !== undefined) {
      await File.downloadFileAsync(picture, new File(directory, ARTWORK_FILE), {
        idempotent: true,
      }).catch(() => null);
    }

    return new Set(kept.filter(Predicate.isNotNull));
  }

  /**
   * Resumes a paused transfer while the ticket in its URL still works, and answers whether that
   * settled the download. iOS keeps the URL inside the resume data, so a transfer whose ticket
   * expired starts over with a new one.
   */
  async #resumed(download: DownloadRecord, active: Active): Promise<boolean> {
    if (download.resume === null) return false;

    const expiresAt = download.ticketExpiresAt ?? 0;
    const saved = Date.now() < expiresAt ? this.#restore(download.id, download.resume) : null;

    if (saved !== null) {
      const resumed = await this.#transfer(download.id, active, saved, "resume");

      if (resumed !== "failed" || this.#stopped(active)) return true;
    }

    this.#dispatch(DownloadEvent.Waiting({ id: download.id, wifi: false, resume: null }));

    return false;
  }

  async #run(queued: DownloadRecord, active: Active): Promise<void> {
    if (!(await this.#confirm(queued, active))) return;

    const playback = await this.#describe(queued, active);

    if (playback === null || this.#stopped(active)) return;

    if (await this.#resumed(this.#find(queued.id) ?? queued, active)) return;

    const prepared = await this.#prepare(queued, playback, active, { ticket: null, restarts: 0 });

    if (prepared === null) return;

    const { ticket, ready } = prepared;

    if (spaceShortfall(ready.sizeBytes, freeSpace()) > 0) {
      this.#dispatch(DownloadEvent.NoSpace({ id: queued.id, totalBytes: ready.sizeBytes }));

      return;
    }

    const directory = this.#itemDirectory(queued.id);

    try {
      directory.create({ intermediates: true, idempotent: true });
    } catch {
      this.#interrupt(active, "This iPhone couldn't save the download.");

      return;
    }

    const kept = await this.#keepCompanions(this.#find(queued.id) ?? queued, ready, directory);

    this.#artwork.delete(queued.id);

    if (this.#stopped(active)) return;

    this.#dispatch(
      DownloadEvent.Delivering({
        id: queued.id,
        delivery: deliveryOf(ready, kept),
        revision: ticket.revision,
        ticketExpiresAt: ticket.expiresAt,
      }),
    );

    const destination = new File(directory, videoFile(ready.container === "mov" ? "mov" : "mp4"));

    const outcome = await this.#transfer(
      queued.id,
      active,
      File.createDownloadTask(ready.url, destination, {
        onProgress: this.#progressOf(queued.id),
      }),
      "start",
    );

    if (outcome === "failed" && !this.#stopped(active)) {
      this.#interrupt(active, SERVER_UNAVAILABLE);
    }
  }

  #restore(id: string, resume: string): DownloadTask | null {
    const state = resumeState(resume);

    if (state === null) return null;

    try {
      return DownloadTask.fromSavable(state, { onProgress: this.#progressOf(id) });
    } catch {
      return null;
    }
  }

  #progressOf(id: string): (progress: { readonly bytesWritten: number | bigint }) => void {
    return ({ bytesWritten }) =>
      this.#dispatch(DownloadEvent.Received({ id, bytes: byteCount(bytesWritten) }), "soon");
  }

  async #transfer(
    id: string,
    active: Active,
    task: DownloadTask,
    how: "start" | "resume",
  ): Promise<"done" | "stopped" | "failed"> {
    active.task = task;
    const unwatch = this.#watchStall(id, active, task);

    try {
      const file = await (how === "resume" ? task.resumeAsync() : task.downloadAsync());

      if (this.#stopped(active)) return "stopped";

      if (file === null) return "failed";

      this.#dispatch(DownloadEvent.Finished({ id }));

      return "done";
    } catch {
      return this.#stopped(active) ? "stopped" : "failed";
    } finally {
      unwatch();
      active.task = null;

      if (!active.pausing) task.release();
    }
  }

  /**
   * Watches a transfer for a server that went away. An iOS background transfer waits for its
   * server instead of failing, so one without progress for a while asks the media service whether
   * it answers; when it does not, the transfer pauses (keeping its resume data) and the download
   * is interrupted (H19). Returns the function that stops watching.
   */
  #watchStall(id: string, active: Active, task: DownloadTask): () => void {
    let lastBytes = -1;
    let since = Date.now();

    const timer = setInterval(() => {
      const bytes = this.#find(id)?.receivedBytes ?? 0;

      if (bytes !== lastBytes) {
        lastBytes = bytes;
        since = Date.now();

        return;
      }

      if (Date.now() - since < STALL_AFTER_MS || this.#stopped(active)) return;
      since = Date.now();

      void this.#reachable().then((reachable) =>
        reachable ? undefined : this.#pauseStalled(id, active, task),
      );
    }, STALL_CHECK_MS);

    return () => clearInterval(timer);
  }

  async #reachable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.#options.mediaUrl}/api/health`, {
        signal: controller.signal,
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async #pauseStalled(id: string, active: Active, task: DownloadTask): Promise<void> {
    if (this.#stopped(active)) return;
    active.pausing = true;

    const resume = await pauseKeeping(task);

    this.#dispatch(DownloadEvent.Interrupted({ id, error: SERVER_UNAVAILABLE, resume }));
  }
}

const pauseKeeping = async (task: DownloadTask): Promise<string | null> => {
  try {
    await task.pauseAsync();

    return JSON.stringify(task.savable());
  } catch {
    task.cancel();

    return null;
  } finally {
    task.release();
  }
};

const resumeState = (text: string): DownloadPauseState | null =>
  Option.getOrNull(decodePauseState(text));
