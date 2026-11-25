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

import type { PlatformSdk } from "@media/sdk/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asMediaFileId, asTitleId } from "@/lib/catalog";
import {
  RECORD_FILE,
  STORE_FILE,
  UNREADABLE_STORE_FILE,
  itemPath,
  videoFile,
} from "@/lib/downloads/files";
import { DownloadEvent, EMPTY_STORE, reduce, serializeStore } from "@/lib/downloads/model";
import type { Delivery, DownloadStore, FileId, NewDownload } from "@/lib/downloads/model";
import { NodeDisk } from "@/lib/downloads/node-disk";

import { DownloadEngine } from "./download-engine";
import type { EnginePlatform } from "./download-engine";

type ListPage = Awaited<ReturnType<PlatformSdk["core"]["downloads"]["list"]>>;

/** The core as the engine calls it: a list of what this device keeps, and the calls it records. */
class FakeCore implements EnginePlatform {
  readonly calls: Array<string> = [];
  #page: ListPage = { page: [], isDone: true, continueCursor: "" };
  readonly #listeners = new Set<() => void>();

  /** Lists `ids` as kept on this device at revision `r1`, and tells the engine. */
  lists(ids: ReadonlyArray<FileId>): void {
    this.#page = {
      page: ids.map((id) => ({
        item: { kind: "file", id },
        state: "available",
        revision: "r1",
        quality: "standard",
        bytes: 1,
        label: id,
      })),
      isDone: true,
      continueCursor: "",
    };

    for (const listener of this.#listeners) listener();
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

        return Promise.resolve(null);
      },
      fetch: () => Promise.reject(new Error("These tests fetch no ticket.")),
    },
  };

  readonly movies: EnginePlatform["movies"] = {
    play: {
      start: () => Promise.reject(new Error("These tests start no playback.")),
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

const listed = (engine: DownloadEngine): ReadonlyArray<string> =>
  engine.getSnapshot().store.downloads.map((download) => `${download.id}:${download.phase}`);

const positionsOf = (engine: DownloadEngine): ReadonlyArray<number> =>
  engine.getSnapshot().store.downloads.map((download) => download.positionMs);

const names = (path: string): ReadonlyArray<string> => readdirSync(path).toSorted();

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

describe("DownloadEngine", () => {
  let root = "";
  let core = new FakeCore();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lar-downloads-"));
    core = new FakeCore();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const launch = (disk: NodeDisk = new NodeDisk(root)): DownloadEngine =>
    new DownloadEngine(core, {
      disk,
      mediaUrl: "http://media.test",
      settings: { wifiOnly: false },
    });

  /** What an earlier run left: the index of `ids`, ready, and each one's video. */
  const keep = (ids: ReadonlyArray<FileId>, folder: string = root): void => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, STORE_FILE), serializeStore(readyStore(ids)));

    for (const id of ids) {
      mkdirSync(join(folder, id));
      writeFileSync(join(folder, itemPath(id, videoFile("mp4"))), "video bytes!");
    }
  };

  const filesUnder = (path: string): ReadonlyArray<string> =>
    readdirSync(join(root, path), { recursive: true, encoding: "utf8" });

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

  it("removes the files no download owns, and keeps the ones it does", () => {
    keep([dune, stranger]);
    writeFileSync(join(root, STORE_FILE), serializeStore(readyStore([dune])));
    writeFileSync(join(root, "stray.part"), "left by a crash");

    launch();

    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));

    const swept = filesUnder("");

    launch();

    expect(filesUnder("")).toStrictEqual(swept);
  });

  /** Starts `engine`, has the core list `ids` for this device, and waits for it to follow. */
  const follow = async (engine: DownloadEngine, ids: ReadonlyArray<FileId>): Promise<void> => {
    engine.start();
    core.lists(ids);
    await settle();
  };

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

  it("keeps an index rebuilt from copies marked as rebuilt on the next launch", async () => {
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
});
