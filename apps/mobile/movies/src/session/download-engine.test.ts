import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Conflict, Internal } from "@media/contracts/errors";
import type { PlatformSdk } from "@media/sdk/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asMediaFileId, asTitleId } from "@/lib/catalog";
import {
  DOWNLOADS_FOLDER,
  RECORD_FILE,
  STORE_FILE,
  UNREADABLE_STORE_FILE,
  accountFolder,
  itemPath,
  removalFolder,
  videoFile,
} from "@/lib/downloads/files";
import type { DownloadDisk } from "@/lib/downloads/disk";
import { DownloadEvent, EMPTY_STORE, reduce, serializeStore } from "@/lib/downloads/model";
import type { Delivery, DownloadStore, FileId, NewDownload } from "@/lib/downloads/model";
import { NodeDisk, NodeRoot } from "@/lib/downloads/node-disk";
import { markSignedOut, prepareDownloads } from "@/lib/downloads/storage";

import { DownloadEngine } from "./download-engine";
import type { EnginePlatform } from "./download-engine";
import { readyMediaService } from "./ready-media-service";

type ListPage = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["list"]>>;

type Started = Awaited<ReturnType<EnginePlatform["movies"]["play"]["start"]>>;

/** What `movies.play.start` describes for a movie's file, as the core answers it. */
const startedMovie = (id: FileId): Started => ({
  titleId: asTitleId(`title-${id}`),
  episodeId: null,
  episode: null,
  file: {
    id,
    titleId: asTitleId(`title-${id}`),
    episodeId: null,
    versionName: null,
    sizeBytes: 1_000,
    probe: {
      container: "mp4",
      durationMs: 600_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
      chapters: [],
    },
    externalSubtitles: [],
    hdr: false,
    trickplay: null,
  },
  resumePositionMs: 0,
  playbackId: "playback-1",
  startedAt: 0,
  ticket: "playback-ticket",
  expiresAt: Date.now() + 3_600_000,
});

/** The core as the engine calls it: a list of what this device keeps, and the calls it records. */
class FakeCore implements EnginePlatform {
  readonly calls: Array<string> = [];
  /** Whether it describes files and hands out tickets, as a core serving downloads does. */
  serves = false;
  /** Whether it can be reached; one out of reach refuses every remove. */
  online = true;
  /** What it answers every remove with once it refuses them for good; null takes them. */
  refusal: Error | null = null;
  #page: ListPage = { page: [], isDone: true, continueCursor: "" };
  readonly #listeners = new Set<() => void>();

  /** Lists `ids` as kept on this device at revision `r1`, and tells the engine. */
  lists(ids: ReadonlyArray<FileId>): void {
    this.states(
      ids.map((id) => ({
        item: { kind: "file", id },
        state: "available",
        revision: "r1",
        quality: "standard",
        bytes: 1,
        label: id,
      })),
    );
  }

