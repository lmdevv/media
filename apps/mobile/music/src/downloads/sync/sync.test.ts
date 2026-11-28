import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotFound } from "@media/contracts/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMedia } from "./fake-media";
import { AlbumId, ArtistId, LyricsChange, LyricsRevision, TrackId } from "./models";
import type { DownloadManifest, OfflineTrack } from "./models";
import { nodeTransfer } from "./node-transfer";
import { pinIdOf, UNKNOWN_REVISION } from "./plan";
import { downloadStatus } from "./status";
import { DownloadSync } from "./sync";
import type { DownloadsCore, DownloadsSnapshot } from "./sync";
import { applyChange, emptyVault, VaultChange } from "./vault";
import type { KeptLyrics, VaultRows, VaultStore } from "./vault";

/** A gate a test opens: the commits it holds wait on it. */
interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
  /** Whether a commit is waiting on it. */
  waiting: boolean;
  /** Whether a commit it held has been applied. */
  passed: boolean;
}

const gate = (): Gate => {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { opened: promise, open: resolve, waiting: false, passed: false };
};

/** A vault on a temporary directory, its rows in memory. */
class DirectoryVault implements VaultStore {
  view: VaultRows = emptyVault;
  /** Holds the next covers and pins saved until the test opens it. */
  artGate: Gate | null = null;
  pinGate: Gate | null = null;
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  load = (): Promise<VaultRows> => Promise.resolve(this.view);

  commit = async (change: VaultChange): Promise<void> => {
    const held = this.#gateOf(change);

    if (held !== null) {
      held.waiting = true;
      await held.opened;
    }

    this.view = applyChange(this.view, change);

    if (held !== null) held.passed = true;
  };

  #gateOf(change: VaultChange): Gate | null {
    if (VaultChange.$is("PutArt")(change)) return this.artGate;

    if (VaultChange.$is("PutPin")(change)) return this.pinGate;

