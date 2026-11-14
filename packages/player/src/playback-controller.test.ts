import { createServer } from "node:http";

import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, EngineKind, EngineSource, PlayerEngine } from "./engine";
import { PlaybackController } from "./playback-controller";
import type {
  ControllerEnvironment,
  MusicCommands,
  QueueEntry,
  QueueState,
  ResumePoint,
} from "./playback-controller";
import { ticketSources } from "./source-resolver";
import type { PlayStart } from "./source-resolver";

const SIX_HOURS = 6 * 60 * 60 * 1000;

const BASE = "http://media.test";

const entry = (id: string, itemId: string, durationMs = 200_000): QueueEntry => ({
  itemId,
  autoplay: false,
  track: {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    artUrl: null,
    durationMs,
    codec: "AAC",
    lossless: false,
  },
});

const queueOf = (
  entries: ReadonlyArray<QueueEntry>,
  current: string | null,
  fields: Partial<QueueState> = {},
): QueueState => ({
  entries,
  current,
  shuffle: false,
  repeat: "off",
  autoplay: false,
  ...fields,
});

interface Load {
  readonly kind: EngineKind;
  readonly url: string;
  readonly startMs: number;
}

interface EngineRecord {
  readonly created: Array<EngineKind>;
  readonly loads: Array<Load>;
  readonly preloads: Array<EngineSource | null>;
  readonly seeks: Array<number>;
  /** Every stream the engine started, by a load or by moving on to its preload, in order. */
  readonly played: Array<string>;
  plays: number;
  /** Times the output was primed inside a tap. */
  unlocks: number;
  /** Loads still to come that the server refuses, as an expired ticket. */
  refuse: number;
}

type FakeEngine = PlayerEngine & {
  readonly emit: (event: EngineEvent) => void;
  /** Plays the current source to its end: moves on to the preload, as both engines do, or ends. */
  readonly finish: () => void;
};

/**
 * An engine that plays at once: it answers each call with the events a real one would send, and
 * keeps a preload across loads of other sources, as both real engines do.
 */
const instantEngine = (kind: EngineKind, record: EngineRecord): FakeEngine => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let paused = true;
  let positionMs = 0;
  let current: EngineSource | null = null;
  let queued: EngineSource | null = null;

  const emit = (event: EngineEvent): void => {
    if (event.type === "time") positionMs = event.positionMs;

    if (event.type === "playing") paused = false;
    else if (event.type === "paused" || event.type === "ended") paused = true;

    for (const listener of listeners) listener(event);
  };

  record.created.push(kind);

  return {
    emit,
    finish: () => {
      const next = queued;

      if (next === null) {
        emit({ type: "ended" });

        return;
      }

      current = next;
      queued = null;
      positionMs = 0;
      record.played.push(next.url);
      emit({ type: "advanced", key: next.key });
    },
    samplePlayback: () => ({ positionMs, playing: !paused }),
    load: async (source, startMs, autoplay) => {
      record.loads.push({ kind, url: source.url, startMs });
      record.played.push(source.url);
      current = source;

      if (queued?.url === source.url) queued = null;
      positionMs = startMs;

      if (record.refuse > 0) {
        record.refuse -= 1;
        emit({ type: "error", reason: "expired", message: "expired" });

        return;
      }

      emit({ type: autoplay ? "playing" : "paused" });
    },
    preload: (source) => {
      record.preloads.push(source);
      queued = source;
    },
    play: async () => {
      if (current === null) return;
      record.plays += 1;
      emit({ type: "playing" });
    },
    pause: () => {
      emit({ type: "paused" });
    },
    seek: (target) => {
      record.seeks.push(target);
      emit({ type: "time", positionMs: target });
    },
    setVolume: () => {},
    unlock: () => {
      record.unlocks += 1;
    },
    unload: () => {
      paused = true;
      positionMs = 0;
      current = null;
      queued = null;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

interface Sent {
  readonly name: "play" | "jump" | "report" | "start";
  readonly args: ReadonlyArray<unknown>;
}

interface HeldCall {
  readonly id: string;
  readonly release: () => void;
  readonly fail: (error: Error) => void;
}

/** Holds the calls through it while `holding` is set, until the test settles each one by id. */
class Gate {
  holding = false;
  readonly #held: Array<HeldCall> = [];

  /** Resolves at once, or once the test settles the call when the gate holds. */
  pass(id: string): Promise<void> {
    if (!this.holding) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.#held.push({ id, release: resolve, fail: reject });
    });
  }

  release(id: string): void {
    this.#take(id).release();
  }

  fail(id: string, message: string): void {
    this.#take(id).fail(new Error(message));
  }

  #take(id: string): HeldCall {
    const at = this.#held.findIndex((call) => call.id === id);
    const [call] = at === -1 ? [] : this.#held.splice(at, 1);

    if (call === undefined) throw new Error(`No call for ${id} is held`);

    return call;
  }
}