  /** Lists `page` as what this device keeps, and tells the engine. */
  states(page: ListPage["page"]): void {
    this.#page = { page, isDone: true, continueCursor: "" };

    for (const listener of this.#listeners) listener();
  }

  /** The files the core lists for this device, and so counts against its space. */
  listing(): ReadonlyArray<string> {
    return this.#page.page.map((row) => row.item.id);
  }

  readonly core: EnginePlatform["core"] = {
    downloads: {
      list: Object.assign(() => Promise.resolve(this.#page), {
        watch: () => ({
          subscribe: (onChange: () => void) => {
            this.#listeners.add(onChange);

            return () => {
              this.#listeners.delete(onChange);
            };
          },
          getSnapshot: () => ({ status: "success", data: this.#page }) as const,
        }),
        preload: () => Promise.resolve(),
      }),
      add: ({ item }) => {
        this.calls.push(`add:${item.id}`);

        return Promise.resolve(null);
      },
      remove: ({ item }) => {
        this.calls.push(`remove:${item.id}`);

        if (!this.online) return Promise.reject(new Error("The core is out of reach."));

        if (this.refusal !== null) return Promise.reject(this.refusal);

        if (this.#page.page.some((row) => row.item.id === item.id)) {
          this.states(this.#page.page.filter((row) => row.item.id !== item.id));
        }

        return Promise.resolve(null);
      },
      fetch: ({ item }) =>
        this.serves
          ? Promise.resolve({
              state: "available",
              revision: "r1",
              quality: "standard",
              bytes: 900_000,
              resource: { kind: item.kind, id: item.id },
              ticket: "download-ticket",
              expiresAt: Date.now() + 3_600_000,
            } as const)
          : Promise.reject(new Error("This core fetches no ticket.")),
    },
  };

  readonly movies: EnginePlatform["movies"] = {
    play: {
      start: ({ fileId }) =>
        this.serves && fileId !== undefined
          ? Promise.resolve(startedMovie(fileId))
          : Promise.reject(new Error("This core starts no playback.")),
      reportOffline: () => Promise.resolve({ applied: true, watched: false }),
    },
  };
}

const dune = asMediaFileId("file-dune");

const arrival = asMediaFileId("file-arrival");

const stranger = asMediaFileId("file-stranger");

const delivery: Delivery = {
  sizeBytes: 12,
  container: "mp4",
  durationMs: 9_960_000,
  videoCodec: "h264",
  width: 1280,
  height: 720,
  audio: null,
  subtitles: [],
};

const newDownload = (id: FileId): NewDownload => ({
  id,
  titleId: asTitleId(`title-${id}`),
  episodeId: null,
  titleName: id,
  runtimeMs: 9_960_000,
  artwork: null,
});

/** A store holding `ids` downloaded and ready to play, as an earlier run saved it. */
const readyStore = (ids: ReadonlyArray<FileId>): DownloadStore =>
  ids.reduce(
    (store, id, index) =>
      [
        DownloadEvent.Added({ download: newDownload(id), at: index + 1 }),
        DownloadEvent.Confirmed({ id }),
        DownloadEvent.Delivering({ id, delivery, revision: "r1", ticketExpiresAt: 0 }),
        DownloadEvent.Finished({ id }),
      ].reduce(reduce, store),
    EMPTY_STORE,
  );

/** An index of `dune` and `arrival`, ready, whose `dune` row has a phase this version does not know. */
const withUnknownPhase = (): string => {
  const [first, ...rest] = readyStore([dune, arrival]).downloads;

  return JSON.stringify({
    downloads: [Object.assign({}, first, { phase: "future-phase" }), ...rest],
    pendingProgress: [],
  });
};

/** The index main's app writes for `ids`, ready: its rows carry no `hasFolder` mark. */
const mainIndex = (ids: ReadonlyArray<FileId>): string =>
  JSON.stringify({
    downloads: readyStore(ids).downloads.map(({ hasFolder: _mark, ...row }) => row),
    pendingProgress: [],
  });

const listed = (engine: DownloadEngine): ReadonlyArray<string> =>
  engine.getSnapshot().store.downloads.map((download) => `${download.id}:${download.phase}`);

const positionsOf = (engine: DownloadEngine): ReadonlyArray<number> =>
  engine.getSnapshot().store.downloads.map((download) => download.positionMs);

const names = (path: string): ReadonlyArray<string> => readdirSync(path).toSorted();

const everythingUnder = (path: string): ReadonlyArray<string> =>
  readdirSync(path, { recursive: true, encoding: "utf8" }).map((name) => join(path, name));

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

describe("DownloadEngine", () => {
  let root = "";
  let core = new FakeCore();
  const launched: Array<DownloadEngine> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lar-downloads-"));
    core = new FakeCore();
  });

  afterEach(() => {
    for (const engine of launched.splice(0)) engine.dispose();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const launch = (
    disk: DownloadDisk = new NodeDisk(root),
    mediaUrl = "http://media.test",
  ): DownloadEngine => {
    const engine = new DownloadEngine(core, {
      disk,
      mediaUrl,
      settings: { wifiOnly: false },
    });

    launched.push(engine);

    return engine;
  };

  /** What an earlier run left: the index of `ids`, ready, and each one's video. */
  const keep = (ids: ReadonlyArray<FileId>, folder: string = root): void => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, STORE_FILE), serializeStore(readyStore(ids)));

    for (const id of ids) {
      mkdirSync(join(folder, id), { recursive: true });
      writeFileSync(join(folder, itemPath(id, videoFile("mp4"))), "video bytes!");
    }
  };

  const filesUnder = (path: string): ReadonlyArray<string> =>
    readdirSync(join(root, path), { recursive: true, encoding: "utf8" });

  /** Starts `engine`, has the core list `ids` for this device, and waits for it to follow. */
  const follow = async (engine: DownloadEngine, ids: ReadonlyArray<FileId>): Promise<void> => {
    engine.start();
    core.lists(ids);
    await settle();
  };

  /**
   * An engine started on fake timers over `dune` and `arrival`, ready, that removed `arrival` while
   * the core was out of reach.
   */
  const removedOffline = async (): Promise<DownloadEngine> => {
    vi.useFakeTimers();
    keep([dune, arrival]);
    const engine = launch();

    engine.setNetwork({ connected: true, wifi: true });
    engine.start();
    core.lists([dune, arrival]);
    await vi.advanceTimersByTimeAsync(0);
    core.online = false;
    await engine.remove(arrival);
    await vi.advanceTimersByTimeAsync(0);

    expect(core.listing()).toStrictEqual([dune, arrival]);

    return engine;
  };

  it("keeps every download when the app is killed partway through saving", () => {
    keep([dune, arrival]);
    const disk = new NodeDisk(root);
    const engine = launch(disk);

    disk.killAt(1);
    engine.played(dune, 60_000, 9_960_000);

    expect(listed(launch())).toStrictEqual([`${dune}:ready`, `${arrival}:ready`]);
  });

  it("keeps every download when a save runs out of space", () => {
    keep([dune, arrival]);
    const disk = new NodeDisk(root);
    const engine = launch(disk);

    disk.full = true;
    engine.played(dune, 60_000, 9_960_000);

    expect(listed(launch(disk))).toStrictEqual([`${dune}:ready`, `${arrival}:ready`]);
  });

  it("lists the downloads as before or after a save, wherever in it the app is killed", () => {
    const before = { listed: [`${dune}:ready`, `${arrival}:ready`], positions: [0, 0] };
    const after = { listed: before.listed, positions: [60_000, 0] };

    const outcomes = [1, 2, 3, 4].map((nth) => {
      const folder = join(root, `killed-at-${nth}`);

      keep([dune, arrival], folder);
      const disk = new NodeDisk(folder);
      const engine = launch(disk);

      disk.killAt(nth);
      engine.played(dune, 60_000, 9_960_000);
      const relaunched = launch(new NodeDisk(folder));

      return { listed: listed(relaunched), positions: positionsOf(relaunched) };
    });

    // A save writes the new copy (1), deletes the old index (2), and moves the copy in (3).
    expect(outcomes).toStrictEqual([before, before, after, after]);
  });

  it("shows a save that ran out of space as failed, and saves again once there is room", () => {
    vi.useFakeTimers();
    keep([dune]);
    const disk = new NodeDisk(root);
    const engine = launch(disk);
    const heard: Array<string> = [];

    engine.subscribe(() => heard.push(engine.getSnapshot().save));
    disk.full = true;
    engine.played(dune, 60_000, 9_960_000);

    expect(engine.getSnapshot().save).toBe("failed");
    expect(heard).toContain("failed");
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);

    disk.full = false;
    vi.advanceTimersByTime(30_000);

    expect(engine.getSnapshot().save).toBe("saved");
    expect(positionsOf(launch())).toStrictEqual([60_000]);
  });

  it.each(["", '{"downloads":[{"id":"file-du', "not an index"])(
    "forgets nothing when the index reads as %j",
    async (unreadable) => {
      keep([dune]);
      writeFileSync(join(root, STORE_FILE), unreadable);
      const engine = launch();

      engine.start();
      core.lists([dune]);
      await settle();
      engine.dispose();

      expect(core.calls).toStrictEqual([]);
      expect(filesUnder(dune)).toContain(videoFile("mp4"));
      expect(
        readdirSync(root).some(
          (name) => name.endsWith(".json") && readFileSync(join(root, name), "utf8") === unreadable,
        ),
      ).toBe(true);
    },
  );

  it("rebuilds the downloads an unreadable index lost from their own folders, ready to play", async () => {
    keep([dune, arrival]);
    launch().dispose();
    writeFileSync(join(root, STORE_FILE), "not an index");

    const engine = launch();

    engine.start();
    core.lists([dune, arrival]);
    await settle();

    expect(listed(engine).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
    expect(
      engine.getSnapshot().store.downloads.map((download) => engine.videoUri(download)),
    ).not.toContain(null);
    expect(core.calls).toStrictEqual([]);
    expect(readFileSync(join(root, UNREADABLE_STORE_FILE), "utf8")).toBe("not an index");
    expect(listed(launch()).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
  });

  it("takes downloads without an index for an unreadable index, not a first run", async () => {
    keep([dune]);
    launch().dispose();
    rmSync(join(root, STORE_FILE));

    const engine = launch();

    engine.start();
    core.lists([dune]);
    await settle();

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(core.calls).toStrictEqual([]);
  });

  it("frees on the core what it lists on a first run, when this iPhone holds nothing", async () => {
    const engine = launch();

    engine.start();
    core.lists([stranger]);
    await settle();

    expect(listed(engine)).toStrictEqual([]);
    expect(core.calls).toStrictEqual([`remove:${stranger}`]);
  });

  it("keeps the folder of a download a kill stopped partway, and queues it again", () => {
    keep([dune]);

    const stopped = [
      DownloadEvent.Added({ download: newDownload(arrival), at: 9 }),
      DownloadEvent.Confirmed({ id: arrival }),
      DownloadEvent.Delivering({ id: arrival, delivery, revision: "r1", ticketExpiresAt: 0 }),
    ].reduce(reduce, readyStore([dune]));

    writeFileSync(join(root, STORE_FILE), serializeStore(stopped));
    mkdirSync(join(root, arrival));
    writeFileSync(join(root, itemPath(arrival, videoFile("mp4"))), "video");

    expect(listed(launch())).toStrictEqual([`${dune}:ready`, `${arrival}:queued`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
  });

  it("keeps the files no download owns, since only a recorded removal deletes any", async () => {
    keep([dune]);
    const engine = launch();

    await follow(engine, [dune]);
    engine.dispose();
    mkdirSync(join(root, stranger));
    writeFileSync(join(root, itemPath(stranger, videoFile("mp4"))), "video bytes!");
    writeFileSync(join(root, "stray.part"), "left by a crash");
    const before = filesUnder("").toSorted();
    const relaunched = launch();

    await follow(relaunched, [dune]);
    relaunched.dispose();

    expect(filesUnder("").toSorted()).toStrictEqual(before);
    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
    expect(core.calls).toStrictEqual([]);
  });

  it("keeps a folder main left without a copy, and the core's row for it", async () => {
    keep([dune]);
    mkdirSync(join(root, stranger));
    writeFileSync(join(root, itemPath(stranger, videoFile("mp4"))), "video bytes!");

    const engine = launch();

    await follow(engine, [dune, stranger]);
    engine.dispose();
    launch().dispose();

    expect(filesUnder(stranger)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
  });

  it("shows the downloads from their own copies while the index cannot be read", () => {
    keep([dune]);
    launch().dispose();
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE);
    const engine = launch(disk);

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(engine.getSnapshot().save).toBe("unread");
  });

  it("keeps what changed while the index could not be read once it reads", () => {
    vi.useFakeTimers();
    keep([dune, arrival]);
    launch().dispose();
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE, 1);
    const engine = launch(disk);

    engine.played(dune, 60_000, 9_960_000);
    void engine.remove(arrival);
    vi.advanceTimersByTime(30_000);

    expect(engine.getSnapshot().save).toBe("saved");
    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
    expect(positionsOf(launch())).toStrictEqual([60_000]);
    expect(names(root)).not.toContain(arrival);
  });

  it("writes each download's own copy after the launch shows, or as it closes", async () => {
    keep([dune]);
    launch();

    expect(filesUnder(dune)).not.toContain(RECORD_FILE);

    await settle();

    expect(filesUnder(dune)).toContain(RECORD_FILE);

    rmSync(join(root, itemPath(dune, RECORD_FILE)));
    launch().dispose();

    expect(filesUnder(dune)).toContain(RECORD_FILE);
  });

  it("makes no folder for a download until the index holding it is saved", async () => {
    const media = await readyMediaService();

    launch().dispose();
    const disk = new NodeDisk(root);
    const engine = launch(disk, media.url);

    core.serves = true;
    disk.full = true;
    engine.setNetwork({ connected: true, wifi: true });
    engine.add(newDownload(dune));
    engine.start();

    await vi.waitFor(() =>
      expect(["downloading", "interrupted"]).toContain(listed(engine)[0]?.split(":")[1]),
    );
    media.close();

    expect(names(root)).toStrictEqual([STORE_FILE]);
    expect(listed(engine)).toStrictEqual([`${dune}:interrupted`]);
  });

  it("keeps a download through a read error on the first launch over main's index", async () => {
    keep([dune]);
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE, 1);
    launch(disk).dispose();

    const relaunched = launch();

    await follow(relaunched, [dune]);

    expect(names(root)).toContain(dune);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
  });

  it("keeps the folder of a row this version cannot decode, and lists it from its own copy", async () => {
    keep([dune, arrival]);
    launch().dispose();
    writeFileSync(join(root, STORE_FILE), withUnknownPhase());

    const relaunched = launch();

    await follow(relaunched, [dune, arrival]);

    expect(names(root)).toContain(dune);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
    expect(listed(relaunched).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
  });

  it("keeps the folder of a row this version cannot decode when it has no copy", async () => {
    keep([dune, arrival]);
    writeFileSync(join(root, STORE_FILE), withUnknownPhase());
    launch().dispose();

    const relaunched = launch();

    await follow(relaunched, [dune, arrival]);

    expect(names(root)).toContain(dune);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
  });

  it("never takes a stale index.json.new over an index.json it cannot read", () => {
    keep([dune, arrival]);
    writeFileSync(join(root, `${STORE_FILE}.new`), serializeStore(readyStore([dune])));
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE);
    launch(disk).dispose();

    expect(names(root)).toContain(arrival);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(listed(launch()).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
  });

  it("moves nothing aside and saves nothing while the index cannot be read", () => {
    keep([dune]);
    const before = readFileSync(join(root, STORE_FILE), "utf8");
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE);
    const engine = launch(disk);

    engine.played(dune, 60_000, 9_960_000);
    engine.dispose();

    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(readFileSync(join(root, STORE_FILE), "utf8")).toBe(before);
  });

  it("reads the index again once a read error passes, and lists its downloads", () => {
    vi.useFakeTimers();
    keep([dune]);
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE, 1);
    const engine = launch(disk);

    expect(listed(engine)).toStrictEqual([]);

    vi.advanceTimersByTime(30_000);

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
  });

  it("keeps a folder without a copy through an index rebuilt from copies", async () => {
    keep([dune]);
    launch().dispose();
    mkdirSync(join(root, stranger));
    writeFileSync(join(root, itemPath(stranger, videoFile("mp4"))), "video bytes!");
    writeFileSync(join(root, STORE_FILE), "not an index");
    launch().dispose();

    const relaunched = launch();

    await follow(relaunched, [dune, stranger]);

    expect(names(root)).toContain(stranger);
    expect(filesUnder(stranger)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
  });

  it("rebuilds a download from download.json.new when that is its only copy", () => {
    keep([dune]);
    launch().dispose();
    renameSync(
      join(root, itemPath(dune, RECORD_FILE)),
      join(root, itemPath(dune, `${RECORD_FILE}.new`)),
    );
    writeFileSync(join(root, STORE_FILE), "not an index");

    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
  });

  it("never saves an index rebuilt from a listing of the folder that failed", async () => {
    keep([dune]);
    launch().dispose();
    writeFileSync(join(root, STORE_FILE), "not an index");
    const disk = new NodeDisk(root);

    disk.failLists();
    launch(disk).dispose();

    const relaunched = launch();

    await follow(relaunched, [dune]);

    expect(names(root)).toContain(dune);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
  });

  it("takes a folder it cannot list for one it cannot read, not a first run", async () => {
    keep([dune]);
    launch().dispose();
    rmSync(join(root, STORE_FILE));
    const disk = new NodeDisk(root);

    disk.failLists();
    const engine = launch(disk);

    await follow(engine, [dune]);
    engine.dispose();

    const relaunched = launch();

    await follow(relaunched, [dune]);

    expect(names(root)).toContain(dune);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
  });

  it("keeps a download an older saved index lacks, and lists it from its own copy", async () => {
    keep([dune]);
    const first = launch();

    await follow(first, [dune]);
    first.dispose();
    const older = readFileSync(join(root, STORE_FILE), "utf8");

    keep([dune, arrival]);
    const second = launch();

    await follow(second, [dune, arrival]);
    second.dispose();

    expect(filesUnder(arrival)).toContain(RECORD_FILE);

    writeFileSync(join(root, STORE_FILE), older);
    const relaunched = launch();

    expect(listed(relaunched).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));

    await follow(relaunched, [dune, arrival]);

    expect(core.calls).toStrictEqual([]);
    expect(filesUnder(arrival)).toStrictEqual(
      expect.arrayContaining([RECORD_FILE, videoFile("mp4")]),
    );
    expect(listed(launch()).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
  });

  it("tells the core about a download removed offline once it can, after a relaunch", async () => {
    keep([dune, arrival]);
    const engine = launch();

    core.online = false;
    await engine.remove(arrival);
    engine.dispose();

    expect(names(root)).not.toContain(arrival);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));

    core.online = true;
    core.lists([dune, arrival]);
    const relaunched = launch();

    relaunched.start();
    await settle();

    expect(core.calls).toStrictEqual([`remove:${arrival}`, `remove:${arrival}`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
  });

  it("keeps a download another build added after an unanswered removal, and tells the core nothing of that removal", async () => {
    keep([dune, arrival]);
    core.lists([dune, arrival]);
    const engine = launch();

    engine.start();
    await settle();
    core.online = false;
    await engine.remove(arrival);
    await settle();
    engine.dispose();

    // Main's app runs over the same files: it frees Arrival on the core, downloads it again, and
    // writes its row and its video. It knows nothing of the removal's folder and leaves it.
    core.online = true;
    core.lists([dune, arrival]);

    const rows = readyStore([dune, arrival]).downloads.map((row) =>
      Object.assign({}, row, {
        hasFolder: undefined,
        addedAt: row.id === arrival ? Date.now() + 1_000 : row.addedAt,
      }),
    );

    writeFileSync(join(root, STORE_FILE), JSON.stringify({ downloads: rows, pendingProgress: [] }));
    mkdirSync(join(root, arrival));
    writeFileSync(join(root, itemPath(arrival, videoFile("mp4"))), "main's new copy");
    const asked = core.calls.length;
    const back = launch();

    back.start();
    await settle();
    await settle();

    expect(core.calls.slice(asked)).toStrictEqual([]);
    expect(core.listing()).toStrictEqual([dune, arrival]);
    expect(listed(back).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(names(root).filter((name) => name.startsWith("removal+"))).toStrictEqual([]);
  });

  it("tells the core about a removal made offline when the network comes back", async () => {
    keep([dune, arrival]);
    core.lists([dune, arrival]);
    const engine = launch();

    engine.start();
    await settle();
    core.online = false;
    await engine.remove(arrival);
    await settle();

    expect(core.listing()).toStrictEqual([dune, arrival]);

    core.online = true;
    engine.setNetwork({ connected: true, wifi: true });
    await settle();

    expect(core.calls).toStrictEqual([`remove:${arrival}`, `remove:${arrival}`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("never lists a download removed while the index could not be read", async () => {
    keep([dune, arrival]);
    launch().dispose();
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE);
    const held = launch(disk);

    core.online = false;
    await held.remove(arrival);
    held.dispose();

    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);

    core.online = true;
    core.lists([dune, arrival]);
    const relaunched = launch();

    relaunched.start();
    await settle();

    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("never brings back a removed download from an older index", async () => {
    keep([dune, arrival]);
    core.lists([dune, arrival]);
    const first = launch();

    first.start();
    await settle();
    first.dispose();
    const older = readFileSync(join(root, STORE_FILE), "utf8");

    core.online = false;
    const offline = launch();

    await offline.remove(arrival);
    offline.dispose();
    writeFileSync(join(root, STORE_FILE), older);

    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);

    core.online = true;
    const online = launch();

    online.start();
    await settle();
    online.dispose();
    writeFileSync(join(root, STORE_FILE), older);
    const relaunched = launch();

    relaunched.start();
    await settle();

    expect(listed(relaunched)).toStrictEqual([`${dune}:ready`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(core.calls.filter((call) => call.startsWith("add:"))).toStrictEqual([]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("holds while the folder cannot be listed beside a readable index, then lists every copy", async () => {
    vi.useFakeTimers();
    keep([dune, arrival]);
    launch().dispose();
    writeFileSync(join(root, STORE_FILE), serializeStore(readyStore([dune])));
    const disk = new NodeDisk(root);

    disk.failLists(1);
    const engine = launch(disk);

    engine.start();
    core.lists([dune, arrival]);

    expect(engine.getSnapshot().save).toBe("unread");
    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(engine.getSnapshot().save).toBe("saved");
    expect(listed(engine).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
  });

  it("keeps a folder a listing left out, and lists it once a listing finds it", async () => {
    keep([dune, arrival]);
    launch().dispose();
    writeFileSync(join(root, STORE_FILE), serializeStore(readyStore([dune])));
    const disk = new NodeDisk(root);

    disk.hideFromLists(arrival);
    const engine = launch(disk);

    await follow(engine, [dune, arrival]);
    engine.dispose();

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);

    const relaunched = launch();

    await follow(relaunched, [dune, arrival]);

    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(listed(relaunched).toSorted()).toStrictEqual([`${arrival}:ready`, `${dune}:ready`]);
    expect(core.calls).toStrictEqual([]);
  });

  it("deletes only what the person removed and what the core says is expired or gone", async () => {
    const gone = asMediaFileId("file-gone");
    const remain = asMediaFileId("file-remain");

    keep([dune, arrival, gone, remain]);
    writeFileSync(join(root, "unowned"), "a file no download owns");
    launch().dispose();
    const engine = launch();

    engine.start();
    await engine.remove(dune);

    expect(names(root)).not.toContain(dune);

    core.states([
      { item: { kind: "file", id: arrival }, state: "expired", because: "access" },
      { item: { kind: "file", id: gone }, state: "gone" },
      {
        item: { kind: "file", id: remain },
        state: "available",
        revision: "r1",
        quality: "standard",
        bytes: 1,
        label: remain,
      },
    ]);
    await settle();

    expect(filesUnder(arrival)).toStrictEqual([RECORD_FILE]);
    expect(filesUnder(remain)).toContain(videoFile("mp4"));
    expect(listed(engine)).toStrictEqual([`${arrival}:expired`, `${remain}:ready`]);
    expect(core.calls).toStrictEqual([`remove:${dune}`, `remove:${gone}`]);
    expect(names(root).toSorted()).toStrictEqual(
      [arrival, remain, STORE_FILE, "unowned"].toSorted(),
    );
    expect(listed(launch())).toStrictEqual([`${arrival}:expired`, `${remain}:ready`]);
  });

  it("lists a newer index's downloads once its read error passes, never a stale index.json.new", async () => {
    vi.useFakeTimers();
    keep([dune, arrival]);
    writeFileSync(join(root, `${STORE_FILE}.new`), serializeStore(readyStore([dune])));
    const disk = new NodeDisk(root);

    disk.failReads(STORE_FILE, 1);
    const engine = launch(disk);

    expect(engine.getSnapshot().save).toBe("unread");
    expect(names(root)).toContain(arrival);
    expect(readFileSync(join(root, STORE_FILE), "utf8")).toBe(
      serializeStore(readyStore([dune, arrival])),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(listed(engine)).toContain(`${arrival}:ready`);
    expect(names(root)).toContain(arrival);
    expect(core.calls).toStrictEqual([]);
  });

  it("removes a download the core stops listing through a recorded removal", async () => {
    keep([dune, arrival]);
    core.lists([dune, arrival]);
    const engine = launch();

    engine.start();
    await settle();
    core.lists([dune]);
    await settle();

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(core.calls).toStrictEqual([`remove:${arrival}`]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
  });

  it("tells the core about a removal before it adds the same download again", async () => {
    keep([dune, arrival]);
    core.lists([dune, arrival]);
    const engine = launch();

    core.online = false;
    await engine.remove(arrival);
    engine.add(newDownload(arrival));
    engine.dispose();

    core.online = true;
    const relaunched = launch();

    relaunched.setNetwork({ connected: true, wifi: true });
    relaunched.start();
    await settle();

    expect(core.calls).toStrictEqual([`remove:${arrival}`, `remove:${arrival}`, `add:${arrival}`]);
    expect(names(root)).toStrictEqual([arrival, dune, STORE_FILE]);
    expect(filesUnder(arrival)).not.toContain(videoFile("mp4"));
    expect(listed(relaunched).map((entry) => entry.split(":")[0])).toStrictEqual([dune, arrival]);
  });

  it("keeps a download whose removal cannot be recorded, and deletes none of it", async () => {
    keep([dune, arrival]);
    launch().dispose();
    const disk = new NodeDisk(root);

    disk.failRenames();
    const engine = launch(disk);

    await engine.remove(arrival);

    expect(listed(engine)).toStrictEqual([`${dune}:ready`, `${arrival}:ready`]);
    expect(filesUnder(arrival)).toContain(videoFile("mp4"));
    expect(core.calls).toStrictEqual([]);
  });

  it("never brings back a removed download from main's restored index once the core acknowledged it", async () => {
    keep([dune, arrival]);
    writeFileSync(join(root, STORE_FILE), mainIndex([dune, arrival]));
    const upgraded = launch();

    await follow(upgraded, [dune, arrival]);
    await upgraded.remove(arrival);
    await settle();
    upgraded.dispose();

    expect(core.listing()).toStrictEqual([dune]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);

    writeFileSync(join(root, STORE_FILE), mainIndex([dune, arrival]));
    const reopened = launch();

    expect(listed(reopened)).toStrictEqual([`${dune}:ready`]);

    await follow(reopened, [dune]);
    reopened.dispose();

    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
    expect(listed(launch())).toStrictEqual([`${dune}:ready`]);
  });

  it("never brings back a download removed on a full disk over main's index when the app dies before saving", async () => {
    keep([dune, arrival]);
    writeFileSync(join(root, STORE_FILE), mainIndex([dune, arrival]));
    const disk = new NodeDisk(root);

    disk.full = true;
    const upgrading = launch(disk);

    await follow(upgrading, [dune, arrival]);
    await upgrading.remove(arrival);
    await settle();

    expect(upgrading.getSnapshot().save).toBe("failed");
    expect(core.listing()).toStrictEqual([dune]);
    expect(readFileSync(join(root, STORE_FILE), "utf8")).toBe(mainIndex([dune, arrival]));

    // The app dies here: the next launch reads what is on disk, and no save is tried again.
    const reopened = launch();

    expect(listed(reopened)).toStrictEqual([`${dune}:ready`]);

    await settle();

    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
  });

  it("drops a row ready to play whose folder is gone, makes it no folder, and frees it on the core", async () => {
    keep([dune]);
    writeFileSync(join(root, STORE_FILE), mainIndex([dune, arrival]));
    const engine = launch();

    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);

    await follow(engine, [dune, arrival]);

    expect(core.calls).toStrictEqual([`remove:${arrival}`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("keeps a queued row from main that never had a folder", async () => {
    keep([dune]);

    const queued = reduce(
      readyStore([dune]),
      DownloadEvent.Added({ download: newDownload(arrival), at: 9 }),
    );

    writeFileSync(
      join(root, STORE_FILE),
      JSON.stringify({
        downloads: queued.downloads.map(({ hasFolder: _mark, ...row }) => row),
        pendingProgress: [],
      }),
    );
    const engine = launch();

    await settle();

    expect(listed(engine)).toStrictEqual([`${dune}:ready`, `${arrival}:queued`]);
    expect(listed(launch())).toStrictEqual([`${dune}:ready`, `${arrival}:queued`]);
  });

  it("never shows a download whose removal is recorded while the folder cannot be listed", async () => {
    keep([dune, arrival]);
    const first = launch();

    await follow(first, [dune, arrival]);
    first.dispose();
    const disk = new NodeDisk(root);
    const removing = launch(disk);

    core.online = false;
    // Killed at the save after the rename, so the index still holds the removed download.
    disk.killAt(2);
    await removing.remove(arrival);
    const index = readFileSync(join(root, STORE_FILE), "utf8");

    const unlistable = new NodeDisk(root);

    unlistable.failLists();
    const held = launch(unlistable);

    expect(held.getSnapshot().save).toBe("unread");
    expect(listed(held)).toStrictEqual([`${dune}:ready`]);
    expect(names(root)).not.toContain(arrival);

    held.dispose();

    expect(readFileSync(join(root, STORE_FILE), "utf8")).toBe(index);
  });

  it("shows only what plays while the folder cannot be listed, and drops nothing until it can", async () => {
    vi.useFakeTimers();
    keep([dune]);
    writeFileSync(join(root, STORE_FILE), mainIndex([dune, arrival]));
    const disk = new NodeDisk(root);

    disk.failLists(1);
    const engine = launch(disk);

    expect(engine.getSnapshot().save).toBe("unread");
    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(readFileSync(join(root, STORE_FILE), "utf8")).toBe(mainIndex([dune, arrival]));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(engine.getSnapshot().save).toBe("saved");
    expect(listed(engine)).toStrictEqual([`${dune}:ready`]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("carries a recorded removal over a folder a late transfer made again, and never lists it", async () => {
    keep([dune, arrival]);
    const first = launch();

    await follow(first, [dune, arrival]);
    first.dispose();
    renameSync(join(root, arrival), join(root, removalFolder(arrival, Date.now())));
    mkdirSync(join(root, arrival));
    writeFileSync(join(root, itemPath(arrival, videoFile("mp4"))), "a late transfer's video");
    core.online = false;
    const offline = launch();

    expect(listed(offline)).toStrictEqual([`${dune}:ready`]);
    expect(names(root)).not.toContain(arrival);

    offline.dispose();
    core.online = true;
    const online = launch();

    await follow(online, [dune, arrival]);

    expect(core.calls).toStrictEqual([`remove:${arrival}`]);
    expect(core.listing()).toStrictEqual([dune]);
    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
  });

  it("keeps a download added again after its removal over an older index's row for it", async () => {
    keep([dune, arrival]);
    const first = launch();

    await follow(first, [dune, arrival]);
    first.dispose();
    const older = readFileSync(join(root, STORE_FILE), "utf8");

    core.online = false;
    const offline = launch();

    await offline.remove(arrival);
    offline.add(newDownload(arrival));
    offline.dispose();
    writeFileSync(join(root, STORE_FILE), older);

    expect(listed(launch())).toStrictEqual([`${dune}:ready`, `${arrival}:queued`]);
    expect(filesUnder(arrival)).toStrictEqual([RECORD_FILE]);
  });

  it("deletes a removed download's files on a full disk, though its index cannot save", async () => {
    keep([dune, arrival]);
    const disk = new NodeDisk(root);
    const engine = launch(disk);

    await follow(engine, [dune, arrival]);
    disk.full = true;
    core.online = false;
    await engine.remove(arrival);

    const removals = names(root).filter((name) => name.startsWith("removal+"));

    expect(engine.getSnapshot().save).toBe("failed");
    expect(names(root)).not.toContain(arrival);
    expect(removals).toHaveLength(1);
    expect(filesUnder(removals[0] ?? "")).toStrictEqual([]);
  });

  describe("telling the core about a removal it did not take", () => {
    it("tells it again while the app is in front, with no new network, sync, or launch", async () => {
      await removedOffline();
      core.online = true;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(core.listing()).toStrictEqual([dune]);
      expect(names(root)).toStrictEqual([dune, STORE_FILE]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("tells it again as soon as another call to it is answered", async () => {
      const engine = await removedOffline();

      core.online = true;
      engine.played(dune, 60_000, 9_960_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(core.listing()).toStrictEqual([dune]);
    });

    it("tells it nothing while the app is in the background, and again once it comes back", async () => {
      const engine = await removedOffline();

      engine.setForeground(false);
      core.online = true;
      await vi.advanceTimersByTimeAsync(600_000);

      expect(core.calls).toStrictEqual([`remove:${arrival}`]);
      expect(vi.getTimerCount()).toBe(0);

      engine.setForeground(true);
      await vi.advanceTimersByTimeAsync(0);

      expect(core.calls).toStrictEqual([`remove:${arrival}`, `remove:${arrival}`]);
      expect(core.listing()).toStrictEqual([dune]);
    });

    it("keeps asking a core that failed while running the removal", async () => {
      const engine = await removedOffline();

      core.online = true;
      core.refusal = new Internal({
        message: "The server failed while running core/downloads:remove",
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(engine.getSnapshot().removalRefused).toBe(false);

      core.refusal = null;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(core.listing()).toStrictEqual([dune]);
      expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    });

    it("stops asking a core that refused it for good, says so, and asks again at the next launch", async () => {
      const engine = await removedOffline();

      core.online = true;
      core.refusal = new Conflict({ message: "This session is on no device." });
      await vi.advanceTimersByTimeAsync(60_000);
      engine.setNetwork({ connected: true, wifi: true });
      core.lists([dune, arrival]);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(core.calls).toStrictEqual([`remove:${arrival}`, `remove:${arrival}`]);
      expect(engine.getSnapshot().removalRefused).toBe(true);
      expect(names(root).filter((name) => name.startsWith("removal+"))).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);

      engine.dispose();
      core.refusal = null;
      const relaunched = launch();

      relaunched.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(core.calls).toStrictEqual([
        `remove:${arrival}`,
        `remove:${arrival}`,
        `remove:${arrival}`,
      ]);
      expect(relaunched.getSnapshot().removalRefused).toBe(false);
      expect(core.listing()).toStrictEqual([dune]);
      expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    });
  });

  describe.each(["offline", "online"] as const)("killed while removing a download %s", (first) => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      "finishes the removal after a kill at file change %i, and leaves the others",
      async (nth) => {
        keep([dune, arrival]);
        launch().dispose();
        writeFileSync(join(root, itemPath(arrival, "subtitle-en.vtt")), "WEBVTT");
        core.lists([dune, arrival]);
        const disk = new NodeDisk(root);
        const engine = launch(disk);

        core.online = first === "online";
        disk.killAt(nth);
        await engine.remove(arrival);
        await settle();

        // The removal's file changes: the rename that records it (1), the index save (2 to 4),
        // and deleting its three files (5 to 7); once the core acknowledged, its folder (8).
        const recorded = nth > 1;

        const removals = names(root).filter((name) => name.startsWith("removal+"));

        expect(names(root).includes(arrival)).toBe(!recorded);
        expect(removals).toHaveLength(recorded ? 1 : 0);
        expect(removals.flatMap((name) => names(join(root, name)))).toHaveLength(
          recorded ? Math.min(3, 8 - nth) : 0,
        );
        expect(core.calls).toStrictEqual(recorded ? [`remove:${arrival}`] : []);

        core.online = false;

        const offline = launch();

        const media = filesUnder("").filter(
          (path) => !path.startsWith(dune) && /\.(?:mp4|vtt)$/u.test(path),
        );

        expect(listed(offline)).toStrictEqual(
          recorded ? [`${dune}:ready`] : [`${dune}:ready`, `${arrival}:ready`],
        );
        expect(media).toStrictEqual(
          recorded
            ? []
            : [itemPath(arrival, "subtitle-en.vtt"), itemPath(arrival, videoFile("mp4"))],
        );
        offline.dispose();

        core.online = true;
        const online = launch();

        online.start();
        await settle();

        expect(filesUnder(dune)).toContain(videoFile("mp4"));
        expect(core.calls).not.toContain(`remove:${dune}`);

        expect(core.calls).toStrictEqual(
          recorded ? [`remove:${arrival}`, `remove:${arrival}`] : [],
        );

        if (recorded) {
          expect(listed(online)).toStrictEqual([`${dune}:ready`]);
          expect(core.listing()).toStrictEqual([dune]);
          expect(names(root)).toStrictEqual([dune, STORE_FILE]);
        } else {
          expect(listed(online)).toStrictEqual([`${dune}:ready`, `${arrival}:ready`]);
          expect(filesUnder(arrival)).toContain(videoFile("mp4"));
          expect(core.listing()).toStrictEqual([dune, arrival]);
        }
      },
    );
  });

  describe("backups and signing out", () => {
    const server = "http://media.test";

    /** The folder of `userId`'s downloads in `downloads/`, as `<server>/<person>`. */
    const personOf = (userId: string): string =>
      accountFolder(server, userId).slice(DOWNLOADS_FOLDER.length + 1);

    const ana = personOf("ana");
    const ben = personOf("ben");

    let downloads = "";
    let anaCore = new FakeCore();
    let benCore = new FakeCore();

    beforeEach(() => {
      downloads = join(root, DOWNLOADS_FOLDER);
      anaCore = new FakeCore();
      benCore = new FakeCore();
    });

    const folderOf = (person: string): string => join(downloads, ...person.split("/"));

    /** What an earlier run left in `person`'s folder: `ids` ready to play, and a subtitle of each. */
    const keepFor = (person: string, ids: ReadonlyArray<FileId>): void => {
      keep(ids, folderOf(person));

      for (const id of ids)
        writeFileSync(join(folderOf(person), itemPath(id, "subtitle-en.vtt")), "WEBVTT");
    };

    const run = (person: string, onCore: FakeCore, disk: DownloadDisk): DownloadEngine => {
      const engine = new DownloadEngine(onCore, {
        disk,
        mediaUrl: server,
        settings: { wifiOnly: false },
      });

      launched.push(engine);

      return engine;
    };

    /** A launch: prepares `downloads/`, then runs the engine of whoever is signed in, started. */
    const relaunch = async (
      signedIn: "nobody" | "ana" | "ben",
      folders = new NodeRoot(downloads),
    ): Promise<{ readonly folders: NodeRoot; readonly engine: DownloadEngine | null }> => {
      prepareDownloads(folders);

      if (signedIn === "nobody") return { folders, engine: null };

      const engine =
        signedIn === "ana"
          ? run(ana, anaCore, folders.disk(ana))
          : run(ben, benCore, folders.disk(ben));

      engine.setNetwork({ connected: true, wifi: true });
      engine.start();
      await settle();

      return { folders, engine };
    };

    /** The media files in `person`'s folder, recorded removals included. */
    const mediaOf = (person: string): ReadonlyArray<string> =>
      readdirSync(folderOf(person), { recursive: true, encoding: "utf8" })
        .filter((path) => /\.(?:mp4|vtt)$/u.test(path))
        .toSorted();

    /** What records an unfinished removal or sign-out in `person`'s folder. */
    const recordsOf = (person: string): ReadonlyArray<string> =>
      names(folderOf(person)).filter((name) => /^(?:removal|signed-out)\+/u.test(name));

    /** Ben's downloads, untouched: his \`stranger\` lists, plays from its file, and the core still counts it. */
    const expectBenUntouched = (engine: DownloadEngine | null): void => {
      expect(mediaOf(ben)).toStrictEqual([
        itemPath(stranger, "subtitle-en.vtt"),
        itemPath(stranger, videoFile("mp4")),
      ]);
      expect(benCore.calls.filter((call) => call.startsWith("remove:"))).toStrictEqual([]);
      expect(benCore.listing()).toStrictEqual([stranger]);

      if (engine !== null) expect(listed(engine)).toStrictEqual([`${stranger}:ready`]);
    };

    it("excludes every file of every download from backup, kept before the update or written after, through a removal's rename", async () => {
      keepFor(ana, [dune, arrival]);
      keepFor(ben, [stranger]);
      const folders = new NodeRoot(downloads);

      expect(
        everythingUnder(downloads).filter((path) => folders.flags.excluded(path)),
      ).toStrictEqual([]);

      anaCore.serves = true;
      anaCore.lists([dune, arrival]);
      const { engine } = await relaunch("ana", folders);

      engine?.add(newDownload(asMediaFileId("file-heat")));
      engine?.played(dune, 60_000, 9_960_000);
      await engine?.remove(arrival);
      await settle();

      const paths = everythingUnder(downloads);

      expect(paths.some((path) => path.endsWith(RECORD_FILE))).toBe(true);
      expect(paths.some((path) => path.includes("file-heat"))).toBe(true);
      expect(paths.filter((path) => !folders.flags.excluded(path))).toStrictEqual([]);
    });

    it("removes a person's downloads at sign-out, from this iPhone and from the core's count, and leaves another person's", async () => {
      keepFor(ana, [dune, arrival]);
      keepFor(ben, [stranger]);
      anaCore.lists([dune, arrival]);
      benCore.lists([stranger]);
      const { engine } = await relaunch("ana");

      await engine?.signOut();
      engine?.dispose();
      await relaunch("nobody");

      expect(mediaOf(ana)).toStrictEqual([]);
      expect(recordsOf(ana)).toStrictEqual([]);
      expect(anaCore.listing()).toStrictEqual([]);

      const back = await relaunch("ana");

      expect(back.engine === null ? null : listed(back.engine)).toStrictEqual([]);
      expectBenUntouched((await relaunch("ben")).engine);
    });

    it.each(["out of reach", "not confirmed"] as const)(
      "removes the files at a sign-out while the core is %s, and tells it once the person signs in again",
      async (offline) => {
        keepFor(ana, [dune, arrival]);
        keepFor(ben, [stranger]);
        anaCore.lists([dune, arrival]);
        benCore.lists([stranger]);
        anaCore.online = false;
        const folders = new NodeRoot(downloads);
        const engine = run(ana, anaCore, folders.disk(ana));

        engine.setNetwork({ connected: true, wifi: true });

        if (offline === "out of reach") engine.start();
        await settle();
        await engine.signOut();
        engine.dispose();
        await relaunch("nobody");

        expect(mediaOf(ana)).toStrictEqual([]);
        expect(recordsOf(ana).filter((name) => name.startsWith("signed-out+"))).toStrictEqual([]);
        expect(recordsOf(ana)).toHaveLength(2);
        expect(anaCore.listing()).toStrictEqual([dune, arrival]);

        anaCore.online = true;
        expectBenUntouched((await relaunch("ben")).engine);
        expect(anaCore.listing()).toStrictEqual([dune, arrival]);

        await relaunch("ana");

        expect(anaCore.listing()).toStrictEqual([]);
        expect(recordsOf(ana)).toStrictEqual([]);
        expect(mediaOf(ana)).toStrictEqual([]);
      },
    );

    it("keeps a download added after a sign-out it could not finish", async () => {
      keepFor(ana, [dune]);
      markSignedOut(new NodeDisk(folderOf(ana)), 5);
      writeFileSync(
        join(folderOf(ana), STORE_FILE),
        serializeStore(
          [
            DownloadEvent.Added({ download: newDownload(dune), at: 1 }),
            DownloadEvent.Added({ download: newDownload(arrival), at: 10 }),
          ].reduce(reduce, EMPTY_STORE),
        ),
      );
      const { engine } = await relaunch("ana");

      expect(engine?.getSnapshot().store.downloads.map((download) => download.id)).toStrictEqual([
        arrival,
      ]);
      expect(mediaOf(ana)).toStrictEqual([]);
      expect(recordsOf(ana)).toStrictEqual([]);
    });

    it("keeps a download added after an unfinished sign-out stamped ahead of the phone's clock", async () => {
      keepFor(ana, [dune]);
      markSignedOut(new NodeDisk(folderOf(ana)), Date.now() + 86_400_000);
      const folders = new NodeRoot(downloads);

      folders.disk(ana).failRenames();
      const { engine } = await relaunch("ana", folders);

      expect(recordsOf(ana)).toHaveLength(1);

      engine?.add(newDownload(arrival));
      engine?.dispose();
      const back = await relaunch("ana", new NodeRoot(downloads, folders.flags));

      expect(
        back.engine?.getSnapshot().store.downloads.map((download) => download.id),
      ).toStrictEqual([arrival]);
      expect(mediaOf(ana)).toStrictEqual([]);
      expect(recordsOf(ana)).toStrictEqual([]);
      expect(anaCore.calls).toContain(`remove:${dune}`);
      expect(anaCore.calls).not.toContain(`remove:${arrival}`);
    });

    describe.each(["online", "offline"] as const)("killed while signing out %s", (reach) => {
      it.each(Array.from({ length: 24 }, (_, index) => index + 1))(
        "removes the person's downloads and no one else's after a kill at file change %i",
        async (nth) => {
          keepFor(ana, [dune, arrival]);
          keepFor(ben, [stranger]);
          anaCore.lists([dune, arrival]);
          benCore.lists([stranger]);
          const { folders, engine } = await relaunch("ana");

          anaCore.online = reach === "online";
          const disk = folders.disk(ana);

          disk.killAt(nth);
          await engine?.signOut();

          // The server's sign-out runs only when the app lives past the engine's part.
          const signedOut = !disk.dead;

          engine?.dispose();

          if (signedOut) prepareDownloads(folders);

          const flags = folders.flags;

          anaCore.online = true;

          if (nth === 1) {
            // Killed while recording the sign-out: nothing of it landed, and Ana is still signed in.
            const back = await relaunch("ana", new NodeRoot(downloads, flags));

            expect(back.engine === null ? null : listed(back.engine)).toStrictEqual([
              `${dune}:ready`,
              `${arrival}:ready`,
            ]);
            expect(anaCore.listing()).toStrictEqual([dune, arrival]);
            expectBenUntouched((await relaunch("ben", new NodeRoot(downloads, flags))).engine);

            return;
          }

          if (signedOut) {
            await relaunch("nobody", new NodeRoot(downloads, flags));

            expect(mediaOf(ana)).toStrictEqual([]);
            expectBenUntouched((await relaunch("ben", new NodeRoot(downloads, flags))).engine);
            expect(mediaOf(ana)).toStrictEqual([]);
          }

          const back = await relaunch("ana", new NodeRoot(downloads, flags));

          expect(back.engine === null ? null : listed(back.engine)).toStrictEqual([]);
          expect(mediaOf(ana)).toStrictEqual([]);
          expect(recordsOf(ana)).toStrictEqual([]);
          expect(anaCore.listing()).toStrictEqual([]);
          expectBenUntouched((await relaunch("ben", new NodeRoot(downloads, flags))).engine);
        },
      );
    });
  });
});
