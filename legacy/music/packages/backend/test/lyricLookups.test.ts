/**
 * LRCLIB lookups through the real functions: which songs playback, downloads, and backfills ask
 * for, how the media service claims and answers them, the remote lyrics setting, and what
 * `lyrics.get` answers while a lookup runs and after.
 */
import { DeviceId, type QueueItemId, TrackId, UserId } from "@music/commands/ids";
import { MISS_RETRY_MS } from "@music/commands/lyric-lookups";
import { UNKNOWN_ARTIST } from "@music/commands/models";
import type { Infer } from "convex/values";
import { Struct } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { StoredLyricSet } from "../convex/lib/lyrics";
import type { lrclibLyricSet } from "../convex/schema";
import {
  MEDIA_SECRET,
  allTracks,
  drainScheduled,
  makeBackend,
  seedLibrary,
  signUp,
  upsertFiles,
} from "./backend";
import type { Backend, SeedFile, User } from "./backend";
import { failureCode } from "./harness";

const DEVICE = DeviceId.make("laptop");

type StoredLrclibSet = Infer<typeof lrclibLyricSet>;

const LOCAL_SYNCED: StoredLyricSet = {
  kind: "main",
  lang: null,
  origin: { _tag: "Sidecar", fileName: "own.lrc", format: "lrc" },
  body: {
    _tag: "Synced",
    lines: [{ text: "Own line", startMs: 1000, endMs: null, words: null, voice: null }],
  },
};

const LOCAL_PLAIN: StoredLyricSet = {
  kind: "main",
  lang: null,
  origin: { _tag: "Embedded", tag: "id3:USLT" },
  body: { _tag: "Plain", text: "Own words" },
};

const lrclibSynced = (recordId: number): StoredLrclibSet => ({
  kind: "main",
  lang: null,
  origin: { _tag: "Lrclib", recordId },
  body: {
    _tag: "Synced",
    lines: [{ text: "LRCLIB line", startMs: 500, endMs: null, words: null, voice: null }],
  },
});

const START = Date.UTC(2026, 9, 1);

const clockAt = (time: number): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(time);
};

afterEach(() => {
  vi.useRealTimers();
});

/** A library of `files` an owner and a member can read, with the member's laptop registered. */
const setup = async (files: ReadonlyArray<SeedFile>) => {
  const backend = makeBackend();
  const owner = await signUp(backend, "owner");
  const member = await signUp(backend, "member");

  const { libraryId } = await owner.music.run("libraries.create", {
    name: "Songs",
    path: "/music/Songs",
    visibility: "shared",
  });

  await upsertFiles(backend, libraryId, files);
  await member.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
  await member.music.run("queue.autoplay", { on: false });

  const tracks = await allTracks(member);

  const id = (title: string): TrackId => {
    const track = tracks.find((candidate) => candidate.title === title);

    if (track === undefined) throw new Error(`No track titled ${title}`);

    return track.id;
  };

  return { backend, owner, member, libraryId, id };
};

const lookups = (backend: Backend) =>
  backend.run(async (ctx) => ctx.db.query("lyricLookups").collect());

const trackDoc = (backend: Backend, trackId: TrackId) =>
  backend.run(async (ctx) => {
    const id = ctx.db.normalizeId("tracks", trackId);

    return id === null ? null : ctx.db.get(id);
  });

const lookupFor = async (backend: Backend, trackId: TrackId): Promise<Doc<"lyricLookups">> => {
  const key = (await trackDoc(backend, trackId))?.lookupKey;

  const row =
    key === undefined
      ? null
      : await backend.run(async (ctx) =>
          ctx.db
            .query("lyricLookups")
            .withIndex("by_key", (q) => q.eq("key", key))
            .unique(),
        );

  if (row === null) throw new Error(`No lookup for ${trackId}`);

  return row;
};

const queue = (backend: Backend) => backend.query(api.media.lyricQueue, { secret: MEDIA_SECRET });

const claim = (backend: Backend, lookupId: Id<"lyricLookups">, workerId = "worker-1") =>
  backend.mutation(api.media.claimLookup, { secret: MEDIA_SECRET, lookupId, workerId });

