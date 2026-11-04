import { DeviceId, QueueItemId } from "@music/commands/ids";
import type { TrackId } from "@music/commands/ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import { playbackMutations, playbackQueries } from "../convex/handlers/playback";
import { loadViewer } from "../convex/lib/viewer";
import { failureCode } from "./harness";
import {
  allTracks,
  drainScheduled,
  makeBackend,
  markMissing,
  seedLibrary,
  signUp,
  trackIds,
  upsertFiles,
} from "./backend";
import type { Backend, User } from "./backend";

const DEVICE = DeviceId.make("test-device");

const START = 1_800_000_000_000;

interface Fixture {
  readonly backend: Backend;
  readonly admin: User;
  readonly rock: ReadonlyArray<TrackId>;
}

const setup = async (): Promise<Fixture> => {
  const backend = makeBackend();
  const admin = await signUp(backend, "admin");
  await seedLibrary(backend, admin, { name: "Rock", count: 5 });
  await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });

  return { backend, admin, rock: trackIds(await allTracks(admin), "Rock") };
};

const queueIds = async (user: User): Promise<ReadonlyArray<TrackId>> =>
  (await user.music.read("playback.state", {})).queue.map((track) => track.id);

const itemAt = async (user: User, position: number): Promise<QueueItemId> => {
  const entry = (await user.music.read("queue.list", {})).queue[position];

  if (entry === undefined) throw new Error(`No queue entry at ${position}`);

  return entry.itemId;
};

const current = async (user: User): Promise<TrackId | undefined> => {
  const { queue, index } = await user.music.read("playback.state", {});

  return queue[index]?.id;
};

const history = async (user: User): Promise<ReadonlyArray<TrackId>> =>
  (await user.music.read("history.list", { limit: 200 })).map((entry) => entry.track.id);

const at = (index: number, list: ReadonlyArray<TrackId>): TrackId => {
  const id = list[index];

  if (id === undefined) throw new Error(`No song at ${index}`);

  return id;
};

const mixed = async () => {
  const fixture = await setup();
  const { backend, admin, rock } = fixture;
  const jazzLibrary = await seedLibrary(backend, admin, { name: "Jazz", count: 3 });
  const jazz = trackIds(await allTracks(admin), "Jazz");
  const queue = [at(0, rock), at(0, jazz), at(1, rock), at(1, jazz), at(2, rock), at(2, jazz)];

  await admin.music.run("playback.play", { trackIds: queue, index: 3, deviceId: DEVICE });
  const items = (await admin.music.read("queue.list", {})).queue.map((entry) => entry.itemId);
  await admin.music.run("libraries.delete", { libraryId: jazzLibrary.libraryId });

  return { ...fixture, jazz, items };
};

const report = async (user: User, index: number, positionMs: number, playing = true) => {
  const state = await user.music.read("playback.state", {});

  return user.music.run("playback.report", {
    controlRevision: state.control?.revision ?? 0,
    deviceId: DEVICE,
    index,
    positionMs,
    playing,
  });
};

const documentsRead = async (
  user: User,
  run: (ctx: Parameters<(typeof playbackQueries)["queue.list"]>[0]) => Promise<object>,
): Promise<number> => {
  const measure = async (body: typeof run) =>
    user.as.query(async (ctx) => {
      await body(ctx);

      return (await ctx.meta.getTransactionMetrics()).documentsRead.used;
    });

  const viewerOnly = await measure(async (ctx) => loadViewer(ctx));

  return (await measure(run)) - viewerOnly;
};

const legacy = async () => {
  const fixture = await setup();
  const { backend, admin, rock } = fixture;

  await backend.run(async (ctx) => {
    const ids = rock.flatMap((id) => {
      const normalised = ctx.db.normalizeId("tracks", id);

      return normalised === null ? [] : [normalised];
    });

    await ctx.db.insert("playbackSessions", {
      userId: admin.id,
      activeDeviceId: DEVICE,
      queue: ids,
      index: 2,
      positionMs: 30_000,
      playing: false,
      updatedAt: START,
      shuffle: false,
      repeat: "all",
      volume: 0.5,
    });
  });

  return fixture;
};

