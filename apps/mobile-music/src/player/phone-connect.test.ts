import { ConnectPlayer } from "@media/player/connect-player";
import type { ConnectAsk, ConnectCommands, ReportedSong } from "@media/player/connect-player";
import type { EngineEvent } from "@media/player/engine";
import { PlaybackController } from "@media/player/playback-controller";
import type { MusicCommands, QueueEntry, QueueState } from "@media/player/playback-controller";
import type { SourceResolver } from "@media/player/source-resolver";
import { Result } from "effect";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { FakeOutput } from "./fake-output";
import { NativeEngine } from "./native-engine";
import { lockScreenControls } from "./native-host";
import type { RemoteCommandEvents, RemoteCommands } from "./native-host";

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

const settle = async (turns = 8): Promise<void> => {
  if (turns === 0) return;

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await settle(turns - 1);
};

interface Held {
  readonly answer: () => void;
  readonly fail: () => void;
}

type Listeners = { readonly [Event in keyof RemoteCommandEvents]: Set<RemoteCommandEvents[Event]> };

class FakeRemoteCommands implements RemoteCommands {
  readonly #listeners: Listeners = {
    play: new Set(),
    pause: new Set(),
    unplugged: new Set(),
    nextTrack: new Set(),
    previousTrack: new Set(),
    seekTo: new Set(),
  };

  addListener = <Event extends keyof RemoteCommandEvents>(
    event: Event,
    listener: RemoteCommandEvents[Event],
  ) => {
    const listeners: Set<RemoteCommandEvents[Event]> = this.#listeners[event];

    listeners.add(listener);

    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  };

  /** Sends the play or pause the module decided for a press on `player`. */
  press(decided: "play" | "pause", player: FakeOutput | null): void {
    const press = { player: player?.id ?? null };

    for (const listener of this.#listeners[decided]) listener(press);
  }

  /** Sends headphones unplugged. */
  unplug(): void {
    for (const listener of this.#listeners.unplugged) listener();
  }
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const phone = () => {
  const outputs: Array<FakeOutput> = [];
  const events: Array<EngineEvent> = [];

  const engine = new NativeEngine((url) => {
    const output = new FakeOutput(url, `player-${outputs.length + 1}`);

    outputs.push(output);
    setTimeout(() => {
      output.ready(false, 240_000);
    }, 0);

    return output;
  });

  const remote = new FakeRemoteCommands();

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
      nowPlaying: lockScreenControls(engine, remote),
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

  const playing = (): FakeOutput => {
    const output = outputs.findLast((opened) => !opened.released);

    if (output === undefined) throw new Error("No native player is open");

    return output;
  };

  const outputOf = (track: Track): FakeOutput => {
    const output = outputs.findLast((opened) => opened.url.endsWith(track.id) && !opened.released);

    if (output === undefined) throw new Error(`No native player plays ${track.title}`);

    return output;
  };

  const shown = (): FakeOutput => {
    const output = outputs.find((opened) => !opened.released && opened.lockScreen?.info != null);

    if (output === undefined) throw new Error("No native player is on the lock screen");

    return output;
  };

  const lockScreen = {
    pause: (): void => {
      const output = shown();

      output.pause();
      remote.press("pause", output);
    },
    play: (): void => {
      const output = shown();

      output.play();
      remote.press("play", output);
    },
    toggle: (): void => {
      const output = shown();

      if (output.wantsPlay) output.pause();
      else output.play();
      remote.press(output.wantsPlay ? "play" : "pause", output);
    },
    // expo-audio pauses every player that plays when an output goes away.
    unplug: (): void => {
      for (const output of outputs) {
        if (!output.released && output.wantsPlay && output.loaded) output.pause();
      }

      remote.unplug();
    },
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
    outputOf,
    lockScreen,
    remote,
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

const playingA = async (run: Phone): Promise<void> => {
  run.controller.sync(queueOf([one, two], "1"));
  await run.controller.togglePlay();
  await settle();
};

const lastReport = (run: Phone) => run.reports.at(-1);

/** Plays A, the first of [A, B], to half a second before its end, with B preloaded. */
const nearTheEnd = async (run: Phone): Promise<void> => {
  await playingA(run);
  run.outputOf(songA).advance(239_500);
  await settle();
};

const holdAlbumLoad = async (run: Phone): Promise<void> => {
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
};

const plays = (run: Phone) => run.sent.filter((call) => call.startsWith("play:"));

/** Waits through microtasks alone until the engine opened a native player. */
const opened = async (run: Phone, turns = 50): Promise<void> => {
  if (run.outputs.length > 0 || turns === 0) return;
  await Promise.resolve();
  await opened(run, turns - 1);
};

describe("Connect on the phone", () => {
  it("reports the song it plays, then a pause from the lock screen at once", async () => {
    const run = phone();

    await playingA(run);

    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: true },
      applied: 0,
    });

    run.lockScreen.pause();

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

    run.lockScreen.pause();
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

    run.lockScreen.pause();
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
    run.controller.sync(queueOf([one, two], "2"));
    run.lockScreen.play();
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

    await run.controller.next();
    await settle();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();
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

describe("The system's controls on the phone", () => {
  it("keeps a lock-screen pause in the song's last second while a remote load fetches its album", async () => {
    const run = phone();

    await nearTheEnd(run);
    await holdAlbumLoad(run);

    run.lockScreen.pause();
    await settle();

    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: false },
      applied: 2,
    });

    run.release("al");
    await settle();

    expect(plays(run)).toStrictEqual([]);
    expect(run.engine.samplePlayback().playing).toBe(false);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
  });

  it("keeps that pause when the command arrives before the player's report of it", async () => {
    const run = phone();

    await nearTheEnd(run);
    await holdAlbumLoad(run);
    const first = run.outputOf(songA);

    first.wantsPlay = false;
    run.remote.press("pause", first);
    first.pause();
    run.release("al");
    await settle();

    expect(plays(run)).toStrictEqual([]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: false },
      applied: 2,
    });
  });

  it("loads the next song paused after a lock-screen pause in the song's last second", async () => {
    const run = phone();

    await nearTheEnd(run);

    run.lockScreen.pause();
    await run.controller.next();
    await settle();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.outputOf(songB).wantsPlay).toBe(false);
    expect(lastReport(run)).toMatchObject({ song: { trackId: songB.id, playing: false } });
  });

  it("lets a remote load start when the song plays to its end, which is no one's action", async () => {
    const run = phone();

    await nearTheEnd(run);
    await holdAlbumLoad(run);
    const first = run.outputOf(songA);

    // AVPlayer stops at the end and can report its pause before the status that says it finished.
    first.positionMs = 240_000;
    first.pause();
    first.finish();
    await settle();
    run.release("al");
    await settle();
    run.controller.sync(queueOf([entryOf(songC, "n1"), entryOf(songD, "n2")], "n1"));
    await settle();

    expect(plays(run)).toStrictEqual([`play:${songC.id},${songD.id}`]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songC.id, playing: true });
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songC.id, playing: true },
      applied: 2,
    });
  });

  it("takes a headphone toggle for what the player did with it, a pause and then a play", async () => {
    const run = phone();

    await playingA(run);
    await holdAlbumLoad(run);

    run.lockScreen.toggle();
    run.release("al");
    await settle();

    expect(plays(run)).toStrictEqual([]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(lastReport(run)).toMatchObject({ applied: 2 });

    run.lockScreen.toggle();
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: true });
    expect(run.outputOf(songA).wantsPlay).toBe(true);
  });

  it("takes a toggle the module decided as a pause before the player's report of it arrived", async () => {
    const run = phone();

    await playingA(run);
    const first = run.outputOf(songA);

    first.wantsPlay = false;
    run.remote.press("pause", first);
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(lastReport(run)).toMatchObject({ song: { trackId: songA.id, playing: false } });
  });

  it("drops a remote load on a lock-screen play the player already applied", async () => {
    const run = phone();

    await playingA(run);
    await run.controller.togglePlay();
    await settle();
    await holdAlbumLoad(run);

    run.lockScreen.play();
    run.release("al");
    await settle();

    expect(plays(run)).toStrictEqual([]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: true });
    expect(lastReport(run)).toMatchObject({
      song: { trackId: songA.id, playing: true },
      applied: 2,
    });
  });

  it("keeps the pause when headphones are unplugged, so a song moved on elsewhere loads paused", async () => {
    const run = phone();

    await playingA(run);

    run.lockScreen.unplug();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.outputOf(songB).wantsPlay).toBe(false);
  });

  it("pauses a song meant to play when headphones are unplugged before its sound starts", async () => {
    const run = phone();

    run.controller.sync(queueOf([one, two], "1"));
    const started = run.controller.togglePlay();

    // Microtasks only: the native player opens, and its stream is still loading.
    await opened(run);

    expect(run.outputOf(songA)).toMatchObject({ wantsPlay: true, loaded: false });

    run.lockScreen.unplug();
    await started;
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(run.outputOf(songA).wantsPlay).toBe(false);
  });

  it("leaves a remote load to start when headphones are unplugged while nothing plays", async () => {
    const run = phone();

    await playingA(run);
    await run.controller.togglePlay();
    await settle();
    await holdAlbumLoad(run);

    run.lockScreen.unplug();
    run.release("al");
    await settle();
    run.controller.sync(queueOf([entryOf(songC, "n1"), entryOf(songD, "n2")], "n1"));
    await settle();

    expect(plays(run)).toStrictEqual([`play:${songC.id},${songD.id}`]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songC.id, playing: true });
    expect(lastReport(run)).toMatchObject({ applied: 2 });
  });
});

