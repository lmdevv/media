import type { PrepareDownloadResponse } from "@media/contracts/media-playback";
import type { StartedPlayback } from "@media/contracts/models/playback";
import type { DeviceId } from "@media/contracts/ids";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import type { CallError, Movies, PlaybackCallError } from "@media/sdk/effect";
import { Downloads, MoviesClient } from "@media/sdk/effect";
import type { useMoviesRuntime } from "@media/sdk/react";
import { Effect, Exit, Option, Predicate, Result, Schema } from "effect";
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
import { DownloadStep, SERVER_UNAVAILABLE, afterDownloadFailure } from "@/lib/downloads/failures";
import {
  DownloadEvent,
  mayTransfer,
  nextToRun,
  parseStore,
  reduce,
  serializeStore,
  spaceShortfall,
} from "@/lib/downloads/model";
import type {
  Delivery,
  DownloadRecord,
  DownloadStore,
  NetworkNow,
  NewDownload,
  PendingProgress,
} from "@/lib/downloads/model";
import type { DownloadSettings } from "@/lib/downloads/settings";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";

type Runtime = ReturnType<typeof useMoviesRuntime>;

type DownloadReady = Extract<PrepareDownloadResponse, { readonly _tag: "Ready" }>;

/** Everything the screens read. */
export interface DownloadsSnapshot {
  readonly store: DownloadStore;
  readonly settings: DownloadSettings;
  readonly network: NetworkNow;
}

/** Where an engine keeps its files and who it downloads for. */
export interface EngineOptions {
  /** The account's folder, `downloads/<server>/<account>` under the documents folder. */
  readonly folder: Directory;
  readonly mediaUrl: string;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly settings: DownloadSettings;
}

const PREPARE_EVERY_MS = 3_000;

const BUSY_RETRY_MS = 10_000;

const STALL_AFTER_MS = 20_000;

const STALL_CHECK_MS = 5_000;

const HEALTH_TIMEOUT_MS = 5_000;

const RENEW_BEFORE_MS = 30 * 60 * 1000;

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

interface Active {
  readonly id: string;
  task: DownloadTask | null;
  sessionId: StartedPlayback["sessionId"] | null;
  cancelled: boolean;
  /** Paused for Wi-Fi Only: the task's own promise resolves with null. */
  pausing: boolean;
}

interface Preparation {
  readonly started: StartedPlayback | null;
  readonly renew: boolean;
  readonly restarts: number;
}