/** What the media service saves for a lookup. */
type Answer =
  | { kind: "found"; recordId: number; sets: Array<StoredLrclibSet> }
  | { kind: "instrumental"; recordId: number }
  | { kind: "miss" }
  | { kind: "failed" }
  | { kind: "unavailable"; pauseMs: number };

const save = (
  backend: Backend,
  lookupId: Id<"lyricLookups">,
  answer: Answer,
  workerId = "worker-1",
) => backend.mutation(api.media.saveLookup, { secret: MEDIA_SECRET, lookupId, workerId, answer });

/** Claims and answers the lookup for `trackId`, as the media service does. */
const answer = async (backend: Backend, trackId: TrackId, reply: Answer): Promise<void> => {
  const { _id } = await lookupFor(backend, trackId);

  expect(await claim(backend, _id)).not.toBeNull();
  expect(await save(backend, _id, reply)).toEqual({ saved: true });
};

const play = (user: User, trackIds: ReadonlyArray<TrackId>) =>
  user.music.run("playback.play", { trackIds: [...trackIds], deviceId: DEVICE });

const lyricsOf = (user: User, trackId: TrackId) => user.music.read("lyrics.get", { trackId });

const SONGS: ReadonlyArray<SeedFile> = [
  { path: "a.flac", title: "Alpha", artist: "Band" },
  { path: "b.flac", title: "Beta", artist: "Band" },
  { path: "c.flac", title: "Gamma", artist: "Band" },
];

describe("requesting lyrics", () => {
  it("queues the song that starts playing and the next one, most urgent first", async () => {
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta"), id("Gamma")]);

    expect((await queue(backend)).map((entry) => entry.query.title)).toEqual(["Alpha", "Beta"]);
    expect((await queue(backend))[0]?.query).toEqual({
      artist: "Band",
      title: "Alpha",
      album: "Album",
      durationS: 180,
    });

    await member.music.run("playback.next", {});
    expect((await queue(backend)).map((entry) => entry.query.title)).toEqual([
      "Beta",
      "Gamma",
      "Alpha",
    ]);
  });

  it("queues the next song when the player moves on by itself", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta"), id("Gamma")]);
    const { queue: entries } = await member.music.read("queue.list", {});

    // Alpha played to its end.
    clockAt(START + 180_000);

    await member.music.run("playback.report", {
      deviceId: DEVICE,
      index: 1,
      itemId: entries[1]?.itemId,
      positionMs: 1000,
      playing: true,
    });

    expect(await lookups(backend)).toHaveLength(3);
  });

  it("skips songs with synced lyrics of their own, but asks for ones with plain lyrics", async () => {
    const { backend, member, id } = await setup([
      { path: "own.flac", title: "Own", artist: "Band", lyrics: [LOCAL_SYNCED] },
      { path: "plain.flac", title: "Plain", artist: "Band", lyrics: [LOCAL_PLAIN] },
    ]);

    await play(member, [id("Own"), id("Plain")]);

    expect((await queue(backend)).map((entry) => entry.query.title)).toEqual(["Plain"]);
  });

  it("never asks for a song without a title, an artist, or a length", async () => {
    const { backend, member, id } = await setup([
      { path: "untitled.flac", title: "(feat. Someone)", artist: "Band" },
      { path: "silent.flac", title: "Silent", artist: "Band", durationMs: 400 },
    ]);

    await play(member, [id("(feat. Someone)"), id("Silent")]);

    expect(await lookups(backend)).toEqual([]);
  });

  it("asks nothing with remote lyrics off", async () => {
    const { backend, owner, member, id } = await setup(SONGS);

    await owner.music.run("server.update", { remoteLyrics: false });
    expect(await owner.music.read("server.settings", {})).toEqual({
      jamGuestAccounts: false,
      remoteLyrics: false,
    });

    await play(member, [id("Alpha")]);

    expect(await lookups(backend)).toEqual([]);
    expect(await failureCode(owner.music.run("lyrics.backfill", {}))).toBe("conflict");
  });

  it("raises a waiting lookup's priority, never lowers it, and asks once per tag set", async () => {
    const { backend, owner, member, id } = await setup([
      ...SONGS,
      { path: "copy/a.flac", title: "Alpha", artist: "Band" },
    ]);

    await owner.music.run("lyrics.backfill", {});
    await drainScheduled(backend);
    // Two files with the same tags share one lookup.
    expect(await lookups(backend)).toHaveLength(3);

    await play(member, [id("Beta")]);
    const albumId = (await allTracks(member))[0]?.albumId;

    if (albumId === undefined) throw new Error("No album");
    await member.music.run("downloads.add", { deviceId: DEVICE, kind: "album", id: albumId });
    await drainScheduled(backend);

    const priorities = Object.fromEntries(
      (await lookups(backend)).map((row) => [
        row.query.title,
        row.state.status === "queued" ? row.state.priority : row.state.status,
      ]),
    );

    expect(priorities).toEqual({ Alpha: "pin", Beta: "play", Gamma: "pin" });
    expect((await queue(backend)).map((entry) => entry.query.title)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });

  it("asks for a missed song again only when it plays after 30 days", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha")]);
    await answer(backend, id("Alpha"), { kind: "miss" });
    clockAt(START + MISS_RETRY_MS - 60_000);
    await play(member, [id("Alpha")]);
    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("miss");

    clockAt(START + MISS_RETRY_MS + 60_000);
    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("miss");
    await play(member, [id("Alpha")]);
    expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({
      status: "queued",
      priority: "play",
      attempts: 0,
    });
  });

  it("never asks again for lyrics found or an instrumental answer", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);
    await answer(backend, id("Alpha"), { kind: "found", recordId: 1, sets: [lrclibSynced(1)] });
    await answer(backend, id("Beta"), { kind: "instrumental", recordId: 2 });
    clockAt(START + 2 * MISS_RETRY_MS);
    await play(member, [id("Alpha"), id("Beta")]);

    expect(await queue(backend)).toEqual([]);
  });

  it("gives a retagged song a new lookup and leaves the old one", async () => {
    const { backend, member, libraryId, id } = await setup(SONGS);
    expect((await trackDoc(backend, id("Alpha")))?.lookupKey).toBe("v1|band|alpha|album|180");

    await upsertFiles(backend, libraryId, [
      { path: "a.flac", title: "Alpha (Live)", artist: "Band" },
    ]);
    expect((await trackDoc(backend, id("Alpha")))?.lookupKey).toBe(
      "v1|band|alpha (live)|album|180",
    );

    await play(member, [id("Alpha")]);
    await upsertFiles(backend, libraryId, [{ path: "a.flac", title: "Alpha", artist: "Band" }]);
    await play(member, [id("Alpha")]);

    expect((await lookups(backend)).map((row) => row.key).toSorted()).toEqual([
      "v1|band|alpha (live)|album|180",
      "v1|band|alpha|album|180",
    ]);
  });
});

