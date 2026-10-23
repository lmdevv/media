import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AlbumId,
  ArtistId,
  DeviceId,
  DownloadPinId,
  PlaylistId,
  TrackId,
} from "@music/commands/ids";
import type { DownloadManifest, DownloadPin, OfflineTrack } from "@music/commands/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeMusicClient } from "../client";
import { FakeMedia, recordingTransport } from "./fake-media";
import type { Mutation } from "./fake-media";
import { DownloadResult } from "./finished-file";
import type { Transfer } from "./finished-file";
import { nodeTransfer } from "./node-transfer";
import type { StoredCopy } from "./plan";
import { downloadStatus, trackDownloadState } from "./status";
import { DownloadSync } from "./sync";
import { applyChange, emptyVault, VaultChange } from "./vault";
import type { VaultRows, VaultStore } from "./vault";

/** A vault whose rows live in memory and whose files live in a real directory. */
class DirectoryVault implements VaultStore {
  view: VaultRows;
  free: number | null = 64 * 1024 ** 3;
  /** Loads that fail before one works, as an unreadable database would. */
  failingLoads = 0;
  /** Song rows refused before one is written, as a full disk would. */
  failingCopies = 0;
  /** Holds a change until the returned promise settles, as a slow disk would; null lets it pass. */
  hold: (change: VaultChange) => Promise<void> | null = () => null;
  readonly #dir: string;

  constructor(dir: string, view: VaultRows = emptyVault) {
    this.#dir = dir;
    this.view = view;
  }

  load = (): Promise<VaultRows> => {
    if (this.failingLoads > 0) {
      this.failingLoads -= 1;

      return Promise.reject(new Error("database disk image is malformed"));
    }

    return Promise.resolve(this.view);
  };

  commit = async (change: VaultChange): Promise<void> => {
    if (VaultChange.$is("PutCopy")(change) && this.failingCopies > 0) {
      this.failingCopies -= 1;

      throw new Error("database or disk is full");
    }

    await this.hold(change);
    this.view = applyChange(this.view, change);
  };

