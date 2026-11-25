import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformSdk } from "@media/sdk/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asMediaFileId, asTitleId } from "@/lib/catalog";
import { STORE_FILE, itemPath, videoFile } from "@/lib/downloads/files";
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

/** Each download the engine lists, with its phase. */
const listed = (engine: DownloadEngine): ReadonlyArray<string> =>
  engine.getSnapshot().store.downloads.map((download) => `${download.id}:${download.phase}`);

/** The names in the folder at `path`, in order. */
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
    rmSync(root, { recursive: true, force: true });
  });

  /** The engine an app launch makes over the folder. */
  const launch = (disk: NodeDisk = new NodeDisk(root)): DownloadEngine =>
    new DownloadEngine(core, {
      disk,
      mediaUrl: "http://media.test",
      settings: { wifiOnly: false },
    });

  /** What an earlier run left: the index of `ids`, ready, and each one's video. */
  const keep = (ids: ReadonlyArray<FileId>): void => {
    writeFileSync(join(root, STORE_FILE), serializeStore(readyStore(ids)));

    for (const id of ids) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, itemPath(id, videoFile("mp4"))), "video bytes!");
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

  it("removes the files no download owns, and keeps the ones it does", () => {
    keep([dune, stranger]);
    writeFileSync(join(root, STORE_FILE), serializeStore(readyStore([dune])));
    writeFileSync(join(root, "stray.part"), "left by a crash");

    launch();

    expect(names(root)).toStrictEqual([dune, STORE_FILE]);
    expect(filesUnder(dune)).toContain(videoFile("mp4"));
  });
});
