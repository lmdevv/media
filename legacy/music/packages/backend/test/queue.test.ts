/**
 * Queue entries with their own IDs, through the real dispatcher: moves, edits from two devices at
 * once, queues stored before entries had IDs, and autoplay.
 */
import { DeviceId, QueueItemId } from "@music/commands/ids";
import type { TrackId } from "@music/commands/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import {
  allTracks,
  drainScheduled,
  makeBackend,
  seedLibrary,
  signUp,
  trackIds,
  upsertFiles,
} from "./backend";
import type { Backend, User } from "./backend";
import { failureCode } from "./harness";

const DEVICE = DeviceId.make("test-device");

const START = 1_800_000_000_000;

const setup = async () => {
  const backend = makeBackend();
  const admin = await signUp(backend, "admin");
  await seedLibrary(backend, admin, { name: "Rock", count: 5 });
  await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
  // These tests are about the queue people build; autoplay has its own.
  await admin.music.run("queue.autoplay", { on: false });

  return { backend, admin, rock: trackIds(await allTracks(admin), "Rock") };
};

const entries = async (user: User) => (await user.music.read("queue.list", {})).queue;

const songs = async (user: User): Promise<ReadonlyArray<TrackId>> =>
  (await entries(user)).map((entry) => entry.id);

const itemAt = async (user: User, position: number): Promise<QueueItemId> => {
  const entry = (await entries(user))[position];

  if (entry === undefined) throw new Error(`No queue entry at ${position}`);

  return entry.itemId;
};

const current = async (user: User): Promise<TrackId | undefined> => {
  const { queue, index } = await user.music.read("queue.list", {});

  return queue[index]?.id;
};

const pick = <Item>(list: ReadonlyArray<Item>, position: number): Item => {
  const item = list[position];

  if (item === undefined) throw new Error(`Nothing at ${position}`);

  return item;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("moving entries", () => {
  it("moves an entry after another, or to the top, keeping the song that plays", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 1, deviceId: DEVICE });

    await admin.music.run("queue.move", {
      itemId: await itemAt(admin, 4),
      afterItemId: await itemAt(admin, 1),
    });

    expect(await songs(admin)).toEqual([0, 1, 4, 2, 3].map((position) => pick(rock, position)));
    expect(await current(admin)).toBe(pick(rock, 1));

    await admin.music.run("queue.move", { itemId: await itemAt(admin, 1) });
    expect(await songs(admin)).toEqual([1, 0, 4, 2, 3].map((position) => pick(rock, position)));
    // The playing entry moved to the top; it still plays.
    expect(await current(admin)).toBe(pick(rock, 1));
    expect((await admin.music.read("queue.list", {})).index).toBe(0);
  });

  it("refuses to move an entry after itself or after one that is gone", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    const [first, second] = [await itemAt(admin, 0), await itemAt(admin, 1)];

    expect(
      await failureCode(admin.music.run("queue.move", { itemId: second, afterItemId: second })),
    ).toBe("invalid_args");

    await admin.music.run("queue.remove", { itemId: first });
    expect(
      await failureCode(admin.music.run("queue.move", { itemId: second, afterItemId: first })),
    ).toBe("not_found");
  });

  it("keeps a move made while shuffled once shuffle ends", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await admin.music.run("playback.shuffle", { on: true });
    const moved = pick(await songs(admin), 4);

    // "Play this right after the current song", made in the shuffled order.
    await admin.music.run("queue.move", {
      itemId: await itemAt(admin, 4),
      afterItemId: await itemAt(admin, 0),
    });
    await admin.music.run("playback.shuffle", { on: false });

    expect(await songs(admin)).toEqual([
      pick(rock, 0),
      moved,
      ...rock.slice(1).filter((id) => id !== moved),
    ]);
  });
});