const rows = (backend: Backend) =>
  backend.run(async (ctx) => ({
    sessions: await ctx.db.query("playbackSessions").collect(),
    queues: await ctx.db.query("playbackQueues").collect(),
  }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("play, next, and previous", () => {
  it("plays a list from an index on the named device", async () => {
    const { admin, rock } = await setup();

    await admin.music.run("playback.play", { trackIds: [...rock], index: 2, deviceId: DEVICE });
    const state = await admin.music.read("playback.state", {});

    expect(state.queue.map((track) => track.id)).toEqual(rock);
    expect(state.index).toBe(2);
    expect(state.playing).toBe(true);
    expect(state.positionMs).toBe(0);
    expect(state.activeDevice?.id).toBe(DEVICE);
  });

  it("plays on the online player when none is named, reading only online devices", async () => {
    const { backend, admin, rock } = await setup();

    await backend.run(async (ctx) => {
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          ctx.db.insert("devices", {
            userId: admin.id,
            deviceId: `old-tab-${index}`,
            name: "Old tab",
            kind: "web",
            lastSeenAt: START - (index + 1) * 60 * 60 * 1000,
          }),
        ),
      );
    });

    const read = await admin.as.mutation(async (ctx) => {
      const viewer = await loadViewer(ctx);
      const before = await ctx.meta.getTransactionMetrics();

      await playbackMutations["playback.play"](ctx, viewer, { trackIds: [...rock] });

      return (
        (await ctx.meta.getTransactionMetrics()).documentsRead.used - before.documentsRead.used
      );
    });

    expect((await admin.music.read("playback.state", {})).activeDevice?.id).toBe(DEVICE);
    expect(read).toBeLessThan(20);
  });

  it("refuses to play on a device that never registered", async () => {
    const { admin, rock } = await setup();

    expect(
      await failureCode(
        admin.music.run("playback.play", {
          trackIds: [...rock],
          deviceId: DeviceId.make("never-seen"),
        }),
      ),
    ).toBe("not_found");
  });

  it("steps forward and stops after the last song when repeat is off", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 3, deviceId: DEVICE });

    await admin.music.run("playback.next", {});
    expect(await current(admin)).toBe(at(4, rock));

    await admin.music.run("playback.next", {});
    const ended = await admin.music.read("playback.state", {});

    expect(ended.index).toBe(4);
    expect(ended.playing).toBe(false);
  });

  it("wraps around both ways when repeat is all", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 4, deviceId: DEVICE });
    await admin.music.run("playback.repeat", { mode: "all" });

    await admin.music.run("playback.next", {});
    expect(await current(admin)).toBe(at(0, rock));

    await admin.music.run("playback.previous", {});
    expect(await current(admin)).toBe(at(4, rock));
    expect((await admin.music.read("queue.list", {})).repeat).toBe("all");
  });

  it("restarts the song when previous comes more than three seconds in", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 2, deviceId: DEVICE });

    vi.setSystemTime(START + 10_000);
    await admin.music.run("playback.previous", {});
    const restarted = await admin.music.read("playback.state", {});

    expect(restarted.index).toBe(2);
    expect(restarted.positionMs).toBe(0);

    await admin.music.run("playback.previous", {});
    expect(await current(admin)).toBe(at(1, rock));
  });

  it("jumps to an entry and refuses one that is not in the queue", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await admin.music.run("playback.pause", {});

    await admin.music.run("playback.jump", { itemId: await itemAt(admin, 3) });
    const state = await admin.music.read("playback.state", {});

    expect(state.queue[state.index]?.id).toBe(at(3, rock));
    expect(state.playing).toBe(true);
    expect(
      await failureCode(admin.music.run("playback.jump", { itemId: QueueItemId.make("999") })),
    ).toBe("not_found");
  });
});