/** Waits a macrotask turn, so every awaited call inside the controller settles first. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const setup = (
  options: {
    readonly gapless?: boolean;
    readonly mse?: boolean;
    readonly ticketMs?: number;
    readonly resume?: ResumePoint | null;
    readonly playCurrent?: string;
    readonly baseUrl?: string;
  } = {},
) => {
  const record: EngineRecord = {
    created: [],
    loads: [],
    preloads: [],
    seeks: [],
    played: [],
    plays: 0,
    unlocks: 0,
    refuse: 0,
  };

  /** Hold `music.play.start`, `music.queue.jump` and `music.play.report`, keyed by their id. */
  const gates = { start: new Gate(), jump: new Gate(), report: new Gate() };

  const engines: Array<FakeEngine> = [];
  const sent: Array<Sent> = [];
  const clock = { now: 1_000_000, monotonic: 0 };
  const saved: Array<ResumePoint | null> = [];
  let starts = 0;

  const start = async (trackId: string): Promise<PlayStart> => {
    starts += 1;
    const number = starts;
    sent.push({ name: "start", args: [trackId] });
    await gates.start.pass(trackId);

    return {
      playbackId: `p${number}`,
      startedAt: 5,
      ticket: `t${number}`,
      expiresAt: 5 + (options.ticketMs ?? SIX_HOURS),
    };
  };

  const commands: MusicCommands = {
    play: async (trackIds, index) => {
      sent.push({ name: "play", args: [trackIds, index] });

      return { current: options.playCurrent ?? "new" };
    },
    jump: async (itemId) => {
      sent.push({ name: "jump", args: [itemId] });
      await gates.jump.pass(itemId);
    },
    report: async (trackId, playbackId) => {
      sent.push({ name: "report", args: [trackId, playbackId] });
      await gates.report.pass(trackId);
    },
  };

  const env: ControllerEnvironment = {
    canPlay: () => true,
    now: () => clock.now,
    monotonicNow: () => clock.monotonic,
    settings: { quality: "lossless", volume: 1, gapless: options.gapless ?? true },
    saveQuality: () => {},
    saveVolume: () => {},
    nowPlaying: { setHandlers: () => {}, show: () => {} },
    resume: {
      load: () => options.resume ?? null,
      save: (point) => {
        saved.push(point);
      },
    },
  };

  const controller = new PlaybackController(
    commands,
    ticketSources(start, { now: () => clock.now, baseUrl: options.baseUrl ?? BASE }),
    {
      mse: options.mse === true ? { flac: true, changeType: true } : null,
      create: (kind) => {
        const engine = instantEngine(kind, record);

        engines.push(engine);

        return engine;
      },
    },
    env,
  );

  const stop = controller.start();
  const engine = (): FakeEngine => engines.at(-1) ?? instantEngine("html", record);

  return { controller, record, sent, clock, saved, stop, engine, gates };
};

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/** A media server whose health check answers while `healthy` is set, and fails while it is not. */
const mediaServer = async () => {
  const state = { healthy: true };

  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/health" && state.healthy ? 200 : 503).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = ListeningAddress(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      server.close();
    },
  };
};

const names = (sent: ReadonlyArray<Sent>): ReadonlyArray<string> =>
  sent.map((call) => `${call.name}:${call.args.join(",")}`);

const one = entry("a", "1");

const two = entry("b", "2");

const three = entry("c", "3");

/**
 * Plays A until the media server stops answering, runs `during` through the outage, and waits
 * until playback starts again once the server is back.
 */
const outage = async (during: (run: ReturnType<typeof setup>) => Promise<void>) => {
  const media = await mediaServer();
  const run = setup({ playCurrent: "1", baseUrl: media.baseUrl });

  try {
    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();
    run.engine().emit({ type: "time", positionMs: 60_000 });
    media.state.healthy = false;
    run.engine().emit({ type: "error", reason: "network", message: "network" });

    await vi.waitFor(() => {
      expect(run.controller.getSnapshot().mediaOnline).toBe(false);
    });

    await during(run);
    media.state.healthy = true;

    await vi.waitFor(
      () => {
        expect(run.controller.getSnapshot().engineStatus).toBe("playing");
      },
      { timeout: 5000 },
    );

    return run;
  } finally {
    run.stop();
    media.close();
  }
};