describe("two devices editing the queue at once", () => {
  it("acts on the entry each device saw, wherever it moved", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    // The phone shows the queue and the user picks the fourth song to remove...
    const phoneSaw = await entries(admin);
    const target = pick(phoneSaw, 3);

    // ...while the laptop adds a song to play next, shifting every index after the first.
    await admin.music.run("queue.add", { trackIds: [pick(rock, 4)], next: true });
    await admin.music.run("queue.remove", { itemId: target.itemId });

    expect(await songs(admin)).toEqual([0, 4, 1, 2, 4].map((position) => pick(rock, position)));
    expect((await entries(admin)).map((entry) => entry.itemId)).not.toContain(target.itemId);
  });

  it("fails rather than guess when the entry is already gone", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    const stale = await itemAt(admin, 2);

    await admin.music.run("queue.remove", { itemId: stale });
    const before = await songs(admin);

    expect(await failureCode(admin.music.run("queue.remove", { itemId: stale }))).toBe("not_found");
    expect(await failureCode(admin.music.run("playback.jump", { itemId: stale }))).toBe(
      "not_found",
    );
    expect(await songs(admin)).toEqual(before);
  });

  it("gives the same song queued twice two entries", async () => {
    const { admin, rock } = await setup();
    const song = pick(rock, 0);
    await admin.music.run("playback.play", { trackIds: [song, song, song], deviceId: DEVICE });
    const ids = (await entries(admin)).map((entry) => entry.itemId);

    expect(new Set(ids).size).toBe(3);
    await admin.music.run("queue.remove", { itemId: pick(ids, 1) });
    expect((await entries(admin)).map((entry) => entry.itemId)).toEqual([
      pick(ids, 0),
      pick(ids, 2),
    ]);
  });

  it("never reuses an entry ID, even after the queue is replaced", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    const old = await itemAt(admin, 1);

    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    expect((await entries(admin)).map((entry) => entry.itemId)).not.toContain(old);
    expect(await failureCode(admin.music.run("queue.remove", { itemId: old }))).toBe("not_found");
  });

  it("records who added each entry", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    expect((await entries(admin)).map((entry) => entry.addedBy?.id)).toEqual(
      rock.map(() => admin.id),
    );
  });
});

/** A queue row as versions before entry IDs stored it: song IDs only. */
const legacyRow = async (backend: Backend, admin: User, rock: ReadonlyArray<TrackId>) => {
  await backend.run(async (ctx) => {
    const ids = rock.flatMap((id) => {
      const normalised = ctx.db.normalizeId("tracks", id);

      return normalised === null ? [] : [normalised];
    });

    const existing = await ctx.db
      .query("playbackQueues")
      .withIndex("by_user", (q) => q.eq("userId", admin.id))
      .unique();

    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("playbackQueues", {
      userId: admin.id,
      queue: ids,
      unshuffled: [...ids].toReversed(),
      index: 1,
      shuffle: true,
      repeat: "off",
    });
  });
};

describe("a queue stored before entries had IDs", () => {
  it("numbers its entries the same way before and after the migration", async () => {
    const { backend, admin, rock } = await setup();
    await legacyRow(backend, admin, rock);
    const before = (await entries(admin)).map((entry) => entry.itemId);

    expect(before).toEqual(["1", "2", "3", "4", "5"]);
    expect(await current(admin)).toBe(pick(rock, 1));

    await backend.mutation(internal.migrations.run, {});
    await drainScheduled(backend);

    const rows = await backend.run(async (ctx) => ctx.db.query("playbackQueues").collect());

    expect(rows.map((row) => [row.queue, row.items?.length, row.unshuffledItems])).toEqual([
      [undefined, 5, ["5", "4", "3", "2", "1"]],
    ]);
    expect((await entries(admin)).map((entry) => entry.itemId)).toEqual(before);

    // The ID a client read before the migration still names the same entry.
    await admin.music.run("queue.remove", { itemId: QueueItemId.make("3") });
    expect(await songs(admin)).toEqual([0, 1, 3, 4].map((position) => pick(rock, position)));

    // The old unshuffled order still applies.
    await admin.music.run("playback.shuffle", { on: false });
    expect(await songs(admin)).toEqual([4, 3, 1, 0].map((position) => pick(rock, position)));
  });

  it("converts on the next write and numbers new entries after the old ones", async () => {
    const { backend, admin, rock } = await setup();
    await legacyRow(backend, admin, rock);

    const { itemIds } = await admin.music.run("queue.add", { trackIds: [pick(rock, 0)] });

    expect(itemIds).toEqual(["6"]);
  });
});