describe("the queue", () => {
  it("adds songs next or at the end, removes one, and clears what follows", async () => {
    const { admin, rock } = await setup();
    const [first, second, third, fourth, fifth] = rock;

    if (fifth === undefined || first === undefined || second === undefined) {
      throw new Error("Seed missing");
    }

    await admin.music.run("queue.autoplay", { on: false });
    await admin.music.run("playback.play", { trackIds: [first, second], deviceId: DEVICE });
    await admin.music.run("queue.add", { trackIds: [at(2, rock)], next: true });
    await admin.music.run("queue.add", { trackIds: [at(3, rock)] });
    expect(await queueIds(admin)).toEqual([first, third, second, fourth]);

    await admin.music.run("playback.jump", { itemId: await itemAt(admin, 2) });
    await admin.music.run("queue.remove", { itemId: await itemAt(admin, 1) });
    expect(await queueIds(admin)).toEqual([first, second, fourth]);
    expect(await current(admin)).toBe(second);

    const { itemIds } = await admin.music.run("queue.add", { trackIds: [fifth] });
    await admin.music.run("queue.clear", {});
    expect(await queueIds(admin)).toEqual([first, second]);

    const [cleared] = itemIds;

    if (cleared === undefined) throw new Error("queue.add returned no entry");
    expect(await failureCode(admin.music.run("queue.remove", { itemId: cleared }))).toBe(
      "not_found",
    );
  });

  it("removing the current song moves to the next one", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 1, deviceId: DEVICE });

    await admin.music.run("queue.remove", { itemId: await itemAt(admin, 1) });
    expect(await current(admin)).toBe(at(2, rock));
    expect((await admin.music.read("playback.state", {})).positionMs).toBe(0);
  });
});

describe("shuffle", () => {
  it("keeps the current song first and restores the order when turned off", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], index: 2, deviceId: DEVICE });

    await admin.music.run("playback.shuffle", { on: true });
    const shuffledQueue = await queueIds(admin);

    expect(shuffledQueue[0]).toBe(at(2, rock));
    expect(shuffledQueue.toSorted()).toEqual([...rock].toSorted());

    await admin.music.run("playback.next", {});
    const playing = await current(admin);
    await admin.music.run("playback.shuffle", { on: false });

    expect(await queueIds(admin)).toEqual(rock);
    expect(await current(admin)).toBe(playing);
  });

  it("does not bring back a song removed while shuffled", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await admin.music.run("playback.shuffle", { on: true });
    const removed = at(3, await queueIds(admin));

    await admin.music.run("queue.remove", { itemId: await itemAt(admin, 3) });
    await admin.music.run("playback.shuffle", { on: false });

    expect(await queueIds(admin)).toEqual(rock.filter((id) => id !== removed));
  });

  it("keeps the original order, plus added songs, when turned off after adding", async () => {
    const { backend, admin, rock } = await setup();
    await seedLibrary(backend, admin, { name: "Jazz", count: 2 });
    const jazz = trackIds(await allTracks(admin), "Jazz");

    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await admin.music.run("playback.shuffle", { on: true });
    await admin.music.run("queue.add", { trackIds: [at(0, jazz)] });
    await admin.music.run("queue.add", { trackIds: [at(1, jazz)], next: true });
    await admin.music.run("playback.shuffle", { on: false });

    expect(await queueIds(admin)).toEqual([
      at(0, rock),
      at(1, jazz),
      ...rock.slice(1),
      at(0, jazz),
    ]);
  });

  it("fills the queue from a long list shuffled from a song near its end", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Long", count: 1200 });
    await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
    const long = trackIds(await allTracks(admin), "Long");

    await admin.music.run("playback.shuffle", { on: true });
    await admin.music.run("playback.play", { trackIds: [...long], index: 1199, deviceId: DEVICE });
    const queue = await queueIds(admin);

    expect(queue).toHaveLength(1000);
    expect(queue[0]).toBe(at(1199, long));
    expect(new Set(queue).size).toBe(1000);
  }, 60_000);

  it("shuffles a new list as it starts playing while shuffle is on", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.shuffle", { on: true });
    await admin.music.run("playback.play", { trackIds: [...rock], index: 1, deviceId: DEVICE });

    expect(await current(admin)).toBe(at(1, rock));
    await admin.music.run("playback.shuffle", { on: false });
    expect(await queueIds(admin)).toEqual(rock);
    expect(await current(admin)).toBe(at(1, rock));
  });
});