describe("The system's commands on the phone carry their own outcome", () => {
  it("hands over to the next song without a gap after a lock-screen play resumed a song paused here", async () => {
    const run = phone();

    await nearTheEnd(run);
    await run.controller.togglePlay();
    await settle();
    run.lockScreen.play();
    await settle();
    const preloaded = run.outputOf(songB);
    const players = run.outputs.length;

    run.outputOf(songA).finish();
    await settle();

    expect(run.events.some((event) => event.type === "advanced")).toBe(true);
    expect(preloaded.released).toBe(false);
    expect(run.outputs).toHaveLength(players);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: true });
  });

  it("pauses on an unplug after a lock-screen play resumed a song paused here, so a song moved on elsewhere loads paused", async () => {
    const run = phone();

    await playingA(run);
    await run.controller.togglePlay();
    await settle();
    run.lockScreen.play();
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: true });

    run.lockScreen.unplug();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.outputOf(songB).wantsPlay).toBe(false);
  });

  it("keeps a headphone toggle's pause that reaches the app after the song's end moved the player on", async () => {
    const run = phone();

    await nearTheEnd(run);
    const first = run.outputOf(songA);

    first.pause();
    first.finish();
    run.remote.press("pause", first);
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.engine.samplePlayback().playing).toBe(false);
    expect(run.outputOf(songB).wantsPlay).toBe(false);
  });

  it("keeps a pause that reaches the app just after the song's end", async () => {
    const run = phone();

    await nearTheEnd(run);
    const first = run.outputOf(songA);

    first.finish();
    run.remote.press("pause", first);
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.engine.samplePlayback().playing).toBe(false);
  });

  it("keeps a pause sent twice, and takes a call's pause as the player's state only", async () => {
    const run = phone();

    await playingA(run);
    await holdAlbumLoad(run);
    const first = run.outputOf(songA);

    first.pause();

    expect(lastReport(run)).toMatchObject({ applied: 0 });

    first.play();
    run.lockScreen.pause();
    run.remote.press("pause", first);
    run.release("al");
    await settle();

    expect(plays(run)).toStrictEqual([]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: false });
    expect(run.engine.samplePlayback().playing).toBe(false);
  });

  it("leaves a remote load to start on an unplug after a lock-screen pause of a new queue's first song, before its queue arrived", async () => {
    const run = phone();

    await run.controller.playTracks([songA.id, songB.id]);
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songA.id, playing: true });

    run.lockScreen.pause();
    await settle();
    await holdAlbumLoad(run);
    run.lockScreen.unplug();
    run.answer.current = "c1";
    run.release("al");
    await settle();
    run.controller.sync(queueOf([entryOf(songC, "c1"), entryOf(songD, "c2")], "c1"));
    await settle();

    expect(plays(run)).toStrictEqual([
      `play:${songA.id},${songB.id}`,
      `play:${songC.id},${songD.id}`,
    ]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: songC.id, playing: true });
  });

  it("drops a lock-screen play decided for a song the player has since moved on from", async () => {
    const run = phone();

    await playingA(run);
    await run.controller.togglePlay();
    await settle();
    const first = run.outputOf(songA);

    first.play();
    run.controller.sync(queueOf([one, two], "2"));
    await settle();
    run.remote.press("play", first);
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: songB.id, playing: false });
    expect(run.outputOf(songB).wantsPlay).toBe(false);
  });
});