const file = (path: string, artist: string, album: string, genre: string, year: number) => ({
  path,
  title: path,
  artist,
  album,
  genre,
  year,
});

/**
 * A library where "Seed" has two songs on a rock album from 1999 and one on a jazz album from
 * 2010, "Genre Mate" shares the rock genre, "Era Mate" was released a year later in another
 * genre, and "Stranger" shares nothing.
 */
const catalog = async () => {
  const backend = makeBackend();
  const admin = await signUp(backend, "admin");
  const { libraryId } = await seedLibrary(backend, admin, { name: "Lib", count: 0 });

  await upsertFiles(backend, libraryId, [
    file("seed-1", "Seed", "First", "Rock", 1999),
    file("seed-2", "Seed", "First", "Rock", 1999),
    file("seed-3", "Seed", "Second", "Jazz", 2010),
    file("genre-1", "Genre Mate", "Mates", "Rock", 1980),
    file("era-1", "Era Mate", "Era", "Pop", 2000),
    file("stranger-1", "Stranger", "Far", "Folk", 1960),
  ]);

  await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
  const tracks = await allTracks(admin);

  const id = (title: string): TrackId => {
    const track = tracks.find((candidate) => candidate.title === title);

    if (track === undefined) throw new Error(`No song ${title}`);

    return track.id;
  };

  return { backend, admin, id };
};

const autoplayTitles = async (user: User) =>
  (await entries(user)).filter((entry) => entry.autoplay).map((entry) => entry.title);