describe("songs whose file is gone", () => {
  it("are left out when playing a list, keeping the chosen song", async () => {
    const { backend, admin, rock } = await setup();
    const [library] = await admin.music.read("libraries.list", {});

    await markMissing(backend, library?.id ?? "", ["Rock/0001.flac", "Rock/0003.flac"]);

    await admin.music.run("playback.play", { trackIds: [...rock], index: 3, deviceId: DEVICE });

    expect(await queueIds(admin)).toEqual([at(1, rock), at(3, rock), at(4, rock)]);
    expect(await current(admin)).toBe(at(3, rock));
    expect(await failureCode(admin.music.run("queue.add", { trackIds: [at(0, rock)] }))).toBe(
      "not_found",
    );
  });

  it("stay in the queue when their file goes missing while queued", async () => {
    const { backend, admin, rock } = await setup();
    const [library] = await admin.music.read("libraries.list", {});

    await admin.music.run("playback.play", { trackIds: [...rock], index: 2, deviceId: DEVICE });
    await markMissing(backend, library?.id ?? "", ["Rock/0002.flac"]);
    await admin.music.run("playback.next", {});

    expect(await queueIds(admin)).toEqual(rock);
    expect(await current(admin)).toBe(at(3, rock));
  });
});

describe("after a library is deleted", () => {
  it("drops its songs and keeps the index on the same song", async () => {
    const { admin, rock } = await mixed();
    const state = await admin.music.read("playback.state", {});

    expect(state.queue.map((track) => track.id)).toEqual(rock.slice(0, 3));
    expect(state.index).toBe(2);
  });

  it("jumps, removes, and reports by the entry the client was shown", async () => {
    const { admin, rock } = await mixed();

    await admin.music.run("playback.jump", { itemId: await itemAt(admin, 1) });
    expect(await current(admin)).toBe(at(1, rock));

    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 1,
      positionMs: 1000,
      playing: true,
    });

    expect(await history(admin)).toEqual([at(1, rock)]);

    await admin.music.run("queue.remove", { itemId: await itemAt(admin, 0) });
    expect(await queueIds(admin)).toEqual([at(1, rock), at(2, rock)]);
    expect(await current(admin)).toBe(at(1, rock));
  });

  it("finds the song a report names when the player has not seen the queue shift", async () => {
    const { backend, admin, rock } = await setup();
    const jazzLibrary = await seedLibrary(backend, admin, { name: "Jazz", count: 1 });
    const [jazz] = trackIds(await allTracks(admin), "Jazz");

    if (jazz === undefined) throw new Error("Seed missing");
    const queue = [jazz, ...rock];

    await admin.music.run("playback.play", { trackIds: queue, index: 3, deviceId: DEVICE });
    await admin.music.run("libraries.delete", { libraryId: jazzLibrary.libraryId });

    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 3,
      trackId: at(2, rock),
      positionMs: 1000,
      playing: true,
    });

    expect(await current(admin)).toBe(at(2, rock));
    expect(await history(admin)).toEqual([at(2, rock)]);
  });

  it("refuses an entry whose song was dropped", async () => {
    const { admin, items } = await mixed();
    const dropped = items[1];

    if (dropped === undefined) throw new Error("Seed missing");
    expect(await failureCode(admin.music.run("playback.jump", { itemId: dropped }))).toBe(
      "not_found",
    );
    expect(await failureCode(admin.music.run("queue.remove", { itemId: dropped }))).toBe(
      "not_found",
    );
  });
});