    return null;
  }

  lyrics = (): Promise<KeptLyrics | null> => Promise.resolve(null);

  files = async (): Promise<ReadonlyArray<string>> => {
    const names = await readdir(this.#dir, { recursive: true, withFileTypes: true });

    return names
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(this.#dir.length + 1));
  };

  uri = (file: string): string => join(this.#dir, file);

  remove = (file: string): Promise<void> => rm(join(this.#dir, file), { force: true });

  size = (file: string): Promise<number | null> =>
    stat(join(this.#dir, file)).then(
      (found) => found.size,
      () => null,
    );

  freeBytes = (): number | null => 64 * 1024 ** 3;
}

class FakeCore implements DownloadsCore {
  readonly kept = new Map<string, string>();
  readonly calls: Array<string> = [];
  readonly gone = new Set<string>();
  readonly #base: string;

  constructor(base: string) {
    this.#base = base;
  }

  keep = (trackId: TrackId): Promise<void> => {
    this.calls.push(`keep:${trackId}`);
    this.kept.set(trackId, this.kept.get(trackId) ?? `rev${trackId}`);

    return Promise.resolve();
  };

  release = (trackId: TrackId): Promise<void> => {
    this.calls.push(`release:${trackId}`);
    this.kept.delete(trackId);

    return Promise.resolve();
  };

  ticket = (trackId: TrackId, profile: string) => {
    this.calls.push(`ticket:${trackId}`);

    if (this.gone.has(trackId)) {
      return Promise.reject(new NotFound({ message: "The song is no longer on the server" }));
    }

    const revision = this.kept.get(trackId);

    if (revision === undefined) return Promise.reject(new Error("not kept"));

    return Promise.resolve({ url: `${this.#base}/song/${trackId}?p=${profile}`, revision });
  };

  resolveUrl = (url: string): string => `${this.#base}${url}`;
}

const song = (id: string, title: string, artUrl: string | null = null): OfflineTrack => ({
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
  artUrl,
});

const ALBUM = { kind: "album", id: AlbumId.make("blue-lines") } as const;

const DETAILS = { title: "Blue Lines", subtitle: "Massive Attack", artUrl: null };

let media: FakeMedia;

let dir: string;

let core: FakeCore;

let vault: DirectoryVault;

let sync: DownloadSync;

beforeEach(async () => {
  media = new FakeMedia();
  core = new FakeCore(await media.listen());
  dir = await mkdtemp(join(tmpdir(), "music-sync-"));
  vault = new DirectoryVault(dir);

  sync = new DownloadSync({
    core,
    vault,
    transfer: nodeTransfer,
    policy: () => ({ profileFor: () => "aac-320" }),
    now: () => 1,
    sleep: () => Promise.resolve(),
  });

  sync.start();
  sync.setOnline(true);
});

afterEach(async () => {
  await sync.stop();
  await media.close();
  await rm(dir, { recursive: true, force: true });
});

const settled = (done: (snapshot: DownloadsSnapshot) => boolean): Promise<DownloadsSnapshot> =>
  new Promise((resolve) => {
    const check = () => {
      const snapshot = sync.getSnapshot();

      if (!done(snapshot)) return;
      stop();
      resolve(snapshot);
    };

    const stop = sync.subscribe(check);
    check();
  });

const manifestOf = (tracks: ReadonlyArray<OfflineTrack>): DownloadManifest => ({
  pin: {
    id: pinIdOf(ALBUM),
    target: ALBUM,
    createdAt: 1,
    available: true,
    ...DETAILS,
    artHash: null,
  },
  entries: tracks.map((track) => ({
    track,
    rev: core.kept.get(track.id) ?? UNKNOWN_REVISION,
    artHash: null,
    state: "fetchable",
  })),
});

const COVER = "/music/art/cover1";

/** The album with its one song and that song's cover, under `title`. */
const withCover = (track: OfflineTrack, title: string): DownloadManifest => ({
  pin: {
    id: pinIdOf(ALBUM),
    target: ALBUM,
    createdAt: 1,
    available: true,
    title,
    subtitle: DETAILS.subtitle,
    artUrl: null,
    artHash: null,
  },
  entries: [
    {
      track,
      rev: core.kept.get(track.id) ?? UNKNOWN_REVISION,
      artHash: "cover1",
      state: "fetchable",
    },
  ],
});

describe("DownloadSync in Low Power Mode", () => {
  it("starts no transfer on its own while it is on, and fetches the rest once it turns off", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.setLowPower(true);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.tracks.get(one.id) === "queued");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(core.calls.filter((call) => call.startsWith("ticket:"))).toEqual([]);
    expect(sync.getSnapshot().copies.size).toBe(0);

    sync.setLowPower(false);
    const done = await settled((snapshot) => snapshot.copies.size === 1);

    expect(done.tracks.get(one.id)).toBe("downloaded");
  });

  it("fetches a download the person starts while it is on", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    sync.setLowPower(true);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));

    const done = await settled((snapshot) => snapshot.copies.size === 1);

    expect(done.tracks.get(one.id)).toBe("downloaded");
  });
});

describe("DownloadSync with Wi-Fi only", () => {
  const SONG = "first song, long enough to send in two halves";

  it("transfers nothing on a metered network, and everything once the phone is off it", async () => {
    const one = song("t1", "Safe from Harm", COVER);

    media.serve("/song/t1", SONG);
    media.serve(COVER, "cover bytes", { contentType: "image/jpeg" });
    sync.setWifiOnly(true);
    sync.setMetered(true);
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), withCover(one, "Blue Lines"));
    const waiting = await settled((snapshot) => snapshot.tracks.get(one.id) === "queued");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(downloadStatus(waiting, ALBUM)).toEqual({ kind: "waiting", reason: "wifi" });
    expect(media.bytesSent).toBe(0);
    expect(core.calls).toEqual([]);

    sync.setMetered(false);
    const done = await settled((snapshot) => snapshot.copies.size === 1);
    await settled(() => vault.view.art.size === 1);

    expect(downloadStatus(done, ALBUM)).toMatchObject({ kind: "downloaded" });
    expect(media.bytesSent).toBe(SONG.length + "cover bytes".length);
  });

  it("holds a song the person retries in Low Power Mode as well", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", SONG);
    sync.setWifiOnly(true);
    sync.setMetered(true);
    sync.setLowPower(true);
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    sync.retry(ALBUM);
    await settled((snapshot) => snapshot.tracks.get(one.id) === "queued");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(media.bytesSent).toBe(0);

    sync.setMetered(false);
    await settled((snapshot) => snapshot.copies.size === 1);

    expect(media.bytesSent).toBe(SONG.length);
  });

  it("transfers on a metered network once the setting is off", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", SONG);
    sync.setWifiOnly(true);
    sync.setMetered(true);
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.tracks.get(one.id) === "queued");
    sync.setWifiOnly(false);
    const done = await settled((snapshot) => snapshot.copies.size === 1);

    expect(done.waitingForWifi).toBe(false);
    expect(media.bytesSent).toBe(SONG.length);
  });

  it("stops a transfer when the phone moves to a metered network, and starts it over on Wi-Fi", async () => {
    const one = song("t1", "Safe from Harm");
    const { promise: rest, resolve: sendRest } = Promise.withResolvers<void>();

    media.serve("/song/t1", SONG, { held: rest });
    sync.setWifiOnly(true);
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.tracks.get(one.id) === "downloading");
    await vi.waitFor(() => {
      expect(media.bytesSent).toBe(Math.floor(SONG.length / 2));
    });

    sync.setMetered(true);
    const stopped = await settled((snapshot) => snapshot.tracks.get(one.id) === "queued");
    sendRest();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(downloadStatus(stopped, ALBUM)).toEqual({ kind: "waiting", reason: "wifi" });
    expect(sync.getSnapshot().copies.size).toBe(0);
    expect(await vault.files()).toEqual([]);

    sync.setMetered(false);
    const done = await settled((snapshot) => snapshot.copies.size === 1);

    expect(done.tracks.get(one.id)).toBe("downloaded");
    expect(media.seen.filter((seen) => seen.method === "GET")).toHaveLength(2);
  });
});