describe("autoplay", () => {
  it("follows the last song with the same artist, then genre, then era, and nothing else", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });
    const added = await autoplayTitles(admin);

    expect(added.slice(0, 2).toSorted()).toEqual(["seed-2", "seed-3"]);
    expect(added.slice(2)).toEqual(["genre-1", "era-1"]);
    expect((await entries(admin)).filter((entry) => entry.autoplay).map((e) => e.addedBy)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("waits until the last song people queued, and keeps queued songs before it", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("playback.play", {
      trackIds: [id("stranger-1"), id("seed-1")],
      deviceId: DEVICE,
    });
    expect(await autoplayTitles(admin)).toEqual([]);

    await admin.music.run("playback.next", {});
    expect((await autoplayTitles(admin)).length).toBeGreaterThan(0);

    // A song added "to the end" plays before autoplay's.
    await admin.music.run("queue.add", { trackIds: [id("seed-2")] });
    const queue = await entries(admin);
    const firstAutoplay = queue.findIndex((entry) => entry.autoplay);

    expect(pick(queue, firstAutoplay - 1).title).toBe("seed-2");
  });

  it("keeps playing at the end of the queue, skipping recently played songs", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("queue.autoplay", { on: false });
    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });
    // seed-2 was played a moment ago.
    await admin.music.run("playback.play", { trackIds: [id("seed-2")], deviceId: DEVICE });
    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 0,
      positionMs: 1000,
      playing: true,
    });
    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });
    await admin.music.run("queue.autoplay", { on: true });

    expect(await autoplayTitles(admin)).not.toContain("seed-2");

    await admin.music.run("playback.next", {});
    const state = await admin.music.read("playback.state", {});

    expect(state.playing).toBe(true);
    expect(state.queue[state.index]?.autoplay).toBe(true);
  });

  it("stops at the end and takes autoplay's songs out when turned off", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });
    await admin.music.run("queue.autoplay", { on: false });

    expect(await autoplayTitles(admin)).toEqual([]);
    expect((await admin.music.read("queue.list", {})).autoplay).toBe(false);

    await admin.music.run("playback.next", {});
    expect((await admin.music.read("playback.state", {})).playing).toBe(false);
  });

  it("has a song ready after the current one however the queue was changed by hand", async () => {
    const { admin, id } = await catalog();

    // Added to an empty queue: the player can preload what comes after it. The result still
    // says `ok`, as clients from before entry IDs read it.
    expect(await admin.music.run("queue.add", { trackIds: [id("seed-1")] })).toMatchObject({
      ok: true,
    });
    expect((await autoplayTitles(admin)).length).toBeGreaterThan(0);

    await admin.music.run("queue.clear", {});
    expect((await autoplayTitles(admin)).length).toBeGreaterThan(0);

    // Removing the songs after the current one leaves it last.
    await admin.music.run("playback.play", {
      trackIds: [id("seed-1"), id("stranger-1")],
      deviceId: DEVICE,
    });
    expect(await autoplayTitles(admin)).toEqual([]);
    await admin.music.run("queue.remove", { itemId: pick(await entries(admin), 1).itemId });
    expect((await autoplayTitles(admin)).length).toBeGreaterThan(0);
  });

  it("looks in the seed's own library first when the listener reads many", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");

    // 24 libraries with nothing alike come first, then the seed's.
    await Array.from({ length: 24 }, (_, index) => index).reduce(async (previous, index) => {
      await previous;
      await seedLibrary(backend, admin, { name: `Empty${String(index)}`, count: 0 });
    }, Promise.resolve());

    const { libraryId } = await seedLibrary(backend, admin, { name: "Last", count: 0 });

    await upsertFiles(backend, libraryId, [
      file("seed-1", "Seed", "First", "Rock", 1999),
      file("genre-1", "Genre Mate", "Mates", "Rock", 1980),
    ]);
    await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
    const seed = (await allTracks(admin)).find((track) => track.title === "seed-1");

    if (seed === undefined) throw new Error("No seed song");
    await admin.music.run("playback.play", { trackIds: [seed.id], deviceId: DEVICE });

    expect(await autoplayTitles(admin)).toContain("genre-1");
  });

  it("stays out of the way of repeat", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("playback.repeat", { mode: "all" });
    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });

    expect(await autoplayTitles(admin)).toEqual([]);
  });

  it("keeps autoplay's songs last when shuffle turns on", async () => {
    const { admin, id } = await catalog();

    await admin.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });
    await admin.music.run("queue.add", { trackIds: [id("stranger-1"), id("era-1")] });
    await admin.music.run("playback.shuffle", { on: true });

    const flags = (await entries(admin)).map((entry) => entry.autoplay);
    const firstAutoplay = flags.indexOf(true);

    expect(firstAutoplay).toBe(3);
    expect(flags.slice(firstAutoplay).every(Boolean)).toBe(true);
  });

  it("finds same-genre songs past many albums the listener can't read", async () => {
    const { backend, admin, id } = await catalog();
    const member = await signUp(backend, "member");

    const { libraryId } = await seedLibrary(backend, admin, {
      name: "Vault",
      count: 0,
      visibility: "private",
    });

    // More same-genre albums than one library step reads, all in a library the member can't read.
    await upsertFiles(
      backend,
      libraryId,
      Array.from({ length: 30 }, (_, index) =>
        file(`vault-${index}`, `Vault ${index}`, `Vault ${index}`, "Rock", 1990),
      ),
    );
    await member.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Phone", kind: "web" });
    // A rock song whose artist has nothing else, so autoplay reaches the genre step.
    await member.music.run("playback.play", { trackIds: [id("genre-1")], deviceId: DEVICE });

    const titles = await autoplayTitles(member);

    expect(titles).toContain("seed-1");
    expect(titles.some((title) => title.startsWith("vault"))).toBe(false);
  });

  it("only picks songs the listener can read", async () => {
    const { backend, admin, id } = await catalog();
    const member = await signUp(backend, "member");

    const { libraryId } = await seedLibrary(backend, admin, {
      name: "Hidden",
      count: 0,
      visibility: "private",
    });

    await upsertFiles(backend, libraryId, [
      { path: "hidden-1", title: "hidden-1", artist: "Seed", album: "Secret" },
    ]);
    await member.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Phone", kind: "web" });
    await member.music.run("playback.play", { trackIds: [id("seed-1")], deviceId: DEVICE });

    expect(await autoplayTitles(member)).not.toContain("hidden-1");
    expect(await autoplayTitles(member)).toContain("seed-2");
  });
});
