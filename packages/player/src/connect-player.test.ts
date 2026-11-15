import { describe, expect, it } from "vitest";

import { ConnectPlayer, HEARTBEAT_MS, ServerClock, positionAt } from "./connect-player";
import type { ConnectAsk, ConnectClock, ConnectCommands, ReportedSong } from "./connect-player";
import { entry, names, queueOf, settle, setup } from "./testing/controller-harness";

const one = entry("a", "1");

const two = entry("b", "2");

interface Reported {
  readonly song: ReportedSong | null;
  readonly applied: number;
}

const song = (id: string) => ({ domain: "music", ref: { type: "track", id } }) as const;

const album = (id: string) => ({ domain: "music", ref: { type: "album", id } }) as const;

/**
 * A device's controller with Connect running over it: a recording core whose server clock runs
 * `serverAheadMs` ahead of the device, albums it answers, and a heartbeat the test fires.
 */
const connected = (options: { readonly serverAheadMs?: number } = {}) => {
  const run = setup({ playCurrent: "1" });
  const reports: Array<Reported> = [];
  const albums = new Map<string, ReadonlyArray<string>>([["al", ["c", "d"]]]);
  const albumGate = { holding: false, release: (): void => undefined };
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
        await new Promise<void>((resolve) => {
          albumGate.release = resolve;
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

    await run.controller.playTracks(["a", "b"], 0, { positionMs: 45_000, playing: false });
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

  it("settles a move made here so its load never plays twice", async () => {
    const run = connected();

    run.connect.settle(3);
    run.connect.take(
      ask(3, {
        kind: "load",
        item: song("a"),
        playing: true,
        positionMs: 0,
        at: run.clock.now,
        loadRevision: 3,
      }),
    );
    await settle();

    expect(run.record.loads).toHaveLength(0);
    expect(last(run.reports)).toMatchObject({ applied: 3 });
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