const titles = (entries: ReadonlyArray<{ readonly query: { readonly title: string } }>) =>
  entries.map((entry) => entry.query.title);

const lookupTitles = async (backend: Backend): Promise<ReadonlyArray<string>> =>
  (await lookups(backend)).map((row) => row.query.title).toSorted();

const itemIdOf = async (user: User, title: string): Promise<QueueItemId> => {
  const entry = (await user.music.read("queue.list", {})).queue.find(
    (candidate) => candidate.title === title,
  );

  if (entry === undefined) throw new Error(`${title} is not queued`);

  return entry.itemId;
};

const song = (path: string, title: string, artist = "Shared Artist") => ({
  path,
  title,
  artist,
  album: title,
  genre: "Rock",
});

describe("queue changes that ask for lyrics", () => {
  it("asks for songs added to an empty queue, and for what plays after a resume", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await member.music.run("queue.add", { trackIds: [id("Alpha"), id("Beta"), id("Gamma")] });
    expect(await lookupTitles(backend)).toEqual(["Alpha", "Beta"]);

    await member.music.run("playback.resume", {});
    // Alpha played to its end.
    clockAt(START + 180_000);
    await member.music.run("playback.report", {
      deviceId: DEVICE,
      index: 1,
      itemId: await itemIdOf(member, "Beta"),
      positionMs: 1000,
      playing: true,
    });

    expect(await lookupTitles(backend)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("asks for the songs playing when playback resumes, even where nothing moved", async () => {
    const { backend, owner, member, id } = await setup(SONGS);

    await owner.music.run("server.update", { remoteLyrics: false });
    await play(member, [id("Alpha"), id("Beta"), id("Gamma")]);
    await member.music.run("playback.pause", {});
    await owner.music.run("server.update", { remoteLyrics: true });
    expect(await lookups(backend)).toEqual([]);

    await member.music.run("playback.resume", {});

    expect(titles(await queue(backend))).toEqual(["Alpha", "Beta"]);
  });

  it("asks for the song left playing when the ones before it are removed", async () => {
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta"), id("Gamma")]);
    await member.music.run("queue.remove", { itemId: await itemIdOf(member, "Alpha") });
    await member.music.run("queue.remove", { itemId: await itemIdOf(member, "Beta") });

    expect(await lookupTitles(backend)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("asks for a song added to play next", async () => {
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);
    await member.music.run("queue.add", { trackIds: [id("Gamma")], next: true });

    expect(await lookupTitles(backend)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("asks for the song a new Jam moves on to past one it may not share", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const host = await signUp(backend, "member");
    const alpha = await seedLibrary(backend, owner, { name: "Alpha", count: 0 });
    const delta = await seedLibrary(backend, owner, { name: "Delta", count: 0 });

    // Autoplay picks Delta's songs first, for their artist, then Alpha's, for their genre.
    await upsertFiles(backend, alpha.libraryId, [
      song("Alpha/0.flac", "Alpha song 0"),
      ...Array.from({ length: 6 }, (_, index) =>
        song(`Alpha/${String(index + 1)}.flac`, `Alpha song ${String(index + 1)}`, "Alpha Artist"),
      ),
    ]);
    await upsertFiles(backend, delta.libraryId, [
      song("Delta/1.flac", "Delta song 1"),
      song("Delta/2.flac", "Delta song 2"),
    ]);
    await owner.music.run("libraries.update", {
      libraryId: delta.libraryId,
      visibility: "restricted",
    });
    await owner.music.run("libraries.grant", {
      libraryId: delta.libraryId,
      userId: UserId.make(host.id),
    });
    await host.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });

    const tracks = await allTracks(host);
    const alphaSong = tracks.find((track) => track.title === "Alpha song 0");

    if (alphaSong === undefined) throw new Error("No Alpha song 0");
    // Off until the Jam starts, so only the Jam can have asked for the song it moves on to: the
    // Jam picks its autoplay songs afresh, and may pick the one that was next before it.
    await owner.music.run("server.update", { remoteLyrics: false });
    await play(host, [alphaSong.id]);

    const deltaEntries = (await host.music.read("queue.list", {})).queue.filter(
      (entry) => entry.autoplay && entry.title.startsWith("Delta"),
    );

    const last = deltaEntries.at(-1);

    if (last === undefined) throw new Error("Autoplay picked nothing from Delta");
    await host.music.run("playback.jump", { itemId: last.itemId });
    await owner.music.run("server.update", { remoteLyrics: true });
    expect(await lookups(backend)).toEqual([]);

    await host.music.run("jam.start", {});

    const state = await host.music.read("playback.state", {});
    const playing = state.queue[state.index]?.title;

    expect(playing?.startsWith("Alpha")).toBe(true);
    expect(await lookupTitles(backend)).toContain(playing);
  });

  it("puts the song playing now first, ahead of songs that played before", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);
    clockAt(START + 1000);
    await play(member, [id("Gamma"), id("Alpha")]);

    expect(titles(await queue(backend))).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("never asks for a song by the scanner's unknown artist", async () => {
    const { backend, member, id } = await setup([
      { path: "untagged.flac", title: "Track 01", artist: UNKNOWN_ARTIST },
    ]);

    await play(member, [id("Track 01")]);

    expect(await lookups(backend)).toEqual([]);
  });

  it("marks songs with synced lyrics of their own when scanned and in a migration", async () => {
    const { backend, member, id } = await setup([
      { path: "own.flac", title: "Own", artist: "Band", lyrics: [LOCAL_SYNCED] },
      { path: "plain.flac", title: "Plain", artist: "Band", lyrics: [LOCAL_PLAIN] },
    ]);

    expect((await trackDoc(backend, id("Own")))?.lyricsSynced).toBe(true);
    expect((await trackDoc(backend, id("Plain")))?.lyricsSynced).toBe(false);

    // A song scanned before the flag existed.
    await backend.run(async (ctx) => {
      const track = ctx.db.normalizeId("tracks", id("Own"));

      if (track !== null) await ctx.db.patch(track, { lyricsSynced: undefined });
    });
    await backend.mutation(internal.migrations.run, {});
    await drainScheduled(backend);

    expect((await trackDoc(backend, id("Own")))?.lyricsSynced).toBe(true);
    await play(member, [id("Own"), id("Plain")]);
    expect(titles(await queue(backend))).toEqual(["Plain"]);
  });
});

describe("downloads asking for lyrics", () => {
  it("schedules nothing with remote lyrics off", async () => {
    const { backend, owner, member, id } = await setup(SONGS);

    await owner.music.run("server.update", { remoteLyrics: false });
    await member.music.run("downloads.add", { deviceId: DEVICE, kind: "track", id: id("Alpha") });

    const scheduled = await backend.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(scheduled.filter((job) => job.name.includes("lyricLookups"))).toEqual([]);
  });

  it(
    "asks for every song of an album too big to read in one transaction",
    { timeout: 60_000 },
    async () => {
      const { backend, member } = await setup([{ path: "seed.flac", title: "Seed" }]);
      const count = 5503;

      const seed = await backend.run(async (ctx) =>
        ctx.db
          .query("tracks")
          .filter((q) => q.eq(q.field("path"), "seed.flac"))
          .unique(),
      );

      if (seed === null) throw new Error("No seed track");
      const fields = Struct.omit(seed, ["_id", "_creationTime"]);
      const longFolder = "Long Folder Name ".repeat(170);

      await Array.from({ length: Math.ceil(count / 500) }, (_, batch) => batch).reduce(
        async (previous, batch) => {
          await previous;
          await backend.run(async (ctx) => {
            await Promise.all(
              Array.from({ length: Math.min(500, count - batch * 500) }, async (_, offset) => {
                const number = String(batch * 500 + offset).padStart(5, "0");

                await ctx.db.insert("tracks", {
                  ...fields,
                  path: `${longFolder}/${number}.flac`,
                  title: `Song ${number}`,
                  titleKey: `song ${number}`,
                  lookupKey: `v1|artist|song ${number}|album|180`,
                });
              }),
            );
          });
        },
        Promise.resolve(),
      );

      await member.music.run("downloads.add", {
        deviceId: DEVICE,
        kind: "album",
        id: seed.albumId,
      });
      await drainScheduled(backend);

      expect(await lookups(backend)).toHaveLength(count + 1);
    },
  );
});

describe("the media service", () => {
  it("claims a lookup once, and saves only under its own lease", async () => {
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha")]);
    const { _id } = await lookupFor(backend, id("Alpha"));

    expect(await claim(backend, _id, "worker-1")).toMatchObject({ lookupId: _id });
    expect(await claim(backend, _id, "worker-2")).toBeNull();
    expect(await queue(backend)).toEqual([]);
    expect(await save(backend, _id, { kind: "miss" }, "worker-2")).toEqual({ saved: false });
    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("leased");
  });

  it("queues a lookup again when its lease runs out, and drops the late answer", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha")]);
    const { _id } = await lookupFor(backend, id("Alpha"));

    await claim(backend, _id);
    clockAt(START + 61_000);
    await backend.mutation(internal.lyricLookups.releaseExpiredLeases, {});

    expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(await save(backend, _id, { kind: "miss" })).toEqual({ saved: false });
  });

  it("waits after a failed try, queues it again when due, and gives up after five", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha")]);
    const { _id } = await lookupFor(backend, id("Alpha"));

    await claim(backend, _id);
    await save(backend, _id, { kind: "failed" });

    expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({
      status: "waiting",
      attempts: 1,
      retryAt: START + 60_000,
    });
    expect(await queue(backend)).toEqual([]);

    const scheduled = await backend.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(
      scheduled.filter((job) => job.name.includes("requeue")).map((job) => job.scheduledTime),
    ).toEqual([START + 60_000]);

    const requeue = () => backend.mutation(internal.lyricLookups.requeue, { lookupId: _id });

    // A retry that runs early, as a stale one could, leaves the lookup waiting.
    await requeue();
    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("waiting");

    clockAt(START + 60_000);
    await requeue();
    expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({
      status: "queued",
      attempts: 1,
    });

    const failAgain = async (): Promise<void> => {
      await claim(backend, _id);
      await save(backend, _id, { kind: "failed" });
      const state = (await lookupFor(backend, id("Alpha"))).state;

      if (state.status === "waiting") clockAt(state.retryAt);
      await requeue();
    };

    await failAgain();
    await failAgain();
    await failAgain();
    expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({ attempts: 4 });
    await failAgain();

    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("miss");
  });

  it("pauses every lookup while LRCLIB is unavailable, without counting a try", async () => {
    clockAt(START);
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);
    const alpha = (await lookupFor(backend, id("Alpha")))._id;
    const beta = (await lookupFor(backend, id("Beta")))._id;

    const scheduledEnds = async () =>
      (
        await backend.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())
      ).flatMap((job) =>
        job.name.includes("endPause") && job.state.kind === "pending" ? [job.scheduledTime] : [],
      );

    // LRCLIB stays down for longer than a lookup has tries.
    await [1, 2, 3, 4, 5, 6].reduce(async (previous, round) => {
      await previous;
      expect(await claim(backend, alpha)).not.toBeNull();
      expect(await save(backend, alpha, { kind: "unavailable", pauseMs: 30_000 })).toEqual({
        saved: true,
      });

      expect((await lookupFor(backend, id("Alpha"))).state).toMatchObject({
        status: "queued",
        attempts: 0,
      });
      expect(await queue(backend)).toEqual([]);
      expect(await claim(backend, beta)).toBeNull();

      const pausedUntil = START + round * 30_000;

      expect(await scheduledEnds()).toContain(pausedUntil);

      // A service restarted mid-pause still sees nothing to claim.
      clockAt(pausedUntil - 1);
      await backend.mutation(internal.lyricLookups.endPause, {});
      expect(await queue(backend)).toEqual([]);

      clockAt(pausedUntil);
      await backend.mutation(internal.lyricLookups.endPause, {});
      expect(titles(await queue(backend))).toEqual(["Alpha", "Beta"]);
    }, Promise.resolve());
  });

  it("saves a miss for found lyrics it cannot store", async () => {
    const { backend, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);

    const unreadable: StoredLrclibSet = {
      ...lrclibSynced(1),
      body: { _tag: "Synced", lines: [] },
    };

    const huge: StoredLrclibSet = {
      ...lrclibSynced(2),
      body: { _tag: "Plain", text: "la ".repeat(400_000) },
    };

    await answer(backend, id("Alpha"), { kind: "found", recordId: 1, sets: [unreadable] });
    await answer(backend, id("Beta"), { kind: "found", recordId: 2, sets: [huge] });

    expect((await lookupFor(backend, id("Alpha"))).state.status).toBe("miss");
    expect((await lookupFor(backend, id("Beta"))).state.status).toBe("miss");
    expect(await backend.run(async (ctx) => ctx.db.query("lrclibLyrics").collect())).toEqual([]);
  });

  it("sees no queue with remote lyrics off, while answers already found still show", async () => {
    const { backend, owner, member, id } = await setup(SONGS);

    await play(member, [id("Alpha"), id("Beta")]);
    await answer(backend, id("Alpha"), { kind: "found", recordId: 7, sets: [lrclibSynced(7)] });
    await owner.music.run("server.update", { remoteLyrics: false });

    expect(await queue(backend)).toEqual([]);
    expect(await claim(backend, (await lookupFor(backend, id("Beta")))._id)).toBeNull();
    expect(await lyricsOf(member, id("Alpha"))).toMatchObject({ _tag: "Synced", source: "lrclib" });
    // Beta is still queued, but nothing will ask for it while lookups are off.
    expect(await lyricsOf(member, id("Beta"))).toEqual({ _tag: "None" });

    await owner.music.run("server.update", { remoteLyrics: true });
    expect((await queue(backend)).map((entry) => entry.query.title)).toEqual(["Beta"]);
  });
});

