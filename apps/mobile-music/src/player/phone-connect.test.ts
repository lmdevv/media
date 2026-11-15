import { ConnectPlayer } from "@media/player/connect-player";
import type { ConnectAsk, ConnectCommands, ReportedSong } from "@media/player/connect-player";
import type { EngineEvent } from "@media/player/engine";
import { PlaybackController } from "@media/player/playback-controller";
import type { MusicCommands, QueueEntry, QueueState } from "@media/player/playback-controller";
import type { SourceResolver } from "@media/player/source-resolver";
import { Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { FakeOutput } from "./fake-output";
import { NativeEngine } from "./native-engine";

/*
 * Connect on the phone through the app's own engine: the controller and `ConnectPlayer` over a
 * `NativeEngine` whose native players are fakes. A test presses the lock screen by calling `pause`
 * or `play` on the native player itself, as expo-audio's remote commands do to the AVPlayer.
 */

const songA = trackOf("Safe from Harm");

const songB = trackOf("One Love");

const songC = trackOf("Teardrop", "Massive Attack", "Mezzanine");

const songD = trackOf("Angel", "Massive Attack", "Mezzanine");

const songE = trackOf("Protection", "Massive Attack", "Protection");

const songs = [songA, songB, songC, songD, songE];

const entryOf = (track: Track, itemId: string): QueueEntry<Track> => ({
  itemId,
  autoplay: false,
  track,
});

const queueOf = (
  entries: ReadonlyArray<QueueEntry<Track>>,
  current: string | null,
  fields: Partial<QueueState<Track>> = {},
): QueueState<Track> => ({
  entries,
  complete: true,
  current,
  shuffle: false,
  repeat: "off",
  autoplay: false,
  ...fields,
});

const one = entryOf(songA, "1");

const two = entryOf(songB, "2");

const song = (track: Track) => ({ domain: "music", ref: { type: "track", id: track.id } }) as const;

const album = (id: string) => ({ domain: "music", ref: { type: "album", id } }) as const;

/** Lets the engine's players open and every awaited call settle, a few macrotasks deep. */
const settle = async (turns = 8): Promise<void> => {
  if (turns === 0) return;

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await settle(turns - 1);
};

/** A call the test holds until it answers or fails it. */
interface Held {
  readonly answer: () => void;
  readonly fail: () => void;
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * The phone's player with Connect running over it. Its native players open at once; the core's
 * queue command answers `answer.current`, held while `holdPlay` is set; albums answer their songs,
 * held while `holdAlbums` is set.
 */
const phone = () => {
  const outputs: Array<FakeOutput> = [];
  const events: Array<EngineEvent> = [];

  const engine = new NativeEngine((url) => {
    const output = new FakeOutput(url);

    outputs.push(output);
    setTimeout(() => {
      output.ready(false);
    }, 0);

    return output;
  });

  engine.subscribe((event) => events.push(event));

  const sent: Array<string> = [];
  const held = new Map<string, Held>();
  const gates = { holdPlay: false, holdAlbums: false };
  const answer = { current: "n1" };
  const clock = { now: 1_000_000 };

  const hold = (key: string): Promise<void> =>
    new Promise((resolve, reject) => {
      held.set(key, {
        answer: resolve,
        fail: () => {
          reject(new Error(`${key} failed`));
        },
      });
    });

  const commands: MusicCommands = {
    play: async (trackIds) => {
      sent.push(`play:${trackIds.join(",")}`);

      if (gates.holdPlay) await hold("play");

      return { current: answer.current };
    },
    track: async (trackId) => songs.find((track) => track.id === trackId) ?? songA,
    jump: async (itemId) => {
      sent.push(`jump:${itemId}`);
    },
    report: async () => {},
  };

  const sources: SourceResolver = {
    resolve: async (track) =>
      Result.succeed({
        origin: "stream",
        profile: "aac-320",
        renewAt: Number.MAX_SAFE_INTEGER,
        playbackId: `p-${track.id}`,
        source: {
          key: track.id,
          url: `https://media.test/${track.id}`,
          durationMs: track.durationMs,
          finished: true,
        },
      }),
    discard: () => {},
  };

  const controller = new PlaybackController(
    commands,
    sources,
    { mse: null, create: () => engine },
    {
      canPlay: () => true,
      now: () => clock.now,
      monotonicNow: () => 0,
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      nowPlaying: { setHandlers: () => {}, show: () => {} },
      resume: { load: () => null, save: () => {} },
    },
  );

  stops.push(controller.start());

  const reports: Array<{ readonly song: ReportedSong | null; readonly applied: number }> = [];

  const albums = new Map<string, ReadonlyArray<string>>([
    ["al", [songC.id, songD.id]],
    ["al2", [songE.id]],
  ]);

  const connectCommands: ConnectCommands = {
    report: async (reported, applied) => {
      reports.push({ song: reported, applied });

      return clock.now;
    },
    albumTracks: async (albumId) => {
      if (gates.holdAlbums) await hold(albumId);

      return albums.get(albumId) ?? [];
    },
  };

  const connect = new ConnectPlayer(controller, connectCommands, {
    now: () => clock.now,
    every: () => () => {},
  });

  stops.push(connect.start());

  /** The native player of the song loaded now. */
  const playing = (): FakeOutput => {
    const output = outputs.findLast((opened) => !opened.released);

    if (output === undefined) throw new Error("No native player is open");

    return output;
  };

  const release = (key: string): void => {
    held.get(key)?.answer();
    held.delete(key);
  };

  const fail = (key: string): void => {
    held.get(key)?.fail();
    held.delete(key);
  };

  return {
    controller,
    connect,
    engine,
    events,
    outputs,
    playing,
    reports,
    sent,
    gates,
    answer,
    clock,
    release,
    fail,
  };
};

type Phone = ReturnType<typeof phone>;

const ask = (revision: number, asked: ConnectAsk) => ({ revision, ask: asked });

/** Plays A from the queue [A, B] on the phone, from a tap, and lets it start. */
const playingA = async (run: Phone): Promise<void> => {
  run.controller.sync(queueOf([one, two], "1"));
  await run.controller.togglePlay();
  await settle();
};

const lastReport = (run: Phone) => run.reports.at(-1);

describe("Connect on the phone", () => {
  it("reports the song it plays, then a pause from the lock screen at once", async () => {
    const run = phone();

    await playingA(run);

    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: true },
      applied: 0,
    });

    run.playing().pause();

    expect(lastReport(run)).toMatchObject({ song: { trackId: songA.id, playing: false } });
    expect(run.engine.samplePlayback().playing).toBe(false);
  });

  it("keeps a lock-screen pause made while a remote load fetches its album", async () => {
    const run = phone();

    await playingA(run);
    run.gates.holdAlbums = true;
    run.connect.take(
      ask(2, {
        kind: "load",
        item: album("al"),
        loadRevision: 2,
        playing: true,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();

    run.playing().pause();
    run.release("al");
    await settle();

    expect(run.sent.filter((call) => call.startsWith("play:"))).toStrictEqual([]);
    expect(run.engine.samplePlayback().playing).toBe(false);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: false },
      applied: 2,
    });
  });

  it("starts the album paused after a lock-screen pause made while its queue was written", async () => {
    const run = phone();

    await playingA(run);
    run.gates.holdPlay = true;
    run.connect.take(
      ask(2, {
        kind: "load",
        item: album("al"),
        loadRevision: 2,
        playing: true,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();

    expect(run.sent).toContain(`play:${songC.id},${songD.id}`);

    run.playing().pause();
    run.release("play");
    await settle();
    run.controller.sync(queueOf([entryOf(songC, "n1"), entryOf(songD, "n2")], "n1"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songC.id, playing: false });
    expect(run.engine.samplePlayback().playing).toBe(false);
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songC.id, playing: false },
      applied: 2,
    });
  });

  it("applies a lock-screen play made while a newer song's ticket is out to that song", async () => {
    const run = phone();

    await playingA(run);
    await run.controller.togglePlay();
    await settle();
    // Another device moves the queue on to B while this phone holds A paused.
    run.controller.sync(queueOf([one, two], "2"));
    run.playing().play();
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: true });
    expect(run.engine.samplePlayback().playing).toBe(true);
  });

  it("leaves the next song alone after a remote pause and then a skip here", async () => {
    const run = phone();

    await playingA(run);
    run.connect.take(
      ask(1, {
        kind: "transport",
        item: song(songA),
        playing: false,
        positionMs: 30_000,
        at: run.clock.now,
      }),
    );
    await settle();

    const first = run.playing();

    expect(first.wantsPlay).toBe(false);
    expect(run.events.some((event) => event.type === "system")).toBe(false);

    await run.controller.next();
    await settle();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();
    // The old song's player reports late, and the core shows a newer pause of the old song.
    first.notifyPlayingLate();
    run.connect.take(
      ask(3, {
        kind: "transport",
        item: song(songA),
        playing: true,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.playing().wantsPlay).toBe(false);
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songB.id, playing: false },
      applied: 3,
    });
  });

  it("waits for the queue to name its current entry before a move onto a phone that just opened", async () => {
    const run = phone();

    run.connect.take(
      ask(4, {
        kind: "load",
        item: song(songA),
        loadRevision: 4,
        playing: true,
        positionMs: 30_000,
        at: run.clock.now,
      }),
    );
    await settle();
    // The first answer holds a page without the current entry, while the rest still loads.
    run.controller.sync(queueOf([two], "1", { complete: false }));
    await settle();

    expect(run.outputs).toHaveLength(0);

    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(run.sent.filter((call) => call.startsWith("play:"))).toStrictEqual([]);
    expect(run.playing()).toMatchObject({ positionMs: 30_000, wantsPlay: true });
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: true, positionMs: 30_000 },
      applied: 4,
    });
  });

  it("lets an older load's failure and its old song's late failure leave a newer load alone", async () => {
    const run = phone();

    await playingA(run);
    const first = run.playing();

    run.gates.holdAlbums = true;
    run.connect.take(
      ask(2, {
        kind: "load",
        item: album("al"),
        loadRevision: 2,
        playing: true,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    run.connect.take(
      ask(3, {
        kind: "load",
        item: album("al2"),
        loadRevision: 3,
        playing: true,
        positionMs: 0,
        at: run.clock.now,
      }),
    );
    await settle();
    run.fail("al");
    run.answer.current = "e1";
    run.release("al2");
    await settle();
    run.controller.sync(queueOf([entryOf(songE, "e1")], "e1"));
    await settle();
    first.fail("The stream stopped");
    await settle();

    expect(run.sent.filter((call) => call.startsWith("play:"))).toStrictEqual([`play:${songE.id}`]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songE.id, playing: true });
    expect(run.controller.getSnapshot().error).toBeNull();
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songE.id, playing: true },
      applied: 3,
    });
  });
});