describe("position reports and history", () => {
  it("records a play once per song, and again when the song is played again", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    await report(admin, 0, 500);
    vi.setSystemTime(START + 15_000);
    await report(admin, 0, 15_500);
    expect(await history(admin)).toEqual([at(0, rock)]);

    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await report(admin, 0, 200);
    expect(await history(admin)).toEqual([at(0, rock), at(0, rock)]);
  });

  it("records a song that repeats on its own (repeat one)", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await admin.music.run("playback.repeat", { mode: "one" });

    await report(admin, 0, 100);
    vi.setSystemTime(START + 170_000);
    await report(admin, 0, 170_100);
    vi.setSystemTime(START + 181_000);
    await report(admin, 0, 300);

    expect(await history(admin)).toEqual([at(0, rock), at(0, rock)]);
  });

  it("records every loop of a short song on repeat one", async () => {
    const { backend, admin } = await setup();
    const { libraryId } = await seedLibrary(backend, admin, { name: "Jingle", count: 0 });

    await upsertFiles(backend, libraryId, [
      { path: "jingle.flac", title: "Jingle", durationMs: 6000 },
    ]);
    const [jingle] = trackIds(await allTracks(admin), "Jingle");

    if (jingle === undefined) throw new Error("Seed missing");
    await admin.music.run("playback.play", { trackIds: [jingle], deviceId: DEVICE });
    await admin.music.run("playback.repeat", { mode: "one" });

    await [0, 1, 2].reduce(async (previous, loop) => {
      await previous;
      vi.setSystemTime(START + loop * 6000);
      await report(admin, 0, 50);
    }, Promise.resolve());

    expect(await history(admin)).toEqual([jingle, jingle, jingle]);
  });

  it("records the next song a device advanced to, and ignores other devices", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    await report(admin, 0, 100);
    vi.setSystemTime(START + 180_000);
    await report(admin, 1, 100);
    await admin.music.run("playback.report", {
      deviceId: DeviceId.make("someone-else"),
      index: 3,
      positionMs: 100,
      playing: true,
    });

    expect(await history(admin)).toEqual([at(1, rock), at(0, rock)]);
    expect(await current(admin)).toBe(at(1, rock));
  });

  it("ignores a report sent before the player saw a skip", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });
    await report(admin, 0, 100);

    vi.setSystemTime(START + 15_000);
    await admin.music.run("playback.next", {});
    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 0,
      trackId: at(0, rock),
      positionMs: 15_100,
      playing: true,
    });

    expect(await current(admin)).toBe(at(1, rock));
    expect(await history(admin)).toEqual([at(0, rock)]);

    vi.setSystemTime(START + 16_000);
    await report(admin, 1, 900);
    expect(await history(admin)).toEqual([at(1, rock), at(0, rock)]);
  });

  it("counts a pause and resume of the same song as one play", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: [...rock], deviceId: DEVICE });

    await report(admin, 0, 100);
    await report(admin, 0, 30_000, false);
    await report(admin, 0, 30_000);

    expect(await history(admin)).toEqual([at(0, rock)]);
  });
});

const captureReport = async (user: User, positionMs: number, playing: boolean) => {
  const state = await user.music.read("playback.state", {});
  const entry = state.queue[state.index];

  if (entry === undefined) throw new Error("No playing entry");

  return {
    controlRevision: state.control?.revision ?? 0,
    deviceId: DEVICE,
    index: state.index,
    trackId: entry.id,
    itemId: entry.itemId,
    positionMs,
    playing,
  };
};