type Arrival = "status" | "finish" | "press" | "advance";

interface Step {
  readonly arrival: Arrival;
  readonly settles: boolean;
}

const stepsOf = (
  order: ReadonlyArray<Arrival>,
  settles: ReadonlyArray<boolean>,
): ReadonlyArray<Step> =>
  order.map((arrival, index) => ({ arrival, settles: settles[index] === true }));

/** A toggle that pauses a song as it ends: its four parts reach the app in any order. */
const pauseRacingTheEnd = fc.record({
  decided: fc.constant("pause" as const),
  steps: fc
    .tuple(
      fc.shuffledSubarray<Arrival>(["status", "finish", "press", "advance"], {
        minLength: 4,
        maxLength: 4,
      }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    )
    .map(([order, settles]) => stepsOf(order, settles)),
});

/**
 * A toggle that plays a song paused half a second before its end: its status and the module's play
 * reach the app in either order, both before the song can play to its end.
 */
const playBeforeTheEnd = fc.record({
  decided: fc.constant("play" as const),
  steps: fc
    .tuple(
      fc.shuffledSubarray<Arrival>(["status", "press"], { minLength: 2, maxLength: 2 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    )
    .map(([first, settles]) => stepsOf(first.concat("finish", "advance"), settles)),
});

const deliver = async (
  run: Phone,
  decided: "play" | "pause",
  steps: ReadonlyArray<Step>,
): Promise<void> => {
  const [step, ...rest] = steps;

  if (step === undefined) return;
  const first = run.outputs.find((output) => output.url.endsWith(songA.id));

  if (first === undefined) throw new Error("Song A never opened");

  if (step.arrival === "status" && decided === "pause") first.pause();

  if (step.arrival === "status" && decided === "play") first.play();

  if (step.arrival === "finish") first.finish();

  if (step.arrival === "press") run.remote.press(decided, first);

  if (step.arrival === "advance") run.controller.sync(queueOf([one, two], "2"));

  if (step.settles) await settle();
  await deliver(run, decided, rest);
};

describe("A toggle racing a song's end on the phone", () => {
  it("ends as the toggle decided, whatever order its parts, the song's end, and the next song reach the app in", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(pauseRacingTheEnd, playBeforeTheEnd),
        async ({ decided, steps }) => {
          const run = phone();

          await nearTheEnd(run);

          if (decided === "play") {
            await run.controller.togglePlay();
            await settle();
          }

          const preloaded = run.outputOf(songB);
          const players = run.outputs.length;

          await deliver(run, decided, steps);
          await settle();

          if (decided === "pause") {
            expect(run.controller.playingHere()?.playing).toBe(false);
            expect(run.engine.samplePlayback().playing).toBe(false);
            expect(run.engine.meansToPlay()).toBe(false);
            expect(run.outputs.filter((output) => !output.released && output.wantsPlay)).toEqual(
              [],
            );
          } else {
            expect(run.events.some((event) => event.type === "advanced")).toBe(true);
            expect(preloaded.released).toBe(false);
            expect(run.outputs).toHaveLength(players);
            expect(run.controller.playingHere()).toMatchObject({
              trackId: songB.id,
              playing: true,
            });
            expect(run.engine.meansToPlay()).toBe(true);
          }

          for (const stop of stops.splice(0)) stop();
        },
      ),
      { numRuns: 120 },
    );
  }, 60_000);
});