describe("lyrics.get with LRCLIB", () => {
  it("is pending while a lookup runs, with the song's own plain lyrics meanwhile", async () => {
    const { backend, member, id } = await setup([
      { path: "plain.flac", title: "Plain", artist: "Band", lyrics: [LOCAL_PLAIN] },
      { path: "none.flac", title: "Bare", artist: "Band" },
    ]);

    expect(await lyricsOf(member, id("Bare"))).toEqual({ _tag: "None" });
    await play(member, [id("Plain"), id("Bare")]);

    expect(await lyricsOf(member, id("Bare"))).toEqual({ _tag: "Pending", fallback: null });
    expect(await lyricsOf(member, id("Plain"))).toEqual({ _tag: "Pending", fallback: LOCAL_PLAIN });

    await claim(backend, (await lookupFor(backend, id("Bare")))._id);
    expect(await lyricsOf(member, id("Bare"))).toEqual({ _tag: "Pending", fallback: null });
  });

  it("prefers LRCLIB's synced lyrics to the song's plain ones, and its own synced to both", async () => {
    const { backend, member } = await setup([
      { path: "plain.flac", title: "Song", artist: "Band", lyrics: [LOCAL_PLAIN] },
      { path: "copy.flac", title: "Song", artist: "Band", lyrics: [LOCAL_SYNCED] },
    ]);

    const [plainId, syncedId] = await Promise.all(
      ["plain.flac", "copy.flac"].map(async (path) => {
        const track = await backend.run(async (ctx) =>
          ctx.db
            .query("tracks")
            .filter((q) => q.eq(q.field("path"), path))
            .unique(),
        );

        if (track === null) throw new Error(`No track at ${path}`);

        return TrackId.make(track._id);
      }),
    );

    if (plainId === undefined || syncedId === undefined) throw new Error("Tracks missing");

    await play(member, [plainId]);
    await answer(backend, plainId, { kind: "found", recordId: 3, sets: [lrclibSynced(3)] });

    expect(await lyricsOf(member, plainId)).toEqual({
      _tag: "Synced",
      source: "lrclib",
      main: lrclibSynced(3),
      extras: [],
    });
    // The same tags share the lookup, but the song's own synced lyrics win.
    expect(await lyricsOf(member, syncedId)).toMatchObject({ _tag: "Synced", source: "file" });
  });

  it("answers instrumental only for a song without lyrics of its own, and none after a miss", async () => {
    const { backend, member, id } = await setup([
      { path: "plain.flac", title: "Plain", artist: "Band", lyrics: [LOCAL_PLAIN] },
      { path: "bare.flac", title: "Bare", artist: "Band" },
      { path: "lost.flac", title: "Lost", artist: "Band" },
    ]);

    await play(member, [id("Plain"), id("Bare"), id("Lost")]);
    await answer(backend, id("Plain"), { kind: "instrumental", recordId: 4 });
    await answer(backend, id("Bare"), { kind: "instrumental", recordId: 5 });
    await member.music.run("playback.next", {});
    await answer(backend, id("Lost"), { kind: "miss" });

    expect(await lyricsOf(member, id("Plain"))).toMatchObject({ _tag: "Plain", source: "file" });
    expect(await lyricsOf(member, id("Bare"))).toEqual({ _tag: "Instrumental" });
    expect(await lyricsOf(member, id("Lost"))).toEqual({ _tag: "None" });
  });
});

describe("lyrics.backfill", () => {
  it("asks for every song of every library the admin can read, a page at a time", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");

    await seedLibrary(backend, owner, { name: "Big", count: 450 });
    await seedLibrary(backend, owner, { name: "Small", count: 3 });

    expect(await owner.music.run("lyrics.backfill", {})).toEqual({ libraries: 2 });
    await drainScheduled(backend);

    const rows = await lookups(backend);

    expect(rows).toHaveLength(453);
    expect(new Set(rows.map((row) => row.state.status === "queued" && row.state.priority))).toEqual(
      new Set(["backfill"]),
    );
  });

  it("is for admins only", async () => {
    const { member } = await setup(SONGS);

    expect(await failureCode(member.music.run("lyrics.backfill", {}))).toBe("forbidden");
  });
});