const WORDS = { status: "instrumental" } as const;

const asked = (snapshot: DownloadsSnapshot) =>
  snapshot.lyricsQuestions.flatMap((question) => question.held);

const at = (rev: string) => LyricsRevision.make(rev);

describe("DownloadSync's lyrics questions", () => {
  it("asks only about songs the server's lyrics revision moved past, and keeps a late answer behind", async () => {
    const one = song("t1", "Safe from Harm");
    const two = song("t2", "One Love");

    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one, two]));
    sync.offerKept(
      new Map([
        [one.id, at("s1")],
        [two.id, at("s1")],
      ]),
    );

    expect(asked(await settled((snapshot) => asked(snapshot).length === 2))).toEqual([
      { trackId: one.id, rev: "s1" },
      { trackId: two.id, rev: "s1" },
    ]);

    sync.offerLyrics([
      LyricsChange.cases.Changed.make({ trackId: one.id, rev: at("s1"), lyrics: WORDS }),
      LyricsChange.cases.Changed.make({ trackId: two.id, rev: at("s1"), lyrics: WORDS }),
    ]);
    await settled((snapshot) => snapshot.lyricsQuestions.length === 0);

    sync.offerKept(
      new Map([
        [one.id, at("s1")],
        [two.id, at("s2")],
      ]),
    );
    const moved = await settled((snapshot) => asked(snapshot).length === 1);

    expect(asked(moved)).toEqual([{ trackId: two.id, rev: "s2" }]);

    // The answer to the question asked at s1 lands after the server moved on to s2.
    sync.offerLyrics([
      LyricsChange.cases.Changed.make({ trackId: two.id, rev: at("s1"), lyrics: WORDS }),
    ]);
    await settled(() => vault.view.lyrics.get(two.id)?.rev === "s1");

    expect(asked(sync.getSnapshot())).toEqual([{ trackId: two.id, rev: "s2" }]);
  });
});

describe("DownloadSync's lyrics question objects", () => {
  it("keeps every other bucket's question the same object while one bucket's answers land", async () => {
    const tracks = Array.from({ length: 150 }, (_, index) => song(`t${String(index)}`, "Bulk"));

    sync.setOnline(false);
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf(tracks));
    sync.offerKept(new Map(tracks.map((track) => [track.id, at("s1")])));
    const before = await settled((snapshot) => asked(snapshot).length === tracks.length);
    const [first, ...others] = before.lyricsQuestions;

    expect(others.length).toBeGreaterThan(0);

    sync.offerLyrics(
      (first?.held ?? []).map(({ trackId }) =>
        LyricsChange.cases.Changed.make({ trackId, rev: at("s1"), lyrics: WORDS }),
      ),
    );
    const after = await settled((snapshot) => snapshot.lyricsQuestions.length === others.length);

    expect(after.lyricsQuestions.every((question, index) => question === others[index])).toBe(true);
  });
});