const deliveryOf = (
  ready: DownloadReady,
  started: StartedPlayback,
  kept: ReadonlySet<string>,
): Delivery => ({
  fileId: started.file.id,
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

/** Keeps and downloads one account's downloads. Create it, then `dispose` it. */
export class DownloadEngine {
  readonly #runtime: Runtime;
  readonly #options: EngineOptions;
  readonly #listeners = new Set<() => void>();
  #snapshot: DownloadsSnapshot;
  readonly #active = new Map<string, Active>();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #artwork = new Map<string, string | null>();
  #sending = false;
  #started = false;
  #disposed = false;

  constructor(runtime: Runtime, options: EngineOptions) {
    this.#runtime = runtime;
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
   * Starts working, once the account is confirmed signed in here: the first download in line, and
   * any progress waiting for the server. Until then the engine only shows what is kept.
   */
  start(): void {
    this.#started = true;
    this.#pump();
    void this.sendProgress();
  }

  /** Stops every transfer for good, keeping what was saved; the engine does nothing after. */
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#showTimer);
    this.#save();

    for (const active of this.#active.values()) active.task?.cancel();
  }

  /** Queues a download; one already kept for the same item stays as it is. */
  add(download: NewDownload): void {
    this.#dispatch(DownloadEvent.Added({ download, at: Date.now() }));
    this.#pump();
  }

  /** Queues an interrupted or stopped download again (Retry Download). */
  retry(id: string): void {
    this.#dispatch(DownloadEvent.Retried({ id }));
    this.#pump();
  }

  /** Cancels a download or removes a kept one, deleting its files (Remove, Cancel Download). */
  async remove(id: string): Promise<void> {
    const active = this.#active.get(id);

    if (active !== undefined) {
      active.cancelled = true;
      active.task?.cancel();
      this.#endSession(active.sessionId);
    }

    this.#deleteFiles(id);
    this.#dispatch(DownloadEvent.Removed({ id }));
    await Promise.resolve();
    this.#pump();
  }

  /** Removes every download of one profile (Remove All Downloads). */
  async removeAll(profileId: DownloadRecord["profileId"]): Promise<void> {
    const ids = this.#snapshot.store.downloads
      .filter((download) => download.profileId === profileId)
      .map((download) => download.id);

    await Promise.all(ids.map((id) => this.remove(id)));
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

    if (network.connected) void this.sendProgress();
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

  /** Sends the progress played offline; what the server took or refused for good leaves the queue. */
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

    const result = await this.#runSdk(
      Effect.flatMap(MoviesClient.MoviesClient, (client) =>
        client.mutate("downloads.recordProgress", {
          profileId: entry.profileId,
          titleId: entry.titleId,
          fileId: entry.fileId,
          positionMs: Milliseconds.make(entry.positionMs),
          durationMs: Milliseconds.make(entry.durationMs),
          playedAt: EpochMillis.make(entry.playedAt),
          sentAt: EpochMillis.make(Date.now()),
          ...Option.match(Option.fromNullishOr(entry.episodeId), {
            onNone: () => ({}),
            onSome: (episodeId) => ({ episodeId }),
          }),
        }),
      ),
    );

    if (result === null || (Result.isFailure(result) && isUnreachable(result.failure))) return sent;

    const taken = Result.isSuccess(result) || isFinal(result.failure);

    return this.#sendFrom(rest, taken ? [...sent, entry] : sent);
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

  async #runSdk<A, E>(
    effect: Effect.Effect<A, E, Movies.Services>,
  ): Promise<Result.Result<A, E> | null> {
    const exit = await this.#runtime.runPromiseExit(Effect.result(effect));

    return Exit.isSuccess(exit) ? exit.value : null;
  }

  #endSession(sessionId: StartedPlayback["sessionId"] | null): void {
    if (sessionId === null) return;

    void this.#runSdk(
      Effect.flatMap(MoviesClient.MoviesClient, (client) =>
        client.mutate("downloads.end", { sessionId }),
      ),
    );
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
      this.#endSession(active.sessionId);
      const waiting = this.#snapshot.store.downloads.find((download) => download.id === active.id);

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

    const active: Active = {
      id: next.id,
      task: null,
      sessionId: null,
      cancelled: false,
      pausing: false,
    };

    this.#active.set(next.id, active);
    void this.#run(next, active)
      .catch(() => undefined)
      .finally(() => {
        if (this.#active.get(next.id) === active) this.#active.delete(next.id);

        const left = this.#snapshot.store.downloads.find((download) => download.id === next.id);

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
    this.#endSession(active.sessionId);
    this.#dispatch(DownloadEvent.Interrupted({ id: active.id, error: message, resume: null }));
  }

  async #openSession(download: DownloadRecord, active: Active): Promise<StartedPlayback | null> {
    const opened = await this.#runSdk(
      Downloads.start({
        profileId: download.profileId,
        deviceId: this.#options.deviceId,
        deviceName: Option.some(this.#options.deviceName),
        titleId: download.titleId,
        episodeId: Option.fromNullishOr(download.episodeId),
        fileId: Option.fromNullishOr(download.fileId),
        capabilities: IOS_CAPABILITIES,
      }),
    );

    if (opened === null || Result.isFailure(opened)) {
      this.#interrupt(active, opened === null ? SERVER_UNAVAILABLE : failureLine(opened.failure));

      return null;
    }

    active.sessionId = opened.success.sessionId;
    this.#dispatch(
      DownloadEvent.SessionStarted({ id: download.id, sessionId: opened.success.sessionId }),
    );

    if (this.#stopped(active)) {
      this.#endSession(opened.success.sessionId);

      return null;
    }

    return opened.success;
  }

  async #renewed(started: StartedPlayback): Promise<StartedPlayback> {
    const renewed = await this.#runSdk(Downloads.renew(started));

    return renewed !== null && Result.isSuccess(renewed) ? renewed.success : started;
  }

  async #prepare(
    download: DownloadRecord,
    active: Active,
    state: Preparation,
  ): Promise<{ readonly started: StartedPlayback; readonly ready: DownloadReady } | null> {
    if (this.#stopped(active)) return null;
    const opened = state.started ?? (await this.#openSession(download, active));

    if (opened === null) return null;

    const started =
      state.renew || opened.tokenExpiresAt - Date.now() < RENEW_BEFORE_MS
        ? await this.#renewed(opened)
        : opened;

    const answer = await this.#runSdk(
      Downloads.prepare(started, IOS_CAPABILITIES, download.quality, Option.none()),
    );

    if (this.#stopped(active)) return null;

    if (answer === null || Result.isFailure(answer)) {
      const step =
        answer === null
          ? DownloadStep.Interrupt({ message: SERVER_UNAVAILABLE })
          : afterDownloadFailure(answer.failure);

      if (DownloadStep.$is("Interrupt")(step) || state.restarts >= MAX_RESTARTS) {
        this.#interrupt(
          active,
          DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE,
        );

        return null;
      }

      const restarts = state.restarts + 1;

      if (DownloadStep.$is("Restart")(step)) {
        return this.#prepare(download, active, { started: null, renew: false, restarts });
      }

      if (DownloadStep.$is("Renew")(step)) {
        return this.#prepare(download, active, { started, renew: true, restarts });
      }

      await sleep(BUSY_RETRY_MS);

      return this.#prepare(download, active, { started, renew: false, restarts: state.restarts });
    }

    const response = answer.success;

    if (Predicate.isTagged(response, "Ready")) return { started, ready: response };

    if (
      spaceShortfall(response.estimatedBytes - download.receivedBytes, Paths.availableDiskSpace) > 0
    ) {
      this.#endSession(started.sessionId);
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

    return this.#prepare(download, active, { started, renew: false, restarts: state.restarts });
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

    const picture = artworkUrl(this.#options.mediaUrl, download.artwork, "card");

    if (picture !== undefined) {
      await File.downloadFileAsync(picture, new File(directory, ARTWORK_FILE), {
        idempotent: true,
      }).catch(() => null);
    }

    return new Set(kept.filter(Predicate.isNotNull));
  }

  async #run(download: DownloadRecord, active: Active): Promise<void> {
    const saved = download.resume === null ? null : this.#restore(download.id, download.resume);

    if (saved !== null && download.sessionId !== null) {
      active.sessionId = download.sessionId;
      const resumed = await this.#transfer(download.id, active, saved, "resume");

      if (resumed !== "failed" || this.#stopped(active)) return;

      this.#endSession(download.sessionId);
      this.#dispatch(DownloadEvent.Waiting({ id: download.id, wifi: false, resume: null }));
    } else {
      this.#endSession(download.sessionId);
    }

    const prepared = await this.#prepare(download, active, {
      started: null,
      renew: false,
      restarts: 0,
    });

    if (prepared === null) return;

    const { started, ready } = prepared;

    if (spaceShortfall(ready.sizeBytes, Paths.availableDiskSpace) > 0) {
      this.#endSession(started.sessionId);
      this.#dispatch(DownloadEvent.NoSpace({ id: download.id, totalBytes: ready.sizeBytes }));

      return;
    }

    const directory = this.#itemDirectory(download.id);

    try {
      directory.create({ intermediates: true, idempotent: true });
    } catch {
      this.#interrupt(active, "This iPhone couldn't save the download.");

      return;
    }

    const kept = await this.#keepCompanions(download, ready, directory);

    this.#artwork.delete(download.id);

    if (this.#stopped(active)) {
      if (!this.#disposed) this.#endSession(started.sessionId);

      return;
    }

    this.#dispatch(
      DownloadEvent.Delivering({
        id: download.id,
        delivery: deliveryOf(ready, started, kept),
        playback: {
          episode: started.episode,
          file: started.file,
          resumePositionMs: started.resumePositionMs,
        },
        sessionId: started.sessionId,
      }),
    );

    const destination = new File(directory, videoFile(ready.container === "mov" ? "mov" : "mp4"));

    const outcome = await this.#transfer(
      download.id,
      active,
      File.createDownloadTask(ready.url, destination, {
        onProgress: this.#progressOf(download.id),
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

  #progressOf(id: string): (progress: { readonly bytesWritten: number }) => void {
    return ({ bytesWritten }) =>
      this.#dispatch(DownloadEvent.Received({ id, bytes: bytesWritten }), "soon");
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
      this.#endSession(active.sessionId);

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
      const bytes =
        this.#snapshot.store.downloads.find((download) => download.id === id)?.receivedBytes ?? 0;

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

    if (resume === null) this.#endSession(active.sessionId);
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

const isUnreachable = (failure: CallError): boolean =>
  Predicate.isTagged(failure, "TransportError");

const isFinal = (failure: CallError): boolean =>
  Predicate.isTagged(failure, "NotFound") ||
  Predicate.isTagged(failure, "Forbidden") ||
  Predicate.isTagged(failure, "InvalidArgs");

const failureLine = (failure: CallError | PlaybackCallError): string => {
  const step = afterDownloadFailure(failure);

  return DownloadStep.$is("Interrupt")(step) ? step.message : SERVER_UNAVAILABLE;
};
