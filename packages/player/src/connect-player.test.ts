import { describe, expect, it } from "vitest";

import { ConnectPlayer, HEARTBEAT_MS, ServerClock, positionAt } from "./connect-player";
import type {
  ConnectAsk,
  ConnectClock,
  ConnectCommands,
  ConnectItem,
  ReportedSong,
} from "./connect-player";
import { entry, names, queueOf, settle, setup } from "./testing/controller-harness";

const one = entry("a", "1");

const two = entry("b", "2");

interface Reported {
  readonly song: ReportedSong | null;
  readonly applied: number;
}

const song = (id: string) => ({ domain: "music", ref: { type: "track", id } }) as const;

const album = (id: string) => ({ domain: "music", ref: { type: "album", id } }) as const;

interface HeldAlbum {
  readonly answer: () => void;
  readonly fail: () => void;
}

/**
 * A device's controller with Connect running over it: a recording core whose server clock runs
 * `serverAheadMs` ahead of the device, whose queue command answers `playCurrent`, albums it
 * answers, which `albumGate` holds while `holding` is set, and a heartbeat the test fires.
 */
const connected = (
  options: { readonly serverAheadMs?: number; readonly playCurrent?: string } = {},
) => {
  const run = setup({ playCurrent: options.playCurrent ?? "1" });
  const reports: Array<Reported> = [];

  const albums = new Map<string, ReadonlyArray<string>>([
    ["al", ["c", "d"]],
    ["al2", ["e", "f"]],
  ]);

  const held = new Map<string, HeldAlbum>();

  const albumGate = {
    holding: false,
    /** Answers the album `albumId` held, or every album held. */
    release: (albumId?: string): void => {
      for (const [id, call] of held) {
        if (albumId !== undefined && id !== albumId) continue;
        held.delete(id);
        call.answer();
      }
    },
    fail: (albumId: string): void => {
      const call = held.get(albumId);

      held.delete(albumId);
      call?.fail();
    },
  };

  const beats: Array<{ readonly ms: number; readonly fire: () => void }> = [];

  const clock: ConnectClock = {
    now: () => run.clock.now,
    every: (ms, fire) => {
      const beat = { ms, fire };

      beats.push(beat);

      return () => {
        beats.splice(beats.indexOf(beat), 1);
      };
    },
  };

  const commands: ConnectCommands = {
    report: async (reported, applied) => {
      reports.push({ song: reported, applied });

      return run.clock.now + (options.serverAheadMs ?? 0);
    },
    albumTracks: async (albumId) => {
      if (albumGate.holding) {
        await new Promise<void>((resolve, reject) => {
          held.set(albumId, {
            answer: resolve,
            fail: () => {
              reject(new Error("The album's songs failed"));
            },
          });
        });
      }

      return albums.get(albumId) ?? [];
    },
  };

  const connect = new ConnectPlayer(run.controller, commands, clock);
  const stop = connect.start();

  return { ...run, connect, reports, albumGate, beats, stopConnect: stop };
};

const ask = (revision: number, asked: ConnectAsk) => ({ revision, ask: asked });

const last = (reports: ReadonlyArray<Reported>): Reported | undefined => reports.at(-1);

/** Plays A from the queue [A, B] on the device and lets everything settle. */
const playing = async (run: ReturnType<typeof connected>) => {
  await run.controller.playTracks(["a", "b"], 0);
  run.controller.sync(queueOf([one, two], "1"));
  await settle();
};

describe("PlaybackController for Connect", () => {
  it("says what plays here: nothing before a song loads, then the song, whether it plays, and where", async () => {
    const run = connected();

    expect(run.controller.playingHere()).toBeNull();

    await playing(run);
    run.engine().emit({ type: "time", positionMs: 30_000 });

    expect(run.controller.playingHere()).toStrictEqual({
      trackId: "a",
      itemId: "1",
      playing: true,
      positionMs: 30_000,
    });
  });

  it("follows the queue moving elsewhere while paused by loading the new song paused", async () => {
    const run = connected();

    await playing(run);
    await run.controller.togglePlay();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "b", playing: false });
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
  });

  it("shows a song the queue moved on to from its start once it let go of its own", async () => {
    const run = connected();

    await playing(run);
    run.engine().emit({ type: "time", positionMs: 50_000 });
    run.controller.release();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.controller.playingHere()).toBeNull();
    expect(run.controller.positionMs()).toBe(0);
  });

  it("keeps a device that never played idle when the queue moves elsewhere", async () => {
    const run = connected();

    run.controller.sync(queueOf([one, two], "1"));
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(run.controller.playingHere()).toBeNull();
  });

  it("starts a new queue from a position, paused, when asked to", async () => {
    const run = connected();

    await run.controller.playTracksAt(["a", "b"], () => ({ positionMs: 45_000, playing: false }));
    await settle();

    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([45_000]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
  });

  it("does not start a play whose queue answers after Connect moved playback away", async () => {
    const run = connected();

    run.gates.play.holding = true;
    const started = run.controller.playTracks(["a", "b"], 0);
    await settle();
    run.controller.release();
    run.gates.play.release("play");
    await started;
    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(run.controller.playingHere()).toBeNull();
  });
});