describe("PlaybackController", () => {
  it("plays a new queue with a ticket for its song, and records the play once", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot().engineStatus).toBe("playing");
    expect(names(sent)).toStrictEqual(["play:a,b,0", "start:a", "report:a,p1"]);
  });

  it("moves to the next entry at once and keeps it while the core confirms", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(names(sent)).toContain("jump:2");

    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);

    controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);
  });

  it("follows a move made elsewhere: loads it while playing, shows it while paused", async () => {
    const playing = setup({ playCurrent: "1" });

    await playing.controller.playTracks(["a", "b"], 0);
    playing.controller.sync(queueOf([one, two], "1"));
    await settle();
    playing.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(playing.record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(playing.controller.getSnapshot().engineStatus).toBe("playing");

    const paused = setup();

    paused.controller.sync(queueOf([one, two], "1"));
    paused.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(paused.controller.getSnapshot().current).toBe("2");
    expect(paused.record.loads).toHaveLength(0);
  });

  it("starts the paused song where this browser left it", async () => {
    const { controller, record } = setup({ resume: { itemId: "1", positionMs: 42_000 } });

    controller.sync(queueOf([one, two], "1"));

    expect(controller.positionMs()).toBe(42_000);

    await controller.togglePlay();
    await settle();

    expect(record.loads.at(-1)?.startMs).toBe(42_000);
  });

  it("goes back within the first seconds and starts the song again after", async () => {
    const { controller, record, clock, engine } = setup({ playCurrent: "2" });

    await controller.playTracks(["a", "b"], 1);
    controller.sync(queueOf([one, two], "2"));
    await settle();

    engine().emit({ type: "time", positionMs: 10_000 });
    clock.monotonic += 1;
    await controller.previous();

    expect(record.seeks.at(-1)).toBe(0);
    expect(controller.getSnapshot().current).toBe("2");

    engine().emit({ type: "time", positionMs: 1000 });
    await controller.previous();
    await settle();

    expect(controller.getSnapshot().current).toBe("1");
  });

  it("plays the song again with a new start when repeat is one", async () => {
    const { controller, sent, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1", { repeat: "one" }));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(names(sent).filter((call) => call.startsWith("report"))).toStrictEqual([
      "report:a,p1",
      "report:a,p2",
    ]);
  });

  it("stops at the start of the last song when the queue runs out", async () => {
    const { controller, engine, saved } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(controller.getSnapshot().engineStatus).toBe("paused");
    expect(controller.positionMs()).toBe(0);
    expect(saved.at(-1)).toBeNull();
  });

  it("asks for a fresh ticket once after a refusal, then shows the error", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    record.refuse = 2;
    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: "The media server refused this song's stream",
    });
  });

  it("renews a ticket before it expires when playback resumes", async () => {
    const { controller, record, clock } = setup({ playCurrent: "1", ticketMs: 60_000 });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    await controller.togglePlay();
    clock.now += 31_000;
    await controller.togglePlay();
    await settle();

    expect(record.loads.map((load) => load.url.match(/ticket=(\w+)/u)?.[1])).toStrictEqual([
      "t1",
      "t2",
    ]);
  });

  it("plays through the gapless engine, and through HTML audio with gapless off", () => {
    expect(setup({ mse: true }).record.created).toStrictEqual(["mse"]);
    expect(setup({ mse: true, gapless: false }).record.created).toStrictEqual(["html"]);
  });

  it("loads the following song ahead and moves the core along when the engine advances", async () => {
    const { controller, record, sent, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();

    expect(record.preloads.at(-1)?.url).toContain("/stream/b?");

    engine().emit({ type: "advanced", key: record.preloads.at(-1)?.key ?? "" });
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(names(sent).slice(-2)).toStrictEqual(["report:b,p2", "jump:2"]);
  });

  it("empties the player with the queue", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    controller.sync(queueOf([], null));

    expect(controller.getSnapshot()).toMatchObject({ current: null, engineStatus: "idle" });
    expect(record.loads).toHaveLength(1);
  });

  it("asks for a new ticket when Play is pressed after the first one failed", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    gates.start.holding = true;
    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    gates.start.fail("a", "The server is busy");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: "The server is busy",
    });

    gates.start.holding = false;
    await controller.togglePlay();
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({ engineStatus: "playing", error: null });
  });

  it("keeps the song skipped to playing when the skipped song's ticket fails later", async () => {
    const { controller, gates } = setup({ playCurrent: "1" });

    gates.start.holding = true;
    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    gates.start.release("b");
    await settle();
    gates.start.fail("a", "Song a is gone");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "playing",
      error: null,
    });
  });

  it("stops the song before when the next song's ticket fails", async () => {
    const { controller, gates, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.start.holding = true;
    await controller.next();
    gates.start.fail("b", "Song b is gone");
    await settle();

    expect(engine().samplePlayback().playing).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "error",
      error: "Song b is gone",
    });
  });

  it("primes idle output at once for a play that starts after an await, never playing output", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    controller.primeOutput();

    expect(record.unlocks).toBe(1);

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    const unlocks = record.unlocks;

    controller.primeOutput();

    expect(record.unlocks).toBe(unlocks);
  });

  it("ignores the outgoing song's engine events while the next song's ticket is out", async () => {
    const { controller, record, sent, gates, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    await controller.jump("2");
    controller.sync(queueOf([one, two, three], "2"));

    // Song a keeps sounding until b's ticket answers: its position, its error, and its end all
    // belong to a, not to b, which has not started.
    engine().emit({ type: "time", positionMs: 150_000 });
    engine().emit({ type: "error", reason: "decode", message: "a failed" });
    engine().finish();
    await settle();

    expect(controller.positionMs()).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "loading",
      error: null,
    });
    expect(names(sent).filter((name) => name.startsWith("jump"))).toStrictEqual(["jump:2"]);

    gates.start.release("b");
    await settle();

    expect(record.played.at(-1)).toContain("/stream/b?ticket=t2");
    expect(controller.getSnapshot()).toMatchObject({ current: "2", engineStatus: "playing" });
  });

  it("keeps the next song's preload through a reload of the playing song", async () => {
    const { controller, record, clock, engine } = setup({ playCurrent: "1", ticketMs: 60_000 });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();
    const preloaded = record.preloads.at(-1)?.url;

    clock.now += 31_000;
    controller.seek(195_000);
    await settle();

    expect(record.loads.at(-1)?.url).toContain("/stream/a?ticket=t3");

    engine().finish();
    await settle();

    expect(preloaded).toContain("/stream/b?ticket=t2");
    expect(record.played.at(-1)).toBe(preloaded);
    expect(controller.getSnapshot().current).toBe("2");
  });

  it("drops a preload that answers after repeat one is turned on", async () => {
    const { controller, record, gates, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    engine().emit({ type: "time", positionMs: 190_000 });
    controller.sync(queueOf([one, two, three], "1", { repeat: "one" }));
    gates.start.release("b");
    await settle();
    gates.start.holding = false;
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/a?");
    expect(controller.getSnapshot().current).toBe("1");
  });

  it("drops a preload that answers after the queue was reordered, and loads the new next", async () => {
    const { controller, record, gates, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    engine().emit({ type: "time", positionMs: 190_000 });
    controller.sync(queueOf([one, three, two], "1"));
    gates.start.release("b");
    await settle();
    gates.start.holding = false;
    engine().emit({ type: "time", positionMs: 191_000 });
    await settle();
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/c?");
    expect(controller.getSnapshot().current).toBe("3");
  });

  it("drops the preload when the listener jumps to the last song, so it ends there", async () => {
    const { controller, record, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();

    expect(record.preloads.at(-1)?.url).toContain("/stream/b?");

    await controller.jump("3");
    await settle();
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/c?");
    expect(controller.getSnapshot()).toMatchObject({ current: "3", engineStatus: "paused" });
  });

  it("keeps a later move when an earlier one fails to reach the core", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.jump.holding = true;
    const first = controller.jump("2");
    const second = controller.jump("3");
    await settle();
    gates.jump.fail("2", "Can't reach the server");
    await first;
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      current: "3",
      engineStatus: "playing",
      error: null,
    });
    expect(record.played.at(-1)).toContain("/stream/c?");

    gates.jump.release("3");
    await second;
  });

  it("shows a move's failure after the core's entry stood again", async () => {
    const { controller, clock, gates } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.jump.holding = true;
    const move = controller.jump("2");
    await settle();
    clock.now += 11_000;
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.jump.fail("2", "Can't reach the server");
    await move;

    expect(controller.getSnapshot()).toMatchObject({
      current: "1",
      error: "Can't reach the server",
    });
  });

  it("drops a history report's failure once another song plays", async () => {
    const { controller, gates } = setup({ playCurrent: "1" });

    gates.report.holding = true;
    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    await settle();
    gates.report.fail("a", "History is unavailable");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({ current: "2", error: null });
  });

  describe("when the media server goes away", () => {
    it("plays the song picked during the outage once it is back", async () => {
      const { controller, record } = await outage(async ({ controller: during }) => {
        await during.jump("2");
      });

      expect(record.loads.at(-1)).toMatchObject({ startMs: 0 });
      expect(record.loads.at(-1)?.url).toContain("/stream/b?");
      expect(controller.getSnapshot().current).toBe("2");
    });

    it("picks the song that stopped up where it stopped, through queue updates meanwhile", async () => {
      const { controller, record } = await outage(async ({ controller: during }) => {
        during.sync(queueOf([one, two], "1"));
        await settle();
      });

      expect(record.loads.at(-1)).toMatchObject({ startMs: 60_000 });
      expect(record.loads.at(-1)?.url).toContain("/stream/a?");
      expect(controller.getSnapshot().current).toBe("1");
    });
  });
});