describe("controls delivered before older telemetry", () => {
  it("keeps a paused seek when an older paused measurement arrives", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    await admin.music.run("playback.pause", {});
    const held = await captureReport(admin, 145, false);

    await admin.music.run("playback.seek", { positionMs: 3000 });
    await admin.music.run("playback.report", held);
    expect(await admin.music.read("playback.position", {})).toMatchObject({
      positionMs: 3000,
      playing: false,
    });
  });

  it("keeps a pause when an older playing measurement arrives", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    const held = await captureReport(admin, 145, true);

    await admin.music.run("playback.pause", {});
    await admin.music.run("playback.report", held);
    expect((await admin.music.read("playback.position", {})).playing).toBe(false);
    expect(await history(admin)).toEqual([]);
  });

  it("keeps a resume when an older paused measurement arrives", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    await admin.music.run("playback.pause", {});
    const held = await captureReport(admin, 145, false);

    await admin.music.run("playback.resume", {});
    await admin.music.run("playback.report", held);
    expect((await admin.music.read("playback.position", {})).playing).toBe(true);
  });

  it("rejects the old device report after transfer away and back", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    const held = await captureReport(admin, 145, true);
    const other = DeviceId.make("other-device");
    await admin.music.run("devices.heartbeat", { deviceId: other, name: "Phone", kind: "phone" });

    await admin.music.run("playback.transfer", { deviceId: other });
    await admin.music.run("playback.transfer", { deviceId: DEVICE });
    await admin.music.run("playback.seek", { positionMs: 3000 });
    await admin.music.run("playback.report", held);

    expect((await admin.music.read("playback.position", {})).positionMs).toBe(3000);
  });

  it("accepts a measured natural advance after applying a concurrent pause", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    const state = await admin.music.read("playback.state", {});
    const next = state.queue[1];

    if (next === undefined) throw new Error("No next entry");

    const held = {
      controlRevision: state.control?.revision ?? 0,
      deviceId: DEVICE,
      index: 1,
      trackId: next.id,
      itemId: next.itemId,
      positionMs: 145,
      playing: true,
    };

    await admin.music.run("playback.pause", {});
    await admin.music.run("playback.report", held);
    expect((await admin.music.read("playback.position", {})).playing).toBe(false);

    const applied = await captureReport(admin, 145, false);
    await admin.music.run("playback.report", {
      ...applied,
      index: 1,
      trackId: next.id,
      itemId: next.itemId,
    });

    expect((await admin.music.read("playback.state", {})).index).toBe(1);
    expect((await admin.music.read("playback.position", {})).positionMs).toBe(145);
    await admin.music.run("playback.resume", {});
    await admin.music.run("playback.report", await captureReport(admin, 400, true));
    expect(await history(admin)).toEqual([next.id]);
  });

  it("keeps a natural advance when another connection delivers an older stamped report", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    const held = await captureReport(admin, 100, true);
    const next = (await admin.music.read("playback.state", {})).queue[1];

    if (next === undefined) throw new Error("No next entry");

    await admin.music.run("playback.report", {
      ...held,
      index: 1,
      trackId: next.id,
      itemId: next.itemId,
      positionMs: 145,
    });
    await admin.music.run("playback.report", held);

    expect(await admin.music.read("playback.state", {})).toMatchObject({
      index: 1,
      positionMs: 145,
    });
    await admin.music.run("playback.report", await captureReport(admin, 400, true));
    expect((await admin.music.read("playback.position", {})).positionMs).toBe(400);
    expect(await history(admin)).toEqual([next.id]);
  });

  it("keeps a stamped report valid when another queue entry is removed", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    const measured = await captureReport(admin, 1234, true);

    await admin.music.run("queue.remove", { itemId: await itemAt(admin, 2) });
    await admin.music.run("playback.report", measured);

    expect((await admin.music.read("playback.position", {})).positionMs).toBe(1234);
    expect(await history(admin)).toEqual([at(0, rock)]);
  });

  it("retains the unstamped legacy player protocol during upgrades", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    await admin.music.run("playback.pause", {});
    vi.setSystemTime(START + 4000);
    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 1,
      positionMs: 321,
      playing: true,
    });

    expect(await admin.music.read("playback.state", {})).toMatchObject({
      index: 1,
      positionMs: 321,
      playing: true,
    });
  });

  it("accepts a fresh measurement after applying the seek and resume", async () => {
    const { admin, rock } = await setup();
    await admin.music.run("playback.play", { trackIds: rock, deviceId: DEVICE });
    await admin.music.run("playback.pause", {});
    await admin.music.run("playback.seek", { positionMs: 3000 });
    await admin.music.run("playback.resume", {});
    const fresh = await captureReport(admin, 3456, true);

    await admin.music.run("playback.report", fresh);
    expect(await admin.music.read("playback.position", {})).toMatchObject({
      positionMs: 3456,
      playing: true,
    });
    expect(await history(admin)).toEqual([at(0, rock)]);
  });
});