describe("ConnectPlayer", () => {
  it("reports at start, on each change, and on the heartbeat, but not as the song plays on", async () => {
    const run = connected();

    expect(run.reports).toStrictEqual([{ song: null, applied: 0 }]);
    expect(run.beats.map((beat) => beat.ms)).toStrictEqual([HEARTBEAT_MS]);

    await playing(run);
    const afterPlay = run.reports.length;

    expect(last(run.reports)?.song).toMatchObject({ trackId: "a", playing: true });

    run.engine().emit({ type: "time", positionMs: 1000 });
    run.engine().emit({ type: "time", positionMs: 2000 });

    expect(run.reports).toHaveLength(afterPlay);

    run.beats[0]?.fire();

    expect(run.reports).toHaveLength(afterPlay + 1);
    expect(last(run.reports)?.song).toMatchObject({ positionMs: 2000 });

    run.controller.seek(90_000);

    expect(last(run.reports)?.song).toMatchObject({ trackId: "a", positionMs: 90_000 });

    await run.controller.togglePlay();

    expect(last(run.reports)?.song).toMatchObject({ trackId: "a", playing: false });
  });

  it("stops reporting once stopped", async () => {
    const run = connected();

    run.stopConnect();
    await playing(run);

    expect(run.reports).toHaveLength(1);
    expect(run.beats).toHaveLength(0);
  });

  it("pauses the song a transport names and reports the request applied", async () => {
    const run = connected();

    await playing(run);
    run.engine().emit({ type: "time", positionMs: 10_000 });
    const at = run.clock.now;

    run.connect.take(
      ask(1, { kind: "transport", item: song("a"), playing: false, positionMs: 10_100, at }),
    );
    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
    expect(run.record.seeks).toHaveLength(0);
    expect(last(run.reports)).toMatchObject({ song: { playing: false }, applied: 1 });
  });

  it("drops a transport for a song that no longer plays here, and still settles it", async () => {
    const run = connected();

    await playing(run);
    run.connect.take(
      ask(2, {
        kind: "transport",
        item: song("b"),
        playing: false,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("playing");
    expect(last(run.reports)).toMatchObject({ song: { trackId: "a", playing: true }, applied: 2 });
  });

  it("seeks where a transport asks when the song is more than a quarter second away", async () => {
    const run = connected();

    await playing(run);
    run.connect.take(
      ask(1, {
        kind: "transport",
        item: song("a"),
        playing: true,
        positionMs: 120_000,
        at: run.clock.now,
      }),
    );
    await settle();

    expect(run.record.seeks).toStrictEqual([120_000]);
    expect(last(run.reports)).toMatchObject({ song: { positionMs: 120_000 }, applied: 1 });
  });

  it("applies each request once, and none it already handled", async () => {
    const run = connected();

    await playing(run);

    const pause = ask(3, {
      kind: "transport",
      item: song("a"),
      playing: false,
      positionMs: 0,
      at: run.clock.now,
    });

    run.connect.take(pause);
    await settle();
    await run.controller.togglePlay();
    run.connect.take(pause);
    run.connect.take(ask(2, { kind: "stop", at: run.clock.now }));
    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("playing");
  });

  it("lets go of the song on a stop and reports playing nothing", async () => {
    const run = connected();

    await playing(run);
    run.engine().emit({ type: "time", positionMs: 50_000 });
    run.connect.take(ask(4, { kind: "stop", at: run.clock.now }));
    await settle();

    expect(run.controller.playingHere()).toBeNull();
    expect(run.controller.getSnapshot()).toMatchObject({ engineStatus: "idle", current: "1" });
    expect(last(run.reports)).toStrictEqual({ song: null, applied: 4 });
  });

  it("plays the queue's current song from where it stood on a load of it, keeping the queue", async () => {
    const run = connected();

    run.controller.sync(queueOf([one, two], "1"));
    run.connect.take(
      ask(5, {
        kind: "load",
        item: song("a"),
        playing: true,
        positionMs: 60_000,
        at: run.clock.now,
        loadRevision: 5,
      }),
    );
    await settle();

    expect(names(run.sent)).not.toContain("play:a,0");
    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([60_000]);
    expect(last(run.reports)).toMatchObject({
      song: { trackId: "a", playing: true, positionMs: 60_000 },
      applied: 5,
    });
  });

  it("replaces the queue with a song the queue does not play", async () => {
    const run = connected();

    run.controller.sync(queueOf([one, two], "1"));
    run.connect.take(
      ask(1, {
        kind: "load",
        item: song("z"),
        playing: true,
        positionMs: 0,
        at: run.clock.now,
        loadRevision: 1,
      }),
    );
    await settle();

    expect(names(run.sent)).toContain("play:z,0");
  });

  it("plays an album from its first song at the asked position on a load of it", async () => {
    const run = connected();

    run.connect.take(
      ask(6, {
        kind: "load",
        item: album("al"),
        playing: true,
        positionMs: 5000,
        at: run.clock.now,
        loadRevision: 6,
      }),
    );
    await settle();

    expect(names(run.sent)[0]).toBe("play:c,d,0");
    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([5000]);
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c" }, applied: 6 });
  });

  it("only plays, pauses, or seeks a load it already started", async () => {
    const run = connected();
    const loaded = { kind: "load", item: album("al"), positionMs: 0, loadRevision: 6 } as const;

    run.connect.take(ask(6, { ...loaded, playing: true, at: run.clock.now }));
    await settle();
    run.connect.take(ask(7, { ...loaded, playing: false, at: run.clock.now }));
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toHaveLength(1);
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
    expect(last(run.reports)).toMatchObject({ applied: 7 });
  });

  it("starts an album load with the pause a controller sent while its songs loaded", async () => {
    const run = connected();
    const loaded = { kind: "load", item: album("al"), positionMs: 0, loadRevision: 6 } as const;

    run.albumGate.holding = true;
    run.connect.take(ask(6, { ...loaded, playing: true, at: run.clock.now }));
    await settle();
    run.connect.take(ask(7, { ...loaded, playing: false, positionMs: 4000, at: run.clock.now }));
    await settle();

    expect(last(run.reports)).toMatchObject({ applied: 0 });

    run.albumGate.release();
    await settle();

    expect(names(run.sent)[0]).toBe("play:c,d,0");
    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([4000]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c", playing: false }, applied: 7 });
  });

  it("drops an album load that a newer request replaced while its songs loaded", async () => {
    const run = connected();

    await playing(run);
    run.albumGate.holding = true;
    run.connect.take(
      ask(8, {
        kind: "load",
        item: album("al"),
        playing: true,
        positionMs: 0,
        at: run.clock.now,
        loadRevision: 8,
      }),
    );
    await settle();
    run.connect.take(
      ask(9, {
        kind: "transport",
        item: song("a"),
        playing: false,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();
    run.albumGate.release();
    await settle();

    expect(names(run.sent)).not.toContain("play:c,d,0");
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
    expect(last(run.reports)).toMatchObject({ applied: 9 });
  });

  it("drops an album load the listener replaced here, and settles it", async () => {
    const run = connected();

    run.albumGate.holding = true;
    run.connect.take(
      ask(8, {
        kind: "load",
        item: album("al"),
        playing: true,
        positionMs: 0,
        at: run.clock.now,
        loadRevision: 8,
      }),
    );
    await settle();
    run.connect.supersede();

    expect(last(run.reports)).toMatchObject({ applied: 8 });

    run.albumGate.release();
    await settle();

    expect(names(run.sent)).not.toContain("play:c,d,0");
  });

  it("settles a load of another domain's item without playing it", async () => {
    const run = connected();

    run.connect.take(
      ask(1, {
        kind: "load",
        item: { domain: "movies", ref: { type: "title", id: "t1" } },
        playing: true,
        positionMs: 0,
        at: run.clock.now,
        loadRevision: 1,
      }),
    );
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(last(run.reports)).toMatchObject({ song: null, applied: 1 });
  });

  it("works out a request's position on the server's clock", async () => {
    const run = connected({ serverAheadMs: 5000 });

    await playing(run);
    await settle();
    const serverNow = run.connect.serverNow();

    expect(serverNow).toBe(run.clock.now + 5000);

    run.connect.take(
      ask(1, {
        kind: "transport",
        item: song("a"),
        playing: true,
        positionMs: 10_000,
        at: serverNow - 2000,
      }),
    );
    await settle();

    expect(run.record.seeks).toStrictEqual([12_000]);
  });
});

const loadOf = (item: ConnectItem, loadRevision: number, at: number) =>
  ({ kind: "load", item, playing: true, positionMs: 0, at, loadRevision }) as const;

describe("ConnectPlayer, against what is current when a request or a step of a load applies", () => {
  it("starts an album load the listener replaced here as the listener wants now, paused after a pause", async () => {
    const run = connected({ playCurrent: "new" });

    run.controller.sync(queueOf([one, two], "1"));
    run.controller.playCurrentAt("a", 0, true);
    await settle();
    run.gates.play.holding = true;
    run.connect.take(ask(1, loadOf(album("al"), 1, run.clock.now)));
    await settle();
    run.connect.supersede();
    await run.controller.togglePlay();
    run.gates.play.release("play");
    await settle();
    run.controller.sync(queueOf([entry("c", "new"), entry("d", "new2")], "new"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c", playing: false }, applied: 1 });
  });

  it("lets a failure reach only the load it belongs to, so a newer load still plays", async () => {
    const run = connected();

    run.albumGate.holding = true;
    run.connect.take(ask(1, loadOf(album("al"), 1, run.clock.now)));
    await settle();
    run.connect.take(ask(2, loadOf(album("al2"), 2, run.clock.now)));
    await settle();
    run.albumGate.fail("al");
    await settle();
    run.albumGate.release("al2");
    await settle();

    expect(names(run.sent)[0]).toBe("play:e,f,0");
    expect(run.controller.playingHere()).toMatchObject({ trackId: "e", playing: true });
    expect(last(run.reports)).toMatchObject({ song: { trackId: "e" }, applied: 2 });
  });

  it("settles the newest ask of a load whose album failed, and plays nothing", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 1, run.clock.now);

    run.albumGate.holding = true;
    run.connect.take(ask(1, loaded));
    await settle();
    run.connect.take(ask(2, { ...loaded, playing: false }));
    await settle();
    run.albumGate.fail("al");
    await settle();

    expect(names(run.sent)).toStrictEqual([]);
    expect(last(run.reports)).toStrictEqual({ song: null, applied: 2 });
  });

  it("reports an album's first song while it is on its way here, and starts it as a pause sent meanwhile asks", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 1, run.clock.now);

    run.gates.start.holding = true;
    run.connect.take(ask(1, loaded));
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(last(run.reports)).toStrictEqual({
      song: { trackId: "c", playing: true, positionMs: 0 },
      applied: 1,
    });

    run.connect.take(ask(2, { ...loaded, playing: false, positionMs: 3000 }));
    await settle();
    run.gates.start.release("c");
    await settle();

    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([3000]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c", playing: false }, applied: 2 });
  });

  it("pauses an album's first song on its way here when a transport names it", async () => {
    const run = connected();

    run.gates.start.holding = true;
    run.connect.take(ask(1, loadOf(album("al"), 1, run.clock.now)));
    await settle();
    run.connect.take(
      ask(2, {
        kind: "transport",
        item: song("c"),
        playing: false,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();
    run.gates.start.release("c");
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
  });

  it("starts an album load as a pause sent while its queue was written asks", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 1, run.clock.now);

    run.gates.play.holding = true;
    run.connect.take(ask(1, loaded));
    await settle();
    run.connect.take(ask(2, { ...loaded, playing: false, positionMs: 4000 }));
    await settle();
    run.gates.play.release("play");
    await settle();

    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([4000]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c", playing: false }, applied: 2 });
  });

  it("starts a load it dropped when it stopped once it starts again, and only once", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 1, run.clock.now);

    run.albumGate.holding = true;
    run.connect.take(ask(1, loaded));
    await settle();
    run.stopConnect();
    run.albumGate.holding = false;
    const stopAgain = run.connect.start();

    run.connect.take(ask(1, loaded));
    await settle();
    run.albumGate.release("al");
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toStrictEqual([
      "play:c,d,0",
    ]);
    expect(last(run.reports)).toMatchObject({ song: { trackId: "c" }, applied: 1 });

    stopAgain();
  });

  it("keeps moot a load a tap made moot before this tab led, when it is asked again", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 7, run.clock.now);

    run.stopConnect();
    run.connect.take(ask(7, loaded));
    run.connect.supersede();
    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    const stopAgain = run.connect.start();

    run.connect.take(ask(8, { ...loaded, playing: false }));
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toStrictEqual([
      "play:a,b,0",
    ]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
    expect(last(run.reports)).toMatchObject({ applied: 8 });

    stopAgain();
  });

  it("applies a request the core showed before it started, once it starts", async () => {
    const run = connected();

    await playing(run);
    run.stopConnect();
    run.connect.take(
      ask(3, {
        kind: "transport",
        item: song("a"),
        playing: false,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("playing");

    const stopAgain = run.connect.start();

    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
    expect(last(run.reports)).toMatchObject({ song: { trackId: "a", playing: false }, applied: 3 });

    stopAgain();
  });

  it("makes moot what a tab that did not lead saw before a tap there, once it leads", async () => {
    const run = connected();
    const loaded = loadOf(album("al"), 7, run.clock.now);

    run.stopConnect();
    run.connect.take(ask(7, loaded));
    run.connect.supersede();
    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    const stopAgain = run.connect.start();

    run.connect.take(ask(7, loaded));
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toStrictEqual([
      "play:a,b,0",
    ]);
    expect(last(run.reports)).toMatchObject({ song: { trackId: "a" }, applied: 7 });

    stopAgain();
  });

  it("drops a play, pause, or seek of a load whose song the listener moved on from here", async () => {
    const run = connected();
    const loaded = loadOf(song("a"), 1, run.clock.now);

    run.controller.sync(queueOf([one, two], "1"));
    run.connect.take(ask(1, loaded));
    await settle();
    run.connect.supersede();
    await run.controller.jump("2");
    await settle();
    run.connect.take(ask(2, { ...loaded, playing: false, positionMs: 45_000 }));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({
      trackId: "b",
      playing: true,
      positionMs: 0,
    });
    expect(run.record.seeks).toHaveLength(0);
    expect(last(run.reports)).toMatchObject({ song: { trackId: "b", playing: true }, applied: 2 });
  });

  it("lands a move on a device that just opened once its queue arrives, keeping the queue", async () => {
    const run = connected();

    run.connect.take(ask(7, { ...loadOf(song("a"), 7, run.clock.now), positionMs: 60_000 }));
    await settle();

    expect(names(run.sent)).toStrictEqual([]);
    expect(run.controller.playingHere()).toBeNull();
    expect(last(run.reports)).toStrictEqual({ song: null, applied: 0 });

    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toStrictEqual([]);
    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([60_000]);
    expect(run.controller.playingHere()).toMatchObject({
      trackId: "a",
      itemId: "1",
      playing: true,
    });
    expect(last(run.reports)).toMatchObject({ song: { trackId: "a" }, applied: 7 });
  });

  it("waits for a new queue's entries to hold its current one before it lands a move", async () => {
    const run = connected();

    run.controller.sync(queueOf([one, two], "1"));
    run.controller.sync(queueOf([one, two], "9"));
    run.connect.take(ask(3, loadOf(song("z"), 3, run.clock.now)));
    await settle();

    expect(names(run.sent)).toStrictEqual([]);

    run.controller.sync(queueOf([entry("z", "9")], "9"));
    await settle();

    expect(names(run.sent).filter((name) => name.startsWith("play:"))).toStrictEqual([]);
    expect(run.controller.playingHere()).toMatchObject({
      trackId: "z",
      itemId: "9",
      playing: true,
    });
    expect(last(run.reports)).toMatchObject({ applied: 3 });
  });

  it("never lands a move that waited for the queue once a newer request replaced it", async () => {
    const run = connected();

    run.connect.take(ask(1, loadOf(song("a"), 1, run.clock.now)));
    run.connect.take(ask(2, { kind: "stop", at: run.clock.now }));
    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(names(run.sent)).toStrictEqual([]);
    expect(last(run.reports)).toStrictEqual({ song: null, applied: 2 });
  });
});

describe("ServerClock", () => {
  it("trusts the sample with the shortest round trip", () => {
    const device = { now: 1000 };
    const clock = new ServerClock(() => device.now);

    clock.sample(0, 400, 10_000);
    clock.sample(500, 520, 10_710);

    expect(clock.now()).toBe(1000 + 10_710 - 510);
  });

  it("reads the device's own clock before any sample", () => {
    const clock = new ServerClock(() => 42);

    expect(clock.now()).toBe(42);
  });
});

describe("positionAt", () => {
  it("moves on from the anchor while playing and holds while paused", () => {
    expect(positionAt({ playing: true, positionMs: 1000, at: 100 }, 600)).toBe(1500);
    expect(positionAt({ playing: false, positionMs: 1000, at: 100 }, 600)).toBe(1000);
    expect(positionAt({ playing: true, positionMs: 1000, at: 600 }, 100)).toBe(1000);
  });
});