  files = async (): Promise<ReadonlyArray<string>> => {
    const names = await readdir(this.#dir, { recursive: true, withFileTypes: true });

    return names
      .values()
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(this.#dir.length + 1))
      .toArray();
  };

  uri = (file: string): string => join(this.#dir, file);

  remove = (file: string): Promise<void> => rm(join(this.#dir, file), { force: true });

  size = (file: string): Promise<number | null> =>
    stat(join(this.#dir, file)).then(
      (found) => found.size,
      () => null,
    );

  freeBytes = (): number | null => this.free;
}

const song = (id: string, title: string): OfflineTrack => ({
  id: TrackId.make(id),
  title,
  artist: "Massive Attack",
  artistId: ArtistId.make("artist"),
  album: "Blue Lines",
  albumId: AlbumId.make("blue-lines"),
  trackNumber: 1,
  discNumber: 1,
  durationMs: 1000,
  codec: "FLAC",
  lossless: true,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: "/media/art/cover",
});

const ALBUM: DownloadPin = {
  id: DownloadPinId.make("pin"),
  deviceId: DeviceId.make("phone"),
  target: { kind: "album", id: AlbumId.make("blue-lines") },
  createdAt: 1,
  available: true,
  title: "Blue Lines",
  subtitle: "Massive Attack",
  artUrl: "/media/art/cover",
  artHash: "cover",
};

/** How long a sync may take to settle: real HTTP and files, while other suites load the machine. */
const SETTLE = { timeout: 10_000 };

const SAFE = song("t1", "Safe from Harm");

const UNFINISHED = song("t2", "Unfinished Sympathy");

const MANIFEST: DownloadManifest = {
  pin: ALBUM,
  entries: [
    { track: SAFE, rev: "r1", artHash: "cover", state: "fetchable" },
    { track: UNFINISHED, rev: "r1", artHash: "cover", state: "fetchable" },
  ],
};

let media: FakeMedia;

let base: string;

let dir: string;

let mutations: Array<Mutation>;

let stops: Array<() => void>;

beforeEach(async () => {
  media = new FakeMedia();
  base = await media.listen();
  dir = await mkdtemp(join(tmpdir(), "download-sync-"));
  mutations = [];
  stops = [];
  media.serve("/media/stream/t1", "safe from harm");
  media.serve("/media/stream/t2", "unfinished sympathy", { preparing: 1 });
  media.serve("/media/art/cover", "jpeg", { contentType: "image/jpeg" });
});

afterEach(async () => {
  for (const stop of stops) stop();
  await media.close();
  await rm(dir, { recursive: true, force: true });
});

/** What a test changes about the sync it starts. */
interface SyncSetup {
  readonly transfer?: Transfer;
  readonly now?: () => number;
  /** Mutations the server never answers, as while offline. */
  readonly unanswered?: ReadonlySet<string>;
}

const started = (vault: VaultStore, setup: SyncSetup = {}): DownloadSync => {
  const sync = new DownloadSync({
    client: makeMusicClient(recordingTransport(mutations, setup.unanswered)),
    vault,
    transfer: setup.transfer ?? nodeTransfer,
    deviceId: DeviceId.make("phone"),
    policy: () => ({ profileFor: () => "aac-320" }),
    resolveUrl: (url) => `${base}${url}`,
    now: setup.now ?? Date.now,
    sleep: () => Promise.resolve(),
  });

  stops.push(sync.start());

  return sync;
};

/** A transfer with no network behind it: downloads break, or once `hang` is set, wait until aborted. */
const brokenTransfer = (state: { hang: boolean }): Transfer => ({
  head: () =>
    Promise.resolve(new Response(null, { status: 200, headers: { "Content-Type": "audio/mp4" } })),
  download: ({ signal }) =>
    state.hang
      ? new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve(DownloadResult.Broken({ message: "aborted" }));
            },
            { once: true },
          );
        })
      : Promise.resolve(DownloadResult.Broken({ message: "connection reset" })),
});

/** How many snapshots `sync` publishes in `ms` of real time. An idle sync publishes about none. */
const publishesIn = async (sync: DownloadSync, ms: number): Promise<number> => {
  let count = 0;

  const unsubscribe = sync.subscribe(() => {
    count += 1;
  });

  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

  unsubscribe();

  return count;
};

/** How many times the media service sent the file of `trackId`. */
const fetchesOf = (trackId: string): number =>
  media.seen.filter(({ method, url }) => method === "GET" && url.includes(`/${trackId}?`)).length;

const exists = async (file: string): Promise<boolean> =>
  stat(join(dir, file)).then(
    () => true,
    () => false,
  );

/** A sync holding the album, and the URI of its first song's copy. */
const holdingAlbum = async () => {
  const vault = new DirectoryVault(dir);
  const sync = started(vault);
  sync.setOnline(true);
  sync.offerPins([ALBUM]);
  sync.offerManifest(ALBUM.id, MANIFEST);

  await vi.waitFor(() => {
    expect(sync.localCopy(SAFE.id)).not.toBeNull();
  }, SETTLE);

  return { sync, vault, uri: sync.localCopy(SAFE.id)?.uri ?? "" };
};

describe("DownloadSync", () => {
  it("keeps an album's songs and cover on the device once the server lists it", async () => {
    const vault = new DirectoryVault(dir);
    const sync = started(vault);
    sync.setOnline(true);
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(downloadStatus(sync.getSnapshot(), ALBUM.target)).toEqual({
        kind: "downloaded",
        bytes: 33,
      });
    }, SETTLE);

    expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(true);
    expect(await exists("audio/t2.r1.aac-320.m4a")).toBe(true);

    expect(sync.localCopy(SAFE.id)).toEqual({
      track: SAFE,
      uri: join(dir, "audio/t1.r1.aac-320.m4a"),
      profile: "aac-320",
      bytes: 14,
      artUri: join(dir, "art/cover"),
    });

    expect(downloadStatus(sync.getSnapshot(), { kind: "track", id: SAFE.id })).toEqual({
      kind: "included",
      by: { kind: "album", title: "Blue Lines" },
    });
  });

  describe("when a copy fails to play", () => {
    it("keeps a whole file on disk and stops offering it for the session", async () => {
      const { sync, vault, uri } = await holdingAlbum();
      sync.discard(SAFE.id, uri);

      expect(sync.localCopy(SAFE.id)).toBeNull();

      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(true);
      expect(vault.view.copies.has(SAFE.id)).toBe(true);
      expect(fetchesOf("t1")).toBe(1);
      expect(sync.localCopy(SAFE.id)).toBeNull();
    });

    it("deletes a broken file and fetches the song again", async () => {
      const { sync, uri } = await holdingAlbum();
      await writeFile(join(dir, "audio/t1.r1.aac-320.m4a"), "trunc");
      sync.discard(SAFE.id, uri);

      expect(sync.localCopy(SAFE.id)).toBeNull();

      await vi.waitFor(() => {
        expect(fetchesOf("t1")).toBe(2);
        expect(sync.localCopy(SAFE.id)).not.toBeNull();
      }, SETTLE);
    });

    it("doesn't bring the row back when new details land after the copy was deleted", async () => {
      const { sync, vault, uri } = await holdingAlbum();
      const write = Promise.withResolvers<void>();
      const REMASTERED = song("t1", "Safe from Harm (Remastered)");

      vault.hold = (change) =>
        (VaultChange.$is("PutCopy")(change) || VaultChange.$is("UpdateCopy")(change)) &&
        change.copy.track.title === REMASTERED.title
          ? write.promise
          : null;

      sync.offerManifest(ALBUM.id, {
        pin: ALBUM,
        entries: [
          { track: REMASTERED, rev: "r1", artHash: "cover", state: "fetchable" },
          { track: UNFINISHED, rev: "r1", artHash: "cover", state: "fetchable" },
        ],
      });

      await writeFile(join(dir, "audio/t1.r1.aac-320.m4a"), "trunc");
      sync.discard(SAFE.id, uri);

      await vi.waitFor(() => {
        expect(vault.view.copies.has(SAFE.id)).toBe(false);
      }, SETTLE);

      write.resolve();

      await vi.waitFor(() => {
        expect(fetchesOf("t1")).toBe(2);
        expect(sync.localCopy(SAFE.id)?.track.title).toBe(REMASTERED.title);
      }, SETTLE);
    });

    it("leaves a newer copy alone when an older one failed", async () => {
      const { sync, vault } = await holdingAlbum();
      sync.discard(SAFE.id, join(dir, "audio/t1.r0.aac-320.m4a"));

      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      expect(sync.localCopy(SAFE.id)).not.toBeNull();
      expect(vault.view.copies.has(SAFE.id)).toBe(true);
      expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(true);
      expect(fetchesOf("t1")).toBe(1);
    });
  });

  it("deletes the files of a removed download at once and tells the server", async () => {
    const vault = new DirectoryVault(dir);
    const sync = started(vault);
    sync.setOnline(true);
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(trackDownloadState(sync.getSnapshot(), UNFINISHED.id)).toBe("downloaded");
    }, SETTLE);

    await sync.remove(ALBUM.target);

    await vi.waitFor(async () => {
      expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(false);
    }, SETTLE);

    expect(await exists("art/cover")).toBe(false);
    expect(downloadStatus(sync.getSnapshot(), ALBUM.target)).toEqual({ kind: "none" });

    expect(mutations).toContainEqual({
      name: "downloads.remove",
      args: { deviceId: "phone", kind: "album", id: "blue-lines" },
    });

    sync.offerPins([]);

    await vi.waitFor(() => {
      expect(vault.view.pins.size).toBe(0);
    }, SETTLE);
  });

  it("keeps a removal made offline across a restart, until the server stops listing it", async () => {
    const vault = new DirectoryVault(dir);
    const offline = started(vault, { unanswered: new Set(["downloads.remove"]) });
    offline.setOnline(true);
    offline.offerPins([ALBUM]);
    offline.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(downloadStatus(offline.getSnapshot(), ALBUM.target)).toMatchObject({
        kind: "downloaded",
      });
    }, SETTLE);

    await offline.remove(ALBUM.target);

    await vi.waitFor(async () => {
      expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(false);
    }, SETTLE);

    // iOS kills the app before the server ever heard of the removal.
    stops.pop()?.();
    const fetched = fetchesOf("t1");
    mutations.length = 0;
    const relaunched = started(vault);
    relaunched.setOnline(true);
    relaunched.offerPins([ALBUM]);
    relaunched.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(mutations).toContainEqual({
        name: "downloads.remove",
        args: { deviceId: "phone", kind: "album", id: "blue-lines" },
      });
    }, SETTLE);

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect(fetchesOf("t1")).toBe(fetched);
    expect(downloadStatus(relaunched.getSnapshot(), ALBUM.target)).toEqual({ kind: "none" });
    relaunched.offerPins([]);

    await vi.waitFor(() => {
      expect(vault.view.removals.size).toBe(0);
    }, SETTLE);
  });

  it("sweeps rows whose file is gone and files no row names when it starts", async () => {
    const lost: StoredCopy = {
      track: SAFE,
      rev: "r1",
      profile: "aac-320",
      file: "audio/t1.r1.aac-320.m4a",
      bytes: 14,
      artHash: null,
    };

    await mkdir(join(dir, "audio"), { recursive: true });
    await writeFile(join(dir, "audio/stray.m4a"), "half a song");
    const vault = new DirectoryVault(dir, { ...emptyVault, copies: new Map([[SAFE.id, lost]]) });
    const sync = started(vault);

    await vi.waitFor(() => {
      expect(sync.getSnapshot().ready).toBe(true);
    }, SETTLE);

    expect(vault.view.copies.size).toBe(0);
    expect(await exists("audio/stray.m4a")).toBe(false);
  });

  it("reports songs that failed and fetches them again on retry", async () => {
    media.serve("/media/stream/t1", "safe from harm", { refusals: [500, 500] });
    const vault = new DirectoryVault(dir);
    const sync = started(vault);
    sync.setOnline(true);
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(downloadStatus(sync.getSnapshot(), ALBUM.target)).toEqual({
        kind: "failed",
        failed: 1,
        total: 2,
      });
    }, SETTLE);

    media.serve("/media/stream/t1", "safe from harm");
    sync.retry(ALBUM.target);

    await vi.waitFor(() => {
      expect(downloadStatus(sync.getSnapshot(), ALBUM.target)).toMatchObject({
        kind: "downloaded",
      });
    }, SETTLE);
  });

  it("counts a song whose row the vault refused as failed, and leaves no file behind", async () => {
    const vault = new DirectoryVault(dir);
    vault.failingCopies = 1;
    const sync = started(vault);
    sync.setOnline(true);
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(trackDownloadState(sync.getSnapshot(), UNFINISHED.id)).toBe("downloaded");
      expect(trackDownloadState(sync.getSnapshot(), SAFE.id)).toBe("failed");
    }, SETTLE);

    expect(await exists("audio/t1.r1.aac-320.m4a")).toBe(false);
    sync.retry(ALBUM.target);

    await vi.waitFor(() => {
      expect(trackDownloadState(sync.getSnapshot(), SAFE.id)).toBe("downloaded");
    }, SETTLE);
  });

  it("opens the vault again later when it can't be read", async () => {
    vi.useFakeTimers();

    try {
      const vault = new DirectoryVault(dir);
      vault.failingLoads = 1;
      const sync = started(vault);
      await vi.advanceTimersByTimeAsync(1000);

      expect(sync.getSnapshot().ready).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      // The second open lists the vault's files on disk, which fake timers don't drive.
      vi.useRealTimers();

      await vi.waitFor(() => {
        expect(sync.getSnapshot().ready).toBe(true);
      }, SETTLE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits without fetching while the server doesn't answer", async () => {
    const sync = started(new DirectoryVault(dir));
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(downloadStatus(sync.getSnapshot(), ALBUM.target)).toEqual({
        kind: "waiting",
        reason: "offline",
      });
    }, SETTLE);

    expect(media.seen).toEqual([]);
  });

  describe("with a retry due", () => {
    const ONE_SONG: DownloadManifest = { pin: ALBUM, entries: MANIFEST.entries.slice(0, 1) };

    /** A sync whose only song failed once, its retry due by the clock it reads. */
    const failedOnce = async (state: { hang: boolean }) => {
      const clock = { now: 1_000_000 };
      const vault = new DirectoryVault(dir);
      const sync = started(vault, { transfer: brokenTransfer(state), now: () => clock.now });
      sync.setOnline(true);
      sync.offerPins([ALBUM]);
      sync.offerManifest(ALBUM.id, ONE_SONG);

      await vi.waitFor(() => {
        expect(trackDownloadState(sync.getSnapshot(), SAFE.id)).toBe("failed");
      }, SETTLE);

      clock.now += 60 * 60_000;

      return { sync, vault, manifest: ONE_SONG };
    };

    it("doesn't spin while it waits for the server", async () => {
      const { sync } = await failedOnce({ hang: false });
      sync.setOnline(false);

      expect(await publishesIn(sync, 300)).toBeLessThan(5);
    });

    it("doesn't spin while the retry is in flight", async () => {
      const state = { hang: false };
      const { sync, manifest } = await failedOnce(state);
      state.hang = true;
      sync.offerManifest(ALBUM.id, manifest);

      await vi.waitFor(() => {
        expect(trackDownloadState(sync.getSnapshot(), SAFE.id)).toBe("downloading");
      }, SETTLE);

      expect(await publishesIn(sync, 300)).toBeLessThan(5);
    });

    it("doesn't spin while it waits for space", async () => {
      const { sync, vault, manifest } = await failedOnce({ hang: false });
      vault.free = 0;
      sync.offerManifest(ALBUM.id, manifest);

      expect(await publishesIn(sync, 300)).toBeLessThan(5);
    });
  });

  it("says it stopped only once a transfer in flight has ended", async () => {
    const ended = { value: false };

    const transfer: Transfer = {
      head: () =>
        Promise.resolve(
          new Response(null, { status: 200, headers: { "Content-Type": "audio/mp4" } }),
        ),
      download: ({ signal }) =>
        new Promise((resolve) => {
          // The platform takes a moment to cancel, as an iOS download task does.
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                ended.value = true;
                resolve(DownloadResult.Broken({ message: "cancelled" }));
              }, 50);
            },
            { once: true },
          );
        }),
    };

    const sync = started(new DirectoryVault(dir), { transfer });
    sync.setOnline(true);
    sync.offerPins([ALBUM]);
    sync.offerManifest(ALBUM.id, MANIFEST);

    await vi.waitFor(() => {
      expect(trackDownloadState(sync.getSnapshot(), SAFE.id)).toBe("downloading");
    }, SETTLE);

    await sync.stop();

    expect(ended.value).toBe(true);
  });

  it("asks the server to download a target to this device", async () => {
    const sync = started(new DirectoryVault(dir));
    await sync.request({ kind: "playlist", id: PlaylistId.make("late-night") });

    expect(mutations).toEqual([
      { name: "downloads.add", args: { deviceId: "phone", kind: "playlist", id: "late-night" } },
    ]);
  });
});