describe("what a position report costs", () => {
  it("keeps the queue out of the position, and the position out of the queue", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Big", count: 1000 });
    await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
    const tracks = await allTracks(admin);

    await admin.music.run("playback.play", {
      trackIds: tracks.map((track) => track.id),
      deviceId: DEVICE,
    });

    expect(
      await documentsRead(admin, async (ctx) =>
        playbackQueries["playback.position"](ctx, await loadViewer(ctx)),
      ),
    ).toBe(2);

    expect(
      await documentsRead(admin, async (ctx) =>
        playbackQueries["queue.list"](ctx, await loadViewer(ctx)),
      ),
    ).toBe(1 + 1000 + 1);

    const [first] = tracks;

    if (first === undefined) throw new Error("Seed missing");
    await admin.music.run("playback.report", {
      deviceId: DEVICE,
      index: 0,
      trackId: first.id,
      positionMs: 100,
      playing: true,
    });

    const cost = await admin.as.mutation(async (ctx) => {
      const viewer = await loadViewer(ctx);
      const before = await ctx.meta.getTransactionMetrics();

      await playbackMutations["playback.report"](ctx, viewer, {
        deviceId: DEVICE,
        index: 0,
        trackId: first.id,
        positionMs: 15_100,
        playing: true,
      });

      const after = await ctx.meta.getTransactionMetrics();

      return {
        read: after.documentsRead.used - before.documentsRead.used,
        written: after.documentsWritten.used - before.documentsWritten.used,
      };
    });

    expect(cost).toEqual({ read: 5, written: 1 });

    const unnamed = await admin.as.mutation(async (ctx) => {
      const viewer = await loadViewer(ctx);
      const before = await ctx.meta.getTransactionMetrics();

      await playbackMutations["playback.report"](ctx, viewer, {
        deviceId: DEVICE,
        index: 0,
        positionMs: 30_100,
        playing: true,
      });

      const after = await ctx.meta.getTransactionMetrics();

      return after.documentsRead.used - before.documentsRead.used;
    });

    expect(unnamed).toBe(5);
  });
});

describe("liked songs in a long queue", () => {
  it("are marked whether the viewer likes a few songs or many", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Long", count: 250 });
    await admin.music.run("devices.heartbeat", { deviceId: DEVICE, name: "Laptop", kind: "web" });
    const ids = (await allTracks(admin)).map((track) => track.id);

    await admin.music.run("playback.play", { trackIds: ids, deviceId: DEVICE });

    const likeAll = async (liked: ReadonlyArray<TrackId>) => {
      await Promise.all(
        liked.map((trackId) => admin.music.run("likes.set", { trackId, liked: true })),
      );
    };

    const likedInQueue = async () =>
      (await admin.music.read("queue.list", {})).queue.flatMap((track) =>
        track.liked ? [track.id] : [],
      );

    await likeAll(ids.slice(10, 13));
    expect(await likedInQueue()).toEqual(ids.slice(10, 13));

    await likeAll(ids.slice(0, 210));
    expect(await likedInQueue()).toEqual(ids.slice(0, 210));
  });
});

describe("a session saved by an older version", () => {
  it("reads the queue from the session until something writes it", async () => {
    const { admin, rock } = await legacy();
    const state = await admin.music.read("playback.state", {});

    expect(state.queue.map((track) => track.id)).toEqual(rock);
    expect([state.index, state.positionMs, state.repeat, state.volume]).toEqual([
      2,
      30_000,
      "all",
      0.5,
    ]);
  });

  it("moves the queue to its own row on the next queue write", async () => {
    const { backend, admin, rock } = await legacy();

    await admin.music.run("playback.next", {});
    const { sessions, queues } = await rows(backend);

    expect(await current(admin)).toBe(at(3, rock));
    expect(sessions[0]?.queue).toBeUndefined();
    expect(queues.map((row) => [row.items?.length, row.index, row.repeat])).toEqual([
      [5, 3, "all"],
    ]);
  });

  it("is moved by the splitPlaybackQueues migration", async () => {
    const { backend, admin, rock } = await legacy();

    await backend.mutation(internal.migrations.run, {});
    await drainScheduled(backend);
    const { sessions, queues } = await rows(backend);

    expect(sessions.map((session) => session.queue)).toEqual([undefined]);
    expect(queues.map((row) => row.index)).toEqual([2]);
    expect((await admin.music.read("queue.list", {})).queue.map((track) => track.id)).toEqual(rock);
  });
});