describe("DownloadSync.releaseAll", () => {
  it("releases every song the core keeps here for the account, and stops fetching", async () => {
    const one = song("t1", "Safe from Harm");
    const two = song("t2", "One Love");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.copies.size === 1);
    sync.offerKept(
      new Map([
        [one.id, null],
        [two.id, null],
      ]),
    );
    await sync.releaseAll();

    expect(core.calls.filter((call) => call.startsWith("release:")).toSorted()).toEqual([
      "release:t1",
      "release:t2",
    ]);
    expect(core.kept.size).toBe(0);

    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one, two]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(core.calls.filter((call) => call.startsWith("keep:"))).toEqual(["keep:t1"]);
  });

  it("sends nothing while the server is out of reach", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.copies.size === 1);
    sync.setOnline(false);
    await sync.releaseAll();

    expect(core.calls.filter((call) => call.startsWith("release:"))).toEqual([]);
  });
});

describe("DownloadSync over the core", () => {
  it("keeps each song of a download on the core, fetches it with a ticket, and stores its revision", async () => {
    const one = song("t1", "Safe from Harm");
    const two = song("t2", "One Love");

    media.serve("/song/t1", "first song");
    media.serve("/song/t2", "second song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one, two]));

    const done = await settled((snapshot) => snapshot.copies.size === 2);

    expect(core.calls).toEqual(
      expect.arrayContaining(["keep:t1", "ticket:t1", "keep:t2", "ticket:t2"]),
    );
    expect(vault.view.copies.get(TrackId.make("t1"))?.rev).toBe("revt1");
    expect(downloadStatus(done, ALBUM)).toMatchObject({ kind: "downloaded" });
  });

  it("reads a download queued, not downloaded, until its songs are known", async () => {
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);

    expect(downloadStatus(sync.getSnapshot(), ALBUM)).toMatchObject({ kind: "queued" });
  });

  it("takes the core's revision once it lists the song, without fetching the copy again", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.copies.size === 1);
    sync.offerKept(new Map([[one.id, null]]));
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.copies.size === 1);

    expect(core.calls.filter((call) => call === "ticket:t1")).toHaveLength(1);
  });

  it("releases on the core what no download keeps any more, and deletes its file", async () => {
    const one = song("t1", "Safe from Harm");

    media.serve("/song/t1", "first song");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));
    await settled((snapshot) => snapshot.copies.size === 1);
    sync.offerKept(new Map([[one.id, null]]));
    await sync.remove(ALBUM);
    await settled((snapshot) => snapshot.copies.size === 0 && snapshot.pins.length === 0);
    await settled(() => core.calls.includes("release:t1"));

    // The row goes first, then its file.
    await vi.waitFor(async () => {
      expect(await vault.files()).toEqual([]);
    });
  });

  it("keeps a cover that lands while a plan that saw it missing saves, without fetching it again", async () => {
    const one = song("t1", "Safe from Harm", COVER);
    const landing = gate();
    const saving = gate();

    media.serve("/song/t1", "first song");
    media.serve(COVER, "cover", { contentType: "image/jpeg" });
    // The cover's row waits, so the next plan sees the cover missing.
    vault.artGate = landing;
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), withCover(one, DETAILS.title));
    await vi.waitFor(() => {
      expect(landing.waiting).toBe(true);
    });
    // That plan's own save waits until the cover has landed.
    vault.pinGate = saving;
    sync.offerManifest(pinIdOf(ALBUM), withCover(one, "Blue Lines (Remastered)"));
    await vi.waitFor(() => {
      expect(saving.waiting).toBe(true);
    });
    landing.open();
    await vi.waitFor(() => {
      expect(vault.view.art.size).toBe(1);
    });
    saving.open();
    await vi.waitFor(() => {
      expect(saving.passed).toBe(true);
    });
    // A cover fetch the plan started is aborted here, and an aborted fetch deletes its file.
    await sync.stop();

    expect(vault.view.art.has("cover1")).toBe(true);
    expect(await vault.files()).toContain("art/cover1");
  });

  it("marks a song the core no longer serves as failed, without trying it again at once", async () => {
    const one = song("t1", "Safe from Harm");

    core.gone.add("t1");
    await settled((snapshot) => snapshot.ready);
    await sync.request(ALBUM, DETAILS);
    sync.offerManifest(pinIdOf(ALBUM), manifestOf([one]));

    const failed = await settled((snapshot) => snapshot.tracks.get(one.id) === "failed");

    expect(failed.copies.size).toBe(0);
    expect(core.calls.filter((call) => call === "ticket:t1")).toHaveLength(1);
  });
});
